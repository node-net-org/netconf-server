/**
 * RPC dispatch (RFC 6241 §4): checks a request against the protocol and the
 * schema, finds its handler, and builds the `<rpc-reply>`. The checks run in
 * this order, each with the error RFC 6241 Appendix A gives it:
 *
 * 1. not well formed, or a DOCTYPE: malformed-message
 * 2. not an `<rpc>` in the base namespace: malformed-message
 * 3. no message-id: missing-attribute
 * 4. no operation: missing-element; more than one: unknown-element
 * 5. an operation namespace no module defines: unknown-namespace
 * 6. no such operation: unknown-element (operation-not-supported for a
 *    standard operation behind a capability the device lacks)
 * 7. a parameter the operation doesn't define: unknown-element
 * 8. not permitted by NACM (RFC 8341 §3.4.4): access-denied
 * 9. no handler: operation-not-supported
 *
 * A YANG 1.1 `<action>` (RFC 7950 §7.15.2) is not an operation any module
 * defines; it goes to the action handler, which checks it against the
 * schema itself.
 */

import { NETCONF_NS, NOTIFICATION_NS, parseXml, XmlElement, YANG_NS, type Logger, type XmlNode } from '@node-net/netconf/core';
import { dataChildren, type RpcNode, type Schema } from '@node-net/yang/core';
import { decideExec, type Subject, type Verdict } from '../nacm/decide.js';
import { ErrorSanitiser } from '../nacm/sanitise.js';
import type { ServerSession } from '../session/session.js';
import { info, malformedMessage, operationNotSupported, RpcFailure, rpcErrorElement, type RpcErrorSpec } from './errors.js';


/**
 * Standard operations, by namespace. Asked for on a device whose capabilities
 * leave them out (so the schema doesn't have them), they get
 * operation-not-supported rather than unknown-element (DEVICE-03).
 */
const STANDARD_OPERATIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    NETCONF_NS,
    new Set([
      'get-config',
      'edit-config',
      'copy-config',
      'delete-config',
      'lock',
      'unlock',
      'get',
      'close-session',
      'kill-session',
      'commit',
      'discard-changes',
      'cancel-commit',
      'validate',
    ]),
  ],
  [NOTIFICATION_NS, new Set(['create-subscription'])],
]);

/** What a handler is given. */
export interface OperationContext {
  readonly session: ServerSession;
  /** The operation element: the `<rpc>`'s child. */
  readonly operation: XmlElement;
  readonly messageId: string;
  /** Aborted when the session ends. */
  readonly signal: AbortSignal;
  /**
   * The session's view of the NACM policy for this message, taken from
   * running as the message arrived (RFC 8341 §3.4); undefined when access
   * isn't checked.
   */
  readonly access?: Subject | undefined;
}

/** `'ok'` for `<ok/>`, or the reply's children (such as `<data>`). */
export type OperationResult = 'ok' | readonly XmlNode[];

export type OperationHandler = (ctx: OperationContext) => OperationResult | Promise<OperationResult>;

/**
 * Checked for each operation found, before its parameters: an rpc-error to
 * answer with instead, or undefined to go on. The server refuses RPCs on a
 * subscribed session without :interleave this way (RFC 5277 §6).
 */
export type OperationGate = (session: ServerSession, operation: XmlElement) => RpcErrorSpec | undefined;

/** NACM's operation check (RFC 8341 §3.4.4), as the server supplies it. */
export interface AccessCheck {
  /**
   * The session's view of the policy for this message: the rules in
   * running as the message is taken. Undefined when access isn't checked.
   */
  subject(session: ServerSession): Subject | undefined;
  /** An operation was refused. */
  denied(session: ServerSession, rpc: RpcNode, verdict: Verdict): void;
}

export class Dispatcher {
  readonly #handlers = new Map<string, OperationHandler>();
  #gate: OperationGate | undefined;
  #access: AccessCheck | undefined;
  /** Implemented operations, by `{namespace}name`. */
  readonly #rpcs = new Map<string, RpcNode>();
  readonly #namespaces = new Set<string>();
  readonly #sanitiser: ErrorSanitiser;

  constructor(
    schema: Schema,
    private readonly logger: Logger,
  ) {
    this.#sanitiser = new ErrorSanitiser(schema);
    for (const m of schema.implemented) {
      this.#namespaces.add(m.namespace);
      for (const rpc of m.rpcs) this.#rpcs.set(key(m.namespace, rpc.name), rpc);
    }
  }

  /** Handle an operation. Replaces any earlier handler for it. */
  handle(namespace: string, name: string, handler: OperationHandler): void {
    this.#handlers.set(key(namespace, name), handler);
  }

  /** Sets the operation gate. */
  gate(gate: OperationGate): void {
    this.#gate = gate;
  }

  /** Sets the access check. */
  access(check: AccessCheck): void {
    this.#access = check;
  }

  /** Stop handling an operation: it gets operation-not-supported again. */
  unhandle(namespace: string, name: string): void {
    this.#handlers.delete(key(namespace, name));
  }

  /**
   * The reply to one message received on an open session. `tally` hears
   * whether it was a correct `<rpc>` or not (RFC 6022's in-rpcs and
   * in-bad-rpcs): one that fails before an operation is found is not.
   */
  async answer(session: ServerSession, text: string, tally: (correct: boolean) => void = () => undefined): Promise<XmlElement> {
    let rpc: XmlElement;
    try {
      rpc = parseXml(text);
    } catch (err) {
      tally(false);
      return reply(undefined, [malformedMessage((err as Error).message)]);
    }
    if (rpc.name !== 'rpc' || rpc.ns !== NETCONF_NS) {
      tally(false);
      return reply(undefined, [malformedMessage(`Expected <rpc> in ${NETCONF_NS}, got <${rpc.name}>`)]);
    }
    const messageId = rpc.attr('message-id');
    if (messageId === undefined) {
      tally(false);
      return reply(rpc, [
        {
          type: 'rpc',
          tag: 'missing-attribute',
          message: 'The rpc has no message-id',
          info: [info('bad-attribute', 'message-id'), info('bad-element', 'rpc')],
        },
      ]);
    }
    const context = { sessionId: session.id, username: session.principal.username, messageId };
    const errors = (...e: RpcErrorSpec[]): XmlElement => reply(rpc, e);

    const [operation, extra] = rpc.elements;
    if (operation === undefined) {
      tally(false);
      return errors({ type: 'protocol', tag: 'missing-element', message: 'The rpc has no operation', info: [info('bad-element', 'rpc')] });
    }
    if (extra !== undefined) {
      tally(false);
      return errors({ type: 'protocol', tag: 'unknown-element', message: 'An rpc holds one operation', info: [info('bad-element', extra.name)] });
    }
    tally(true);
    const ns = operation.ns ?? '';
    const rpcNode = this.#rpcs.get(key(ns, operation.name));
    const action = ns === YANG_NS && operation.name === 'action' && this.#handlers.has(key(ns, operation.name));
    if (rpcNode === undefined && !action) {
      if (STANDARD_OPERATIONS.get(ns)?.has(operation.name) === true) return errors(operationNotSupported(operation.name));
      if (!this.#namespaces.has(ns)) {
        return errors({
          type: 'protocol',
          tag: 'unknown-namespace',
          message: `No module defines namespace ${JSON.stringify(ns)}`,
          info: [info('bad-element', operation.name), info('bad-namespace', ns)],
        });
      }
      return errors({ type: 'protocol', tag: 'unknown-element', message: `Unknown operation ${operation.name}`, info: [info('bad-element', operation.name)] });
    }
    const refused = this.#gate?.(session, operation);
    if (refused !== undefined) return errors(refused);
    const params = rpcNode === undefined ? undefined : dataChildren(rpcNode.input);
    for (const param of params === undefined ? [] : operation.elements) {
      if (!params!.some((p) => p.name === param.name && p.module.namespace === (param.ns ?? ''))) {
        return errors({
          type: 'protocol',
          tag: 'unknown-element',
          message: `${operation.name} has no parameter ${param.name}`,
          info: [info('bad-element', param.name)],
        });
      }
    }
    logRequest(session, operation, this.logger, context);
    // The rules in effect for the whole message (RFC 8341 §3.4). An <action> is checked by its handler, which needs read access along its path (NACM design §6).
    const subject = this.#access?.subject(session);
    if (subject !== undefined && rpcNode !== undefined) {
      const verdict = decideExec(subject, rpcNode);
      if (!verdict.permit) {
        this.#access!.denied(session, rpcNode, verdict);
        return errors(accessDenied(rpcNode));
      }
    }

    const handler = this.#handlers.get(key(ns, operation.name));
    if (handler === undefined) return errors(operationNotSupported(operation.name));
    let answer: XmlElement;
    try {
      const result = await handler({ session, operation, messageId, signal: session.signal, access: subject });
      answer = reply(rpc, result === 'ok' ? [new XmlElement({ name: 'ok', ns: NETCONF_NS })] : result);
    } catch (err) {
      if (!(err instanceof RpcFailure)) {
        this.logger.error?.(`${operation.name} failed`, { ...context, error: (err as Error).message });
        return errors({ type: 'application', tag: 'operation-failed', message: `${operation.name} failed` });
      }
      answer = reply(rpc, err.errors);
    }
    // NACM design §7.3: nothing in an rpc-error the user may not read.
    return subject === undefined ? answer : this.#sanitiser.reply(answer, subject);
  }
}

/**
 * Logs each operation with its user, its name and the datastore it acts on,
 * just before the authorization point (design §10, SSH-05).
 */
function logRequest(session: ServerSession, operation: XmlElement, logger: Logger, context: Record<string, unknown>): void {
  const datastore = targetDatastore(operation);
  logger.debug?.(`Request ${operation.name}`, {
    ...context,
    operation: operation.name,
    ...(datastore === undefined ? {} : { datastore }),
    ...(session.principal.groups === undefined ? {} : { groups: session.principal.groups }),
  });
}

/** The datastore an operation acts on: its target, else its source, else NMDA's datastore parameter. */
export function targetDatastore(operation: XmlElement): string | undefined {
  for (const name of ['target', 'source']) {
    const which = operation.elements.find((e) => e.name === name)?.elements[0];
    if (which !== undefined) return which.name;
  }
  const datastore = operation.elements.find((e) => e.name === 'datastore');
  if (datastore === undefined) return undefined;
  const name = datastore.text().trim();
  return name.slice(name.indexOf(':') + 1);
}

/**
 * access-denied for an operation (RFC 8341 §3.4.4): error-path names the
 * operation, as in `/nc:rpc/nc:edit-config`.
 */
export function accessDenied(rpc: RpcNode): RpcErrorSpec {
  const m = rpc.module;
  const prefix = m.namespace === NETCONF_NS ? 'nc' : m.prefix === 'nc' ? 'op' : m.prefix;
  return {
    type: 'protocol',
    tag: 'access-denied',
    path: `/nc:rpc/${prefix}:${rpc.name}`,
    pathDeclarations: { 'xmlns:nc': NETCONF_NS, [`xmlns:${prefix}`]: m.namespace },
    message: `Access to ${rpc.name} is denied`,
  };
}

function key(ns: string, name: string): string {
  return `{${ns}}${name}`;
}

/**
 * An rpc-reply to a request's text carrying `errors`: with the request's
 * attributes when it is a readable `<rpc>`, otherwise none.
 */
export function errorReply(request: string, errors: readonly RpcErrorSpec[]): XmlElement {
  let rpc: XmlElement | undefined;
  try {
    const parsed = parseXml(request);
    if (parsed.name === 'rpc' && parsed.ns === NETCONF_NS) rpc = parsed;
  } catch {
    rpc = undefined;
  }
  return reply(rpc, errors);
}

/**
 * An `<rpc-reply>` carrying every attribute of the request (RFC 6241 §4.2),
 * with `<rpc-error>`s or the given children.
 */
function reply(rpc: XmlElement | undefined, body: readonly RpcErrorSpec[] | readonly XmlNode[]): XmlElement {
  const children = body.map((b) => (typeof b === 'string' || b instanceof XmlElement ? b : rpcErrorElement(b)));
  return new XmlElement({ name: 'rpc-reply', ns: NETCONF_NS, attributes: rpc?.attributes ?? [], children });
}
