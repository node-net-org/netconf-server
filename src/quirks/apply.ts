/**
 * How quirks change what a session writes (design §13). Each works on the
 * reply as an element or on its serialized text, after the server has
 * answered correctly, so the rest of the server never knows about them.
 */

import { NETCONF_NS, XmlElement, type XmlNode } from '@node-net/netconf/core';
import type { ActiveQuirks } from './catalogue.js';

/** The reply element with what the element-level quirks change. */
export function quirkReply(reply: XmlElement, quirks: ActiveQuirks): XmlElement {
  const q = quirks.get('replyWithoutMessageId');
  if (q === undefined) return reply;
  const isError = reply.child('rpc-error', NETCONF_NS) !== undefined;
  if (q['replies'] !== 'all' && !isError) return reply;
  return new XmlElement({
    name: reply.name,
    ns: reply.ns ?? '',
    attributes: reply.attributes.filter((a) => !(a.name === 'message-id' && (a.ns ?? '') === '')),
    children: reply.children,
  });
}

/** The serialized reply with what the text-level quirks change. */
export function quirkText(text: string, quirks: ActiveQuirks): string {
  const bad = quirks.get('invalidXmlChars');
  if (bad !== undefined) text = text.replace(/<\/error-message>/g, `${String(bad['char'])}</error-message>`);
  const padded = quirks.get('paddedEmptyElements');
  if (padded !== undefined) {
    const pad = `\n${' '.repeat(Number(padded['indent']))}`;
    // Empty elements inside <data>, written as <x/> or <x attr="v"/>, across two lines instead.
    text = text.replace(/<data(\s[^>]*)?>([\s\S]*)<\/data>/, (whole: string, attrs: string | undefined, body: string) => {
      const inner = body.replace(/<([A-Za-z_][\w.:-]*)((?:\s+[^<>"']+=(?:"[^"]*"|'[^']*'))*)\s*\/>/g, (_m: string, name: string, a: string) => `<${name}${a}>${pad}</${name}>`);
      return `<data${attrs ?? ''}>${inner}</data>`;
    });
  }
  return text;
}

/**
 * A message in chunked framing with a broken chunk header (the
 * chunkedFramingBroken quirk): the size is followed by a space, which
 * RFC 6242 §4.2's chunk-size doesn't allow.
 */
export function brokenChunk(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`\n#${body.length} \n`);
  const tail = new TextEncoder().encode('\n##\n');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

/**
 * The depth of a subtree filter (the subtreeFilterLimit quirk): the longest
 * run of selection and containment nodes, not counting a keyed list entry
 * (an element holding content-match nodes) straight after the deepest
 * counted step.
 */
export function subtreeFilterDepth(content: readonly XmlNode[]): number {
  const depth = (el: XmlElement): number => {
    const kids = el.elements;
    if (kids.length === 0) return 1;
    const matches = kids.filter((k) => k.elements.length === 0 && k.text().trim() !== '');
    const rest = kids.filter((k) => !matches.includes(k));
    const below = rest.length === 0 ? 0 : Math.max(...rest.map(depth));
    // A list entry selected by its keys is one CLI context with its list: the keys add no depth.
    return 1 + below;
  };
  const tops = content.filter((c): c is XmlElement => c instanceof XmlElement);
  return tops.length === 0 ? 0 : Math.max(...tops.map(depth));
}
