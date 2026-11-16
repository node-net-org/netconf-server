/**
 * Reading operation parameters: the helpers the read and write handlers
 * share, each failure mapped to the rpc-error RFC 6241 Appendix A gives it.
 */

import { NETCONF_NS, type XmlElement } from '@node-net/netconf/core';
import { info, operationNotSupported, RpcFailure, type RpcErrorSpec } from './errors.js';

/** A parameter the operation must have: missing-element otherwise. */
export function required(operation: XmlElement, name: string, ns: string): XmlElement {
  const el = operation.child(name, ns);
  if (el === undefined) {
    throw new RpcFailure({ type: 'protocol', tag: 'missing-element', message: `${operation.name} needs ${name}`, info: [info('bad-element', name)] });
  }
  return el;
}

/** invalid-value naming the element at fault. */
export function invalid(message: string, element: string): RpcFailure {
  const spec: RpcErrorSpec = { type: 'protocol', tag: 'invalid-value', message, info: [info('bad-element', element)] };
  return new RpcFailure(spec);
}

/** The local name of an identityref value, when it is in `namespace`. */
export function identityName(element: XmlElement, namespace: string): string | undefined {
  const text = element.text().trim();
  const colon = text.indexOf(':');
  const prefix = colon === -1 ? '' : text.slice(0, colon);
  return element.inScope.get(prefix) === namespace ? text.slice(colon + 1) : undefined;
}

/** What a `<source>` or `<target>` names: a datastore, inline `<config>`, or a `<url>`. */
export type ConfigRef = { readonly kind: 'datastore'; readonly name: string } | { readonly kind: 'config'; readonly element: XmlElement } | { readonly kind: 'url' };

/**
 * Reads `<target>` or `<source>` of a base operation (RFC 6241 §7): one
 * child naming a datastore, `<config>` with inline content, or `<url>`, which
 * the server doesn't implement (operation-not-supported).
 */
export function configRef(operation: XmlElement, param: 'target' | 'source'): ConfigRef {
  const holder = required(operation, param, NETCONF_NS);
  const [choice, extra] = holder.elements;
  if (choice === undefined || choice.ns !== NETCONF_NS) throw invalid(`${operation.name} needs a ${param} datastore`, param);
  if (extra !== undefined) throw invalid(`${operation.name}'s ${param} names one datastore`, extra.name);
  if (choice.name === 'url') throw new RpcFailure({ ...operationNotSupported('url'), message: 'The :url capability is not implemented' });
  if (choice.name === 'config') return { kind: 'config', element: choice };
  return { kind: 'datastore', name: choice.name };
}

/**
 * Content elements, each carrying the namespace declarations in scope where
 * it appeared, so prefixes in values (identityrefs, `yang:key`) declared on
 * an enclosing element still resolve once the elements are decoded alone.
 */
export function contentOf(element: XmlElement): XmlElement[] {
  return element.elements.map((el) => (el.inScope === el.declarations ? el : withScope(el)));
}

function withScope(el: XmlElement): XmlElement {
  return Object.create(el, { declarations: { value: el.inScope } }) as XmlElement;
}
