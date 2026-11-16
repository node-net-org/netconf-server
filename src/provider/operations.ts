/**
 * RPCs and actions that providers implement (PROVIDER-11). The input is
 * decoded and validated against the schema and the current `<operational>`
 * data before the handler sees it, so leafrefs and `must` expressions in the
 * input are checked, and an action on an instance that doesn't exist gets
 * data-missing. The handler's output is validated too; it reaches the
 * client only if it is valid.
 */

import { YANG_NS, type Logger, type XmlElement } from '@node-net/netconf/core';
import { decodeJson, decodeXml, encodeJson, encodeXml, validate, YangDataError, type DataTree, type JsonValue, type OperationInstance, type Schema, type SchemaNode } from '@node-net/yang/core';
import type { Datastores } from '../datastore/datastores.js';
import { decideChain, type Verdict } from '../nacm/decide.js';
import { chainOf } from '../nacm/path.js';
import type { ServerSession } from '../session/session.js';
import { errorPath, issueErrors } from '../rpc/data-errors.js';
import { type Dispatcher, type OperationContext, type OperationResult } from '../rpc/dispatch.js';
import { operationFailed, operationNotSupported, RpcFailure } from '../rpc/errors.js';
import { contentOf } from '../rpc/params.js';
import { toElement } from '../rpc/xml.js';
import type { OperationCallHandler, Registry } from './provider.js';

export interface OperationsOptions {
  readonly dispatcher: Dispatcher;
  readonly registry: Registry;
  readonly schema: Schema;
  readonly datastores: Datastores;
  readonly logger: Logger;
  /** NACM refused an action (NACM design §6): count, log and report it. `path` is the action's full instance path. */
  readonly actionDenied?: (session: ServerSession, action: SchemaNode, path: string, verdict: Verdict) => void;
}

export class Operations {
  /** The RPCs handled now, as `{namespace}name`. */
  readonly #handled = new Map<string, { ns: string; name: string }>();

  constructor(private readonly o: OperationsOptions) {
    o.dispatcher.handle(YANG_NS, 'action', (ctx) => this.#action(ctx));
  }

  /** Brings the dispatcher's RPC handlers in step with the registry's. */
  sync(): void {
    const wanted = new Map<string, { ns: string; name: string }>();
    for (const rpc of this.o.registry.operations.rpcs.keys()) wanted.set(`{${rpc.module.namespace}}${rpc.name}`, { ns: rpc.module.namespace, name: rpc.name });
    for (const [k, v] of this.#handled) {
      if (!wanted.has(k)) {
        this.o.dispatcher.unhandle(v.ns, v.name);
        this.#handled.delete(k);
      }
    }
    for (const [k, v] of wanted) {
      if (this.#handled.has(k)) continue;
      this.#handled.set(k, v);
      this.o.dispatcher.handle(v.ns, v.name, (ctx) => this.#rpc(ctx));
    }
  }

  async #rpc(ctx: OperationContext): Promise<OperationResult> {
    const { operation } = ctx;
    const entry = [...this.o.registry.operations.rpcs].find(([rpc]) => rpc.module.namespace === operation.ns && rpc.name === operation.name)?.[1];
    if (entry === undefined) throw new RpcFailure(operationNotSupported(operation.name));
    const tree = this.#decode([withScope(operation)]);
    const op = tree.operation!;
    return this.#call(ctx, entry.handler, tree, op, `/${op.schema.module.name}:${op.schema.name}`, undefined);
  }

  async #action(ctx: OperationContext): Promise<OperationResult> {
    const content = contentOf(ctx.operation);
    if (content.length !== 1) throw new RpcFailure({ type: 'protocol', tag: 'bad-element', message: 'An action holds the data path to one action' });
    // Decoded first without validation: access is checked before validation can say whether the instance exists (NACM design §6).
    const tree = this.#decode(content, false);
    const op = tree.operation;
    if (op === undefined || op.kind !== 'action') throw new RpcFailure({ type: 'protocol', tag: 'bad-element', message: 'The action element holds no action' });
    this.#mayInvoke(ctx, op);
    const issues = validate(tree, { operational: this.o.datastores.operational() }).filter((i) => i.severity === 'error');
    if (issues.length > 0) throw new RpcFailure(issueErrors(issues, this.o.schema));
    const entry = this.o.registry.operations.actions.get(op.schema);
    if (entry === undefined) throw new RpcFailure(operationNotSupported(op.schema.name));
    const parent = op.parent as { path: string; schema: SchemaNode } | undefined;
    const instance = parent?.path ?? '';
    const step = parent !== undefined && parent.schema.module === op.schema.module ? op.schema.name : `${op.schema.module.name}:${op.schema.name}`;
    return this.#call(ctx, entry.handler, tree, op, `${instance}/${step}`, instance);
  }

  /**
   * RFC 8341 §3.1.3: an action needs read access to every instance on its
   * path and exec access to the action itself. A refusal names the deepest
   * instance the user may read, so it doesn't confirm that an unreadable
   * instance exists.
   */
  #mayInvoke(ctx: OperationContext, op: OperationInstance): void {
    const subject = ctx.access;
    if (subject === undefined || !subject.policy.enabled || subject.recovery) return;
    const chain = chainOf(op);
    let readable = 0;
    let verdict: Verdict | undefined;
    for (let i = 1; i < chain.length; i++) {
      const v = decideChain(subject, chain.slice(0, i), 'read');
      if (!v.permit) {
        verdict = v;
        break;
      }
      readable = i;
    }
    verdict ??= decideChain(subject, chain, 'exec');
    if (verdict.permit) return;
    const parent = op.parent as { path: string } | undefined;
    this.o.actionDenied?.(ctx.session, op.schema, `${parent?.path ?? ''}/${op.schema.name}`, verdict);
    const instance = readable === 0 ? undefined : chain[readable - 1]!.instance;
    const path = instance === undefined ? undefined : errorPath(instance.path, this.o.schema);
    throw new RpcFailure({
      type: 'protocol',
      tag: 'access-denied',
      ...(path === undefined || path.text === '/' ? {} : { path: path.text, pathDeclarations: path.declarations }),
      message: `Access to ${op.schema.name} is denied`,
    });
  }

  /** Decodes an invocation; unless `check` is false, validates it against the schema and the current operational data. */
  #decode(elements: readonly XmlElement[], check = true): DataTree {
    try {
      return decodeXml(this.o.schema, elements, { type: 'rpc', ...(check ? { validate: { operational: this.o.datastores.operational() } } : {}) });
    } catch (err) {
      if (err instanceof YangDataError) throw new RpcFailure(issueErrors(err.issues, this.o.schema));
      throw err;
    }
  }

  async #call(ctx: OperationContext, handler: OperationCallHandler, tree: DataTree, op: OperationInstance, opPath: string, instance: string | undefined): Promise<OperationResult> {
    const encoded = encodeJson([op]) as Record<string, JsonValue>;
    const input = (Object.values(encoded)[0] ?? {}) as Record<string, JsonValue>;
    let output: void | Readonly<Record<string, JsonValue>>;
    try {
      output = await handler({
        input,
        tree,
        ...(instance === undefined ? {} : { path: instance }),
        sessionId: ctx.session.id,
        username: ctx.session.principal.username,
        signal: ctx.signal,
      });
    } catch (err) {
      if (err instanceof RpcFailure) throw err;
      throw new RpcFailure(operationFailed((err as Error).message || `${op.schema.name} failed`));
    }
    if (output === undefined || output === null || Object.keys(output).length === 0) return 'ok';
    let reply: DataTree;
    try {
      reply = decodeJson(this.o.schema, { [`${op.schema.module.name}:output`]: output }, {
        type: 'reply',
        operation: opPath,
        validate: { operational: this.o.datastores.operational() },
      });
    } catch (err) {
      const detail = err instanceof YangDataError ? err.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : (err as Error).message;
      this.o.logger.error?.(`The handler for ${op.schema.name} returned output that is not valid`, { error: detail });
      throw new RpcFailure(operationFailed(`The handler for ${op.schema.name} returned output that is not valid`));
    }
    const params = reply.operation?.children ?? [];
    return params.length === 0 ? 'ok' : (encodeXml(params).map(toElement));
  }
}

/** The operation element with the namespaces in scope declared on it, to decode alone. */
function withScope(el: XmlElement): XmlElement {
  return el.inScope === el.declarations ? el : (Object.create(el, { declarations: { value: el.inScope } }) as XmlElement);
}
