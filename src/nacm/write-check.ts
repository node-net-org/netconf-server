/**
 * Write access (NACM design §7.2, RFC 8341 §3.2.5–§3.2.8): a write is
 * checked on the changes it makes, as @node-net/yang's diffTrees lists them, not
 * on the edit as sent. A created node needs create access, a deleted one
 * delete, and a changed value or a moved entry update. Nodes a write leaves
 * as they were need no access at all.
 *
 * A created or deleted subtree is checked at its root (or, for a
 * non-presence container, at each child) and then only at the
 * nodes inside it where the verdict could differ from the root's. The
 * verdict for a node is decided by the rules that match it and the
 * default-deny statements on it and its ancestors (§3.4.5), and going down a
 * subtree that set changes only at:
 *
 * - a node carrying `nacm:default-deny-write` or `nacm:default-deny-all`;
 * - a node a data-node rule's path names, which that rule starts to match;
 * - a node in a different module from its parent, when a rule names a
 *   module, since such a rule matches only nodes of its module.
 *
 * A non-presence container has no meaning of its own (RFC 7950 §7.5.1),
 * so its own creation or deletion needs no access: its children are
 * checked in its place.
 *
 * Those decision points come from the compiled policy and the schema, and
 * the walk goes down only into schema subtrees that hold one, so a large
 * created subtree under a simple policy costs one decision.
 */

import { dataChildren, type DataChange, type InstanceNode, type SchemaNode } from '@node-net/yang/core';
import { decideChain, type Subject, type Verdict } from './decide.js';
import { chainOf } from './path.js';
import type { AccessOperation, RuleList } from './policy.js';

/** The access a write needs. */
export type WriteAccess = Extract<AccessOperation, 'create' | 'update' | 'delete'>;

/** The first node a write was refused for. */
export interface DeniedWrite {
  /** In the new tree for a create, update or move; in the old tree for a delete. */
  readonly node: InstanceNode;
  readonly access: WriteAccess;
  readonly verdict: Verdict;
}

/** Choice, case, input and output never appear in a data path. */
const TRANSPARENT = new Set(['choice', 'case', 'input', 'output']);

/**
 * The first node, in document order, that the changes need access to and
 * the subject lacks; undefined when every change is permitted.
 */
export function firstDeniedWrite(subject: Subject, changes: readonly DataChange[]): DeniedWrite | undefined {
  if (!subject.policy.enabled || subject.recovery) return undefined;
  for (const c of changes) {
    const access = accessFor(c.operation);
    if (access === undefined) continue;
    const denied = access === 'update' ? checkNode(subject, c.node, access) : checkSubtree(subject, c.node, access);
    if (denied !== undefined) return denied;
  }
  return undefined;
}

function checkNode(subject: Subject, node: InstanceNode, access: WriteAccess): DeniedWrite | undefined {
  const verdict = decideChain(subject, chainOf(node), access);
  return verdict.permit ? undefined : { node, access, verdict };
}

/**
 * A created or deleted subtree. A non-presence container has no meaning of
 * its own (RFC 7950 §7.5.1): it appears with its first child and goes with
 * its last. So, at the root and anywhere inside, its own creation or
 * deletion needs no access, and its children are checked in its place.
 */
function checkSubtree(subject: Subject, node: InstanceNode, access: WriteAccess): DeniedWrite | undefined {
  const p = points(subject, access);
  if (isNonPresence(node)) return firstDeniedInside(subject, p, node, access, true);
  return checkNode(subject, node, access) ?? firstDeniedInside(subject, p, node, access, false);
}

function isNonPresence(node: InstanceNode): boolean {
  return node.kind === 'container' && node.schema.kind === 'container' && node.schema.presence === undefined;
}

function accessFor(operation: DataChange['operation']): WriteAccess | undefined {
  switch (operation) {
    case 'create':
      return 'create';
    case 'delete':
      return 'delete';
    case 'replace':
    case 'move':
      return 'update';
    default:
      return undefined;
  }
}

/**
 * The decision points below `node`, in preorder, checked until one is
 * refused. With `all`, every child is one: `node` is a non-presence
 * container whose verdict wasn't checked, so its children's verdicts may
 * differ from its parent's.
 */
function firstDeniedInside(subject: Subject, p: Points, node: InstanceNode, access: WriteAccess, all: boolean): DeniedWrite | undefined {
  if (!('children' in node)) return undefined;
  for (const child of node.children) {
    const point = all || p.isPoint(child.schema);
    let denied: DeniedWrite | undefined;
    if (isNonPresence(child)) {
      if (point || p.below(child.schema)) denied = firstDeniedInside(subject, p, child, access, point);
    } else {
      if (point) denied = checkNode(subject, child, access);
      if (denied === undefined && p.below(child.schema)) denied = firstDeniedInside(subject, p, child, access, false);
    }
    if (denied !== undefined) return denied;
  }
  return undefined;
}

/** Where the verdict for one access can change, for one set of rule-lists. */
interface Points {
  /** Whether the verdict can differ at this node from its parent's. */
  isPoint(node: SchemaNode): boolean;
  /** Whether a decision point lies anywhere below this node. */
  below(node: SchemaNode): boolean;
}

const cache = new WeakMap<readonly RuleList[], Map<WriteAccess, Points>>();

/** The decision points of a subject's rule-lists for an access, memoised per schema node. */
function points(subject: Subject, access: WriteAccess): Points {
  let byAccess = cache.get(subject.ruleLists);
  if (byAccess === undefined) cache.set(subject.ruleLists, (byAccess = new Map<WriteAccess, Points>()));
  let p = byAccess.get(access);
  if (p === undefined) byAccess.set(access, (p = buildPoints(subject, access)));
  return p;
}

function buildPoints(subject: Subject, access: WriteAccess): Points {
  const targets = new Set<SchemaNode>();
  let moduleRules = false;
  for (const list of subject.ruleLists) {
    for (const rule of list.rules) {
      if (rule.moduleName !== '*') moduleRules = true;
      if (rule.target.type !== 'data-node' || rule.target.steps === undefined) continue;
      if (rule.operations !== '*' && !rule.operations.has(access)) continue;
      const last = rule.target.steps.at(-1);
      if (last !== undefined) targets.add(last.node);
    }
  }
  const pointMemo = new Map<SchemaNode, boolean>();
  const belowMemo = new Map<SchemaNode, boolean>();
  const isPoint = (node: SchemaNode): boolean => {
    let v = pointMemo.get(node);
    if (v === undefined) {
      const parent = dataParent(node);
      v = subject.defaults.of(node) !== undefined || targets.has(node) || (moduleRules && parent !== undefined && parent.module !== node.module);
      pointMemo.set(node, v);
    }
    return v;
  };
  const below = (node: SchemaNode): boolean => {
    let v = belowMemo.get(node);
    if (v === undefined) {
      v =dataChildren(node).some((c) => isPoint(c) || below(c));
      belowMemo.set(node, v);
    }
    return v;
  };
  return { isPoint, below };
}

/** A schema node's nearest ancestor that is a data node: choice and case left out. */
function dataParent(node: SchemaNode): SchemaNode | undefined {
  let p = node.parent;
  while (p !== undefined && TRANSPARENT.has(p.kind)) p = p.parent;
  return p;
}
