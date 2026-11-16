/**
 * `<rpc-error>`s the server sends (RFC 6241 §4.3, Appendix A). Operation
 * handlers throw an RpcFailure; anything else they throw becomes
 * operation-failed.
 */

import { NETCONF_NS, x, XML_NS, type RpcErrorSeverity, type RpcErrorTag, type RpcErrorType, type XmlNode } from '@node-net/netconf/core';
import type { XmlElement } from '@node-net/netconf/core';

/** One `<rpc-error>` to send. */
export interface RpcErrorSpec {
  readonly type: RpcErrorType;
  readonly tag: RpcErrorTag;
  readonly severity?: RpcErrorSeverity;
  readonly appTag?: string;
  readonly path?: string;
  /** `xmlns:prefix` → namespace for the prefixes the path uses. */
  readonly pathDeclarations?: Readonly<Record<string, string>>;
  readonly message?: string;
  /** `<error-info>` children, such as `<bad-element>`. */
  readonly info?: readonly XmlNode[];
}

/** Thrown by an operation handler to answer with these rpc-errors. */
export class RpcFailure extends Error {
  override name = 'RpcFailure';
  readonly errors: readonly RpcErrorSpec[];

  constructor(errors: RpcErrorSpec | readonly RpcErrorSpec[]) {
    const list = Array.isArray(errors) ? (errors as readonly RpcErrorSpec[]) : [errors as RpcErrorSpec];
    super(list.map((e) => `${e.tag}${e.message !== undefined ? `: ${e.message}` : ''}`).join('; '));
    this.errors = list;
  }
}

export function rpcErrorElement(e: RpcErrorSpec): XmlElement {
  return x('rpc-error', { xmlns: NETCONF_NS },
    x('error-type', e.type),
    x('error-tag', e.tag),
    x('error-severity', e.severity ?? 'error'),
    e.appTag !== undefined && x('error-app-tag', e.appTag),
    e.path !== undefined && x('error-path', { ...e.pathDeclarations }, e.path),
    e.message !== undefined && x('error-message', { lang: { ns: XML_NS, prefix: 'xml', value: 'en' } }, e.message),
    e.info !== undefined && e.info.length > 0 && x('error-info', e.info),
  );
}

/** `<bad-element>` and friends, in the base namespace. */
export function info(name: 'bad-element' | 'bad-attribute' | 'bad-namespace' | 'session-id' | 'ok-element' | 'err-element' | 'noop-element', value: string): XmlElement {
  return x(name, { xmlns: NETCONF_NS }, value);
}

export function malformedMessage(message: string): RpcErrorSpec {
  return { type: 'rpc', tag: 'malformed-message', message };
}

export function operationNotSupported(name: string): RpcErrorSpec {
  return { type: 'protocol', tag: 'operation-not-supported', message: `The ${name} operation is not supported`, info: [info('bad-element', name)] };
}

/** A write to a datastore another session has locked (RFC 6241 Appendix A). */
export function inUse(datastore: string, holder: number): RpcErrorSpec {
  return { type: 'protocol', tag: 'in-use', message: `The ${datastore} datastore is locked by session ${holder}`, info: [info('session-id', String(holder))] };
}

/** A lock that can't be granted (RFC 6241 §7.5): `holder` is the session in the way, 0 when it isn't a NETCONF session. */
export function lockDenied(message: string, holder: number): RpcErrorSpec {
  return { type: 'protocol', tag: 'lock-denied', message, info: [info('session-id', String(holder))] };
}

/** operation-failed with a message. */
export function operationFailed(message: string, type: RpcErrorSpec['type'] = 'application'): RpcErrorSpec {
  return { type, tag: 'operation-failed', message };
}
