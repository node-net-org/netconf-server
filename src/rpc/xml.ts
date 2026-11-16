/**
 * Between @node-net/yang's parsed-XML shape and @node-net/netconf's XmlElement: replies
 * are encoded by @node-net/yang and sent by @node-net/netconf.
 */

import { XmlElement, type XmlNode } from '@node-net/netconf/core';
import { encodeXml, type DataTree, type InstanceNode, type XmlChild, type XmlElementLike } from '@node-net/yang/core';

/** A @node-net/yang element as a @node-net/netconf one. */
export function toElement(el: XmlElementLike): XmlElement {
  const children: XmlNode[] = (el.children ?? []).map((c: XmlChild) => (typeof c === 'string' ? c : toElement(c)));
  return new XmlElement({
    name: el.name,
    ns: el.ns ?? '',
    attributes: (el.attributes ?? []).map((a) => ({ name: a.name, ns: a.ns, ...(a.prefix === undefined ? {} : { prefix: a.prefix }), value: a.value })),
    children,
    ...(el.declarations === undefined ? {} : { declarations: el.declarations }),
  });
}

/** A `<data>` element in `ns` holding a tree's content, less the nodes in `skip` and their subtrees. */
export function dataElement(ns: string, tree: DataTree, skip?: ReadonlySet<InstanceNode>): XmlElement {
  return new XmlElement({ name: 'data', ns, children: encodeXml(tree, skip === undefined ? {} : { skip: (n) => skip.has(n) }).map(toElement) });
}
