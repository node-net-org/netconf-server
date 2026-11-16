/**
 * Read hooks (design §5, §8; PROVIDER-02, -03, -10; READ-01 AC5, READ-02
 * AC3). Before a `<get>` or a `<get-data>` of operational, the server runs
 * the read hook of every provider whose subtree the filter selects, all at
 * once, and builds the reply when they have finished. Reads that arrive
 * while a provider's hook is running share that run; `maxAge` answers from
 * the last data for a while after a successful run.
 *
 * Which providers a filter selects is worked out from the schema, since the
 * data isn't there until the hooks have run: a provider is selected when
 * its path and a path the filter selects are one inside the other. Content
 * matches only narrow which entries are returned, so they don't narrow the
 * hooks. An XPath expression that isn't a plain absolute path selects every
 * provider.
 */

import type { Logger, XmlElement, XmlNode } from '@node-net/netconf/core';
import { parseXPath, YangDataError, type Schema, type SchemaNode, type XPathExpr } from '@node-net/yang/core';
import type { Clock } from '../clock.js';
import type { OperationalState, StateChangedEvent } from '../datastore/operational.js';
import { issueErrors } from '../rpc/data-errors.js';
import { operationFailed, RpcFailure, type RpcErrorSpec } from '../rpc/errors.js';
import type { Registration, Registry } from './provider.js';
import { HookTimeout, withTimeout } from './timeout.js';

/** What a read selects, as reads.ts reads it from the request. */
export type ReadSelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'subtree'; readonly content: readonly XmlNode[] }
  | { readonly kind: 'xpath'; readonly select: string; readonly scope: ReadonlyMap<string, string> };

export interface ReadHooksOptions {
  readonly registry: Registry;
  readonly state: OperationalState;
  readonly schema: Schema;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly stateChanged: (event: StateChangedEvent) => void;
}

export class ReadHooks {
  readonly #moduleByNamespace = new Map<string, string>();

  constructor(private readonly o: ReadHooksOptions) {
    for (const m of o.schema.allModules) if (!this.#moduleByNamespace.has(m.namespace)) this.#moduleByNamespace.set(m.namespace, m.name);
  }

  /**
   * Runs the read hooks a read selects. Resolves with warnings to add to
   * the reply (a hook that timed out under `stale`); rejects with an
   * RpcFailure when a hook failed. `denied` names subtrees the reader may
   * not read at all (NACM design §7.1): their providers aren't asked.
   */
  async refresh(selection: ReadSelection, who: { sessionId?: number; username?: string }, denied?: (node: SchemaNode) => boolean): Promise<RpcErrorSpec[]> {
    const hooked = this.o.registry.all.filter((r) => r.provider.onRead !== undefined && denied?.(r.node) !== true);
    if (hooked.length === 0) return [];
    const nodes = this.#selected(selection);
    const chosen = nodes === 'all' ? hooked : hooked.filter((r) => nodes.some((n) => related(n, r.node)));
    const results = await Promise.allSettled(chosen.map((r) => this.#run(r, who)));
    const warnings: RpcErrorSpec[] = [];
    const errors: RpcErrorSpec[] = [];
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') return;
      const r = chosen[i]!;
      const err = res.reason as Error;
      if (err instanceof HookTimeout) {
        if ((r.provider.onReadTimeout ?? 'stale') === 'stale') {
          warnings.push({ ...operationFailed(`The read hook of the provider at ${r.path} did not finish within ${err.ms} ms; its data may be stale`), severity: 'warning' });
        } else errors.push(operationFailed(`The read hook of the provider at ${r.path} did not finish within ${err.ms} ms`));
      } else if (err instanceof YangDataError) errors.push(...issueErrors(err.issues, this.o.schema));
      else if (err instanceof RpcFailure) errors.push(...err.errors);
      else errors.push(operationFailed(`The read hook of the provider at ${r.path} failed: ${err.message}`));
    });
    if (errors.length > 0) throw new RpcFailure(errors);
    return warnings;
  }

  /** One provider's hook: shared with reads already waiting on it, skipped within maxAge. */
  #run(r: Registration, who: { sessionId?: number; username?: string }): Promise<void> {
    const now = this.o.clock.now();
    if (r.provider.maxAge !== undefined && r.lastRead !== undefined && now - r.lastRead < r.provider.maxAge) return Promise.resolve();
    if (r.reading !== undefined) return r.reading;
    const run = withTimeout(this.o.clock, r.timeouts.read, `The read hook of the provider at ${r.path}`, (signal) => r.provider.onRead!({ ...who, signal })).then((content) => {
      if (content !== undefined && content !== null) {
        const paths = this.o.state.replace(r, content);
        if (paths.length > 0) this.o.stateChanged({ paths });
      }
      r.lastRead = this.o.clock.now();
    });
    const shared = run.finally(() => {
      if (r.reading === shared) r.reading = undefined;
    });
    r.reading = shared;
    return shared;
  }

  /** The schema nodes a selection names, or 'all'. */
  #selected(selection: ReadSelection): SchemaNode[] | 'all' {
    if (selection.kind === 'all') return 'all';
    if (selection.kind === 'subtree') {
      const out: SchemaNode[] = [];
      this.#subtree(selection.content, '', undefined, out);
      return out;
    }
    let expr: XPathExpr;
    try {
      expr = parseXPath(selection.select);
    } catch {
      return 'all';
    }
    const out: SchemaNode[] = [];
    return this.#xpath(expr, selection.scope, out) ? out : 'all';
  }

  /** The nodes a subtree filter selects: selection and containment nodes, as paths in the schema. */
  #subtree(content: readonly XmlNode[], parentPath: string, parent: SchemaNode | undefined, out: SchemaNode[]): void {
    for (const el of content) {
      if (typeof el === 'string') continue;
      const element = el;
      const module = this.#moduleByNamespace.get(element.ns ?? '');
      // An element with no namespace stands for any module's node of that name (RFC 6241 §6.2.1); keep it simple and select broadly.
      const candidates = module === undefined ? this.#named(parent, element.name) : [this.o.schema.find(`${parentPath}/${module}:${element.name}`)].filter((n) => n !== undefined);
      for (const node of candidates) {
        const children = element.elements.filter((c) => !isContentMatch(c));
        if (children.length === 0) out.push(node);
        else this.#subtree(children, `${pathOf(node)}`, node, out);
      }
    }
  }

  /** Data nodes named `name` under `parent` (top level when undefined), in any module. */
  #named(parent: SchemaNode | undefined, name: string): SchemaNode[] {
    const candidates = parent === undefined ? this.o.schema.dataNodes : parent.children;
    return candidates.filter((n) => n.name === name);
  }

  /** Collects absolute plain paths; false when the expression is anything else. */
  #xpath(expr: XPathExpr, scope: ReadonlyMap<string, string>, out: SchemaNode[]): boolean {
    if (expr.type === 'binary' && expr.op === '|') return this.#xpath(expr.left, scope, out) && this.#xpath(expr.right, scope, out);
    if (expr.type !== 'path' || expr.start !== 'root') return false;
    let path = '';
    for (const step of expr.steps) {
      if (step.axis !== 'child' || step.test.kind !== 'name') return false;
      const module = step.test.prefix === undefined ? undefined : this.#moduleByNamespace.get(scope.get(step.test.prefix) ?? '');
      if (module === undefined) return false;
      path += `/${module}:${step.test.name}`;
    }
    if (path === '') return false;
    const node = this.o.schema.find(path);
    if (node !== undefined) out.push(node);
    return true;
  }
}

/** A content match node: a leaf element with text and no child elements. */
function isContentMatch(el: XmlElement): boolean {
  return el.elements.length === 0 && el.text().trim() !== '';
}

/** Whether one node is the other or inside it. */
function related(a: SchemaNode, b: SchemaNode): boolean {
  for (let n: SchemaNode | undefined = a; n !== undefined; n = n.parent) if (n === b) return true;
  for (let n: SchemaNode | undefined = b; n !== undefined; n = n.parent) if (n === a) return true;
  return false;
}

/** A schema node's data path with every step prefixed, for Schema.find. */
function pathOf(node: SchemaNode): string {
  const steps: string[] = [];
  for (let n: SchemaNode | undefined = node; n !== undefined; n = n.parent) {
    if (n.kind === 'choice' || n.kind === 'case' || n.kind === 'input' || n.kind === 'output') continue;
    steps.unshift(`${n.module.name}:${n.name}`);
  }
  return `/${steps.join('/')}`;
}
