/**
 * Splitting a change to running by owning provider (design §6 step 2,
 * PROVIDER-05 AC1). Each change goes to the provider that owns its node. A
 * created or deleted node that holds registered subtrees also gives each of
 * those providers a create or delete of its own instances, so a provider sees
 * every change to its subtree however high up the edit was made.
 *
 * What no provider owns is unclaimed (design §4.1). Non-presence containers
 * are only structure, so a change counts as unclaimed configuration only if
 * it holds something that means something on its own: a leaf, a leaf-list
 * entry, a list entry, a presence container, or anydata.
 */

import type { DataChange, InstanceNode } from '@node-net/yang/core';
import type { Registration, Registry } from './provider.js';

export interface SplitChanges {
  /** Each provider's changes, in document order. */
  readonly byProvider: ReadonlyMap<Registration, readonly DataChange[]>;
  /** Changes to configuration no provider owns. */
  readonly unclaimed: readonly DataChange[];
}

export function splitChanges(changes: readonly DataChange[], registry: Registry): SplitChanges {
  const byProvider = new Map<Registration, DataChange[]>();
  const unclaimed: DataChange[] = [];
  const give = (r: Registration, c: DataChange): void => {
    const list = byProvider.get(r);
    if (list === undefined) byProvider.set(r, [c]);
    else list.push(c);
  };

  for (const c of changes) {
    if (c.operation === 'origin') continue;
    const owner = registry.ownerOf(c.node.schema);
    if (owner !== undefined) give(owner, c);
    else if (meaningful(c.node, registry)) unclaimed.push(c);

    // Registered subtrees inside a created or deleted node.
    if ((c.operation === 'create' || c.operation === 'delete') && 'children' in c.node && registry.hasBelow(c.node.schema)) {
      const visit = (nodes: readonly InstanceNode[]): void => {
        for (const n of nodes) {
          const r = registry.at(n.schema);
          if (r !== undefined) give(r, { operation: c.operation, path: n.path, node: n });
          if ('children' in n) visit(n.children);
        }
      };
      visit(c.node.children);
    }
  }
  return { byProvider, unclaimed };
}

/** Whether an unclaimed node holds configuration that means something, outside registered subtrees. */
function meaningful(node: InstanceNode, registry: Registry): boolean {
  switch (node.kind) {
    case 'container':
      if (node.schema.kind === 'container' && node.schema.presence !== undefined) return true;
      return node.children.some((c) => registry.at(c.schema) === undefined && meaningful(c, registry));
    case 'rpc':
    case 'action':
    case 'notification':
      return false;
    default:
      return true;
  }
}
