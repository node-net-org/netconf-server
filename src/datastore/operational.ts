/**
 * The state the server holds for `<operational>` (design §5, PROVIDER-02,
 * PROVIDER-04): an immutable snapshot that starts as the device's
 * operational file and changes when a provider pushes an update or a read
 * hook returns new state. Reads merge it with running's configuration and
 * the state the server produces (datastores.ts).
 *
 * Configuration belongs to running and changes through the write path or
 * applyExternal. State data may hold configuration nodes only as structure
 * (containers, list entries and their keys) or as configuration the system
 * or the network made, marked with an `or:origin` of `system` or `learned`
 * (RFC 8342 §5.3.4, READ-03 AC3).
 */

import { ORIGIN_NS } from '@node-net/netconf/core';
import {
  DataTree,
  decodeJson,
  diffTrees,
  effectiveOrigin,
  mergeTrees,
  selectionTree,
  tryApplyEdit,
  validate,
  YangDataError,
  type DataIssue,
  type InstanceNode,
  type JsonValue,
  type Schema,
} from '@node-net/yang/core';
import type { Registration, Registry, SubtreeData } from '../provider/provider.js';

/** State changed, as the `stateChanged` event reports it. */
export interface StateChangedEvent {
  /** The data paths of the nodes that changed. */
  readonly paths: readonly string[];
}

/** An edit of the held state: a @node-net/yang edit tree, or RFC 7951 JSON with NETCONF edit annotations. */
export type StateEdit = DataTree | Readonly<Record<string, JsonValue>>;

export class OperationalState {
  #tree: DataTree;

  constructor(
    /** The operational datastore's schema. */
    readonly schema: Schema,
    initial: DataTree,
    private readonly registry: Registry,
  ) {
    this.#tree = initial;
  }

  /** The current snapshot. Never change it. */
  get tree(): DataTree {
    return this.#tree;
  }

  /**
   * Applies an edit (PROVIDER-04). Returns the paths that changed.
   * @throws YangDataError with every problem, the state unchanged
   */
  update(edit: StateEdit): string[] {
    const editTree = edit instanceof DataTree ? edit : decodeJson(this.schema, edit, { edit: true });
    const result = tryApplyEdit(this.#tree, editTree, { errorOption: 'rollback-on-error', state: true });
    if (result.rejected) throw new YangDataError(result.errors);
    return this.#swap(result.tree);
  }

  /**
   * Replaces the state a provider supplies for its subtree with `content`
   * (a read hook's result, PROVIDER-02 AC3). Nodes deeper providers own are
   * left alone. Returns the paths that changed.
   * @throws YangDataError with every problem, the state unchanged
   */
  replace(r: Registration, content: SubtreeData): string[] {
    const given = content instanceof DataTree ? content : decodeJson(this.schema, content);
    return this.#swap(replaceRegion(this.#tree, r, this.registry, given));
  }

  /**
   * Makes an earlier snapshot (or the device's initial state) current again,
   * for the control module's reset and restore. It was valid when it was
   * taken, so it isn't checked again. Returns the paths that changed.
   */
  restore(tree: DataTree): string[] {
    const changes = diffTrees(this.#tree, tree);
    this.#tree = tree;
    return changes.map((c) => c.path);
  }

  /** Checks a new snapshot and makes it current. */
  #swap(next: DataTree): string[] {
    const changes = diffTrees(this.#tree, next);
    if (changes.length === 0) return [];
    const issues: DataIssue[] = [];
    for (const c of changes) {
      if (c.operation === 'create' || c.operation === 'replace' || c.operation === 'move') checkConfig(c.node, issues, inheritsSystem(c.node));
    }
    issues.push(...validate(next).filter((i) => i.severity === 'error'));
    if (issues.length > 0) throw new YangDataError(issues);
    this.#tree = next;
    return changes.map((c) => c.path);
  }
}

/**
 * A copy of `tree` in which what provider `r` owns is replaced by the
 * instances of its subtree in `given` (state here, or configuration a
 * provider adopts at start-up). Nodes deeper providers own are kept.
 * Nothing is validated.
 */
export function replaceRegion(tree: DataTree, r: Registration, registry: Registry, given: DataTree): DataTree {
  const next = mergeTrees(new DataTree(tree.schema), tree);
  for (const node of [...next.walk()].filter((n) => n.schema === r.node)) {
    if (clear(node, r, registry)) detach(node);
  }
  const region = [...given.walk()].filter((n) => n.schema === r.node);
  return region.length === 0 ? next : mergeTrees(next, selectionTree(given, region));
}

/**
 * Removes what `r` owns below `node`; returns whether `node` itself should
 * go (it is `r`'s and nothing but its keys is left).
 */
function clear(node: InstanceNode, r: Registration, registry: Registry): boolean {
  if (registry.ownerOf(node.schema) !== r) return false;
  if (!('children' in node)) return !isKey(node);
  for (const c of [...node.children]) if (clear(c, r, registry)) node.remove(c);
  return node.children.every(isKey);
}

/** Removes a node, then any non-presence container left empty above it. */
function detach(node: InstanceNode): void {
  let parent = node.parent;
  parent?.remove(node);
  while (parent !== undefined && !(parent instanceof DataTree) && parent.kind === 'container' && parent.children.length === 0 && !(parent.schema.kind === 'container' && parent.schema.presence !== undefined)) {
    const up: InstanceNode['parent'] = parent.parent;
    up?.remove(parent);
    parent = up;
  }
}

function isKey(node: InstanceNode): boolean {
  const parent = node.parent;
  return node.kind === 'leaf' && parent !== undefined && !(parent instanceof DataTree) && parent.kind === 'list' && parent.schema.kind === 'list' && parent.schema.keys.includes(node.schema);
}

/** Configuration in state: structure, or nodes the system or network made. */
function checkConfig(node: InstanceNode, issues: DataIssue[], system = false): void {
  if (!node.schema.config) return;
  const made = system || hasSystemOrigin(node);
  if (made || node.kind === 'container' || node.kind === 'list' || isKey(node)) {
    if ('children' in node) for (const c of node.children) checkConfig(c, issues, made);
    return;
  }
  issues.push({
    code: 'invalid-edit',
    message: `${node.path} is configuration; state updates can't change it unless its origin is system or learned (use applyExternal)`,
    path: node.path,
    severity: 'error',
  });
}

/** Whether an ancestor's origin is system or learned. */
function inheritsSystem(node: InstanceNode): boolean {
  for (let p = node.parent; p !== undefined && !(p instanceof DataTree); p = p.parent) if (hasSystemOrigin(p)) return true;
  return false;
}

function hasSystemOrigin(node: InstanceNode): boolean {
  const own = node.annotations.some((a) => a.name === 'origin' && (a.namespace === ORIGIN_NS || a.module === 'ietf-origin'));
  const origin = own ? effectiveOrigin(node) : undefined;
  if (origin === undefined || typeof origin === 'string') return false;
  const module = origin.module;
  return ['system', 'learned'].some((name) => {
    const base = module.identities.get(name);
    return base !== undefined && (origin === base || base.derived.has(origin));
  });
}
