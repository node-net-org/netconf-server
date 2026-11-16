/**
 * rpc-errors that don't leak (NACM design §7.3, RFC 8341 §3.4.3): an error
 * must not include anything the client may not read. Validation errors are
 * the risk, since a `must`, `unique`, leafref or `mandatory` failure can
 * name a node the user can't read.
 *
 * For an error whose error-path names such a node:
 *
 * - the error-path is cut back to the deepest ancestor the user can read,
 *   or left out when there is none;
 * - its error-message becomes a generic one for its error-tag;
 * - its error-info is left out, apart from `session-id`, which names a
 *   session, not a node.
 *
 * The error-type, error-tag, error-severity and error-app-tag stay, so the
 * client still learns the kind of failure. An error the user may read keeps
 * everything but the `non-unique` entries naming nodes they can't. A path
 * that doesn't name data, such as an operation's `/nc:rpc/nc:get`, is left
 * as it is.
 */

import { NETCONF_NS, XmlElement, YANG_NS, type XmlNode } from '@node-net/netconf/core';
import { dataChildren, parseXPath, type Schema, type SchemaNode, type XPathExpr, type XPathStep } from '@node-net/yang/core';
import { decideChain, type Subject } from './decide.js';
import type { ChainLink } from './path.js';

/** The error-message sent in place of one that may name an unreadable node. */
const GENERIC: Readonly<Record<string, string>> = {
  'invalid-value': 'A value is not valid',
  'too-big': 'The request is too big',
  'missing-attribute': 'An expected attribute is missing',
  'bad-attribute': 'An attribute is not valid',
  'unknown-attribute': 'An attribute is not expected',
  'missing-element': 'An expected element is missing',
  'bad-element': 'An element is not valid',
  'unknown-element': 'An element is not expected',
  'unknown-namespace': 'A namespace is not expected',
  'access-denied': 'Access is denied',
  'lock-denied': 'The lock is denied',
  'resource-denied': 'There are not enough resources',
  'data-exists': 'The data already exists',
  'data-missing': 'Expected data is missing',
  'operation-not-supported': 'The operation is not supported',
  'operation-failed': 'The operation failed',
};

/** Sanitises the rpc-errors of a reply for a session under NACM. */
export class ErrorSanitiser {
  readonly #moduleByNamespace = new Map<string, string>();
  readonly #top: readonly SchemaNode[];

  constructor(schema: Schema) {
    for (const m of schema.allModules) if (!this.#moduleByNamespace.has(m.namespace)) this.#moduleByNamespace.set(m.namespace, m.name);
    this.#top = schema.dataNodes;
  }

  /** The reply with each rpc-error sanitised; the same element when nothing changed. */
  reply(reply: XmlElement, subject: Subject): XmlElement {
    if (!subject.policy.enabled || subject.recovery) return reply;
    let changed = false;
    const children = reply.children.map((c) => {
      if (typeof c === 'string' || c.name !== 'rpc-error' || c.ns !== NETCONF_NS) return c;
      const s = this.error(c, subject);
      if (s !== c) changed = true;
      return s;
    });
    return changed ? new XmlElement({ ...reply, children }) : reply;
  }

  /** One rpc-error, sanitised. */
  error(error: XmlElement, subject: Subject): XmlElement {
    const pathEl = error.elements.find((e) => e.name === 'error-path');
    const cut = pathEl === undefined ? undefined : this.#cut(pathEl, subject);
    if (cut === undefined) {
      // Readable, or no path: only non-unique entries naming unreadable nodes go.
      const children = error.children.map((c) => (typeof c !== 'string' && c.name === 'error-info' ? this.#readableInfo(c, subject) : c));
      return children.every((c, i) => c === error.children[i]) ? error : rebuild(error, children);
    }
    const tag = error.elements.find((e) => e.name === 'error-tag')?.text().trim() ?? '';
    const children: XmlNode[] = [];
    for (const c of error.children) {
      if (typeof c === 'string') continue;
      if (c === pathEl) {
        if (cut !== null) children.push(cut);
      } else if (c.name === 'error-message') {
        children.push(new XmlElement({ ...c, children: [GENERIC[tag] ?? 'The request failed'] }));
      } else if (c.name === 'error-info') {
        const kept = c.elements.filter((e) => e.name === 'session-id');
        if (kept.length > 0) children.push(new XmlElement({ ...c, children: kept }));
      } else children.push(c);
    }
    return rebuild(error, children);
  }

  /**
   * undefined when the user may read everything the path names (or it names
   * no data); otherwise the path cut back to the deepest readable ancestor,
   * or null when there is none.
   */
  #cut(pathEl: XmlElement, subject: Subject): XmlElement | null | undefined {
    const text = pathEl.text().trim();
    const readable = this.#readableSteps(text, pathEl.inScope, subject);
    if (readable === undefined) return undefined;
    if (readable === 0) return null;
    const cut = `/${splitSteps(text).slice(0, readable).join('/')}`;
    const used = new Set([...cut.matchAll(/([A-Za-z_][\w.-]*):/g)].map((m) => m[1]!));
    const declarations = new Map([...pathEl.declarations].filter(([prefix]) => prefix === '' || used.has(prefix)));
    return new XmlElement({ name: pathEl.name, ns: pathEl.ns, prefix: pathEl.prefix, attributes: pathEl.attributes, declarations, children: [cut] });
  }

  /** error-info without the non-unique entries the user can't read. */
  #readableInfo(info: XmlElement, subject: Subject): XmlElement {
    const children = info.children.filter((c) => typeof c === 'string' || c.name !== 'non-unique' || c.ns !== YANG_NS || this.#readableSteps(c.text().trim(), c.inScope, subject) === undefined);
    return children.length === info.children.length ? info : new XmlElement({ ...info, children });
  }

  /**
   * How many leading steps of a path the user may read, when that is fewer
   * than the steps it resolves to data nodes; undefined when they may read
   * all of them, or the path names no data node.
   */
  #readableSteps(text: string, scope: ReadonlyMap<string, string>, subject: Subject): number | undefined {
    const chain = this.#chain(text, scope);
    for (let i = 1; i <= chain.length; i++) {
      if (!decideChain(subject, chain.slice(0, i), 'read').permit) return i - 1;
    }
    return undefined;
  }

  /** The data nodes a path names, with the key values its predicates give, as far as it resolves. */
  #chain(text: string, scope: ReadonlyMap<string, string>): ChainLink[] {
    let ast: XPathExpr;
    try {
      ast = parseXPath(text);
    } catch {
      return [];
    }
    if (ast.type !== 'path' || ast.start !== 'root') return [];
    const chain: ChainLink[] = [];
    let candidates = this.#top;
    let module: string | undefined;
    for (const step of ast.steps) {
      if (step.axis !== 'child' || step.test.kind !== 'name') break;
      if (step.test.prefix !== undefined) module = this.#module(step.test.prefix, scope);
      const name = step.test.name;
      const node = candidates.find((c) => c.name === name && (module === undefined || c.module.name === module));
      if (node === undefined) break;
      chain.push({ node, instance: undefined, values: keyValues(step) });
      candidates = dataChildren(node);
    }
    return chain;
  }

  #module(prefix: string, scope: ReadonlyMap<string, string>): string | undefined {
    const ns = scope.get(prefix);
    return (ns === undefined ? undefined : this.#moduleByNamespace.get(ns)) ?? prefix;
  }
}

/** A step's `[key = 'value']` and `[. = 'value']` predicates, by key name; positions are ignored. */
function keyValues(step: XPathStep): Map<string, string> {
  const values = new Map<string, string>();
  for (const p of step.predicates) {
    if (p.type !== 'binary' || p.op !== '=' || (p.right.type !== 'literal' && p.right.type !== 'number')) continue;
    const left = p.left;
    if (left.type !== 'path' || left.start !== 'context' || left.steps.length !== 1) continue;
    const s = left.steps[0]!;
    if (s.axis === 'self' && s.test.kind === 'node') values.set('.', String(p.right.value));
    else if (s.axis === 'child' && s.test.kind === 'name') values.set(s.test.name, String(p.right.value));
  }
  return values;
}

/** A location path's steps as written, split on `/` outside predicates and quotes. */
export function splitSteps(path: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = '';
  for (const ch of path.startsWith('/') ? path.slice(1) : path) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '/' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function rebuild(el: XmlElement, children: readonly XmlNode[]): XmlElement {
  return new XmlElement({ ...el, children });
}
