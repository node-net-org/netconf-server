/**
 * The NACM policy (RFC 8341 §3.5, NACM design §5): compiled from the
 * `/nacm` subtree of a `<running>` snapshot, and the `nacm:default-deny-*`
 * statements of the schema, collected once per schema.
 */

import type { ContainerInstance, DataTree, InstanceNode, ListEntry, Schema, SchemaNode, YangValue } from '@node-net/yang/core';
import { resolvePath, type PathStep } from './path.js';

export const NACM_MODULE = 'ietf-netconf-acm';
export const NACM_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';

/** An access operation (RFC 8341 §3.2.2). */
export type AccessOperation = 'create' | 'read' | 'update' | 'delete' | 'exec';

/** What a rule applies to: anything in its module, or one rule-type (§3.5.2). */
export type RuleTarget =
  | { readonly type: 'any' }
  | { readonly type: 'protocol-operation'; readonly rpcName: string }
  | { readonly type: 'notification'; readonly notificationName: string }
  /** `steps` is undefined when the path doesn't resolve: such a rule never matches. */
  | { readonly type: 'data-node'; readonly path: string; readonly steps: readonly PathStep[] | undefined };

export interface Rule {
  /** The rule-list and rule names, `list/rule`, for logs and tests. */
  readonly name: string;
  /** A module name, or `*` for any. */
  readonly moduleName: string;
  readonly target: RuleTarget;
  /** The access operations it covers, or `*` for all. */
  readonly operations: ReadonlySet<AccessOperation> | '*';
  readonly action: 'permit' | 'deny';
}

export interface RuleList {
  readonly name: string;
  /** Group names, or `*` for every group. */
  readonly groups: ReadonlySet<string>;
  readonly rules: readonly Rule[];
}

/** A compiled `/nacm`. */
export interface Policy {
  readonly enabled: boolean;
  readonly readDefault: 'permit' | 'deny';
  readonly writeDefault: 'permit' | 'deny';
  readonly execDefault: 'permit' | 'deny';
  readonly externalGroups: boolean;
  /** Each user's groups from `/nacm/groups`. */
  readonly groupsByUser: ReadonlyMap<string, ReadonlySet<string>>;
  /** In configuration order. */
  readonly ruleLists: readonly RuleList[];
  /** Why each unresolvable rule path never matches. */
  readonly warnings: readonly string[];
}

/** RFC 8341's defaults, for a device with no `/nacm`. */
export const DEFAULT_POLICY: Policy = Object.freeze({
  enabled: true,
  readDefault: 'permit',
  writeDefault: 'deny',
  execDefault: 'permit',
  externalGroups: true,
  groupsByUser: new Map(),
  ruleLists: [],
  warnings: [],
});

/** The `/nacm` container in a running tree, if any. */
export function nacmNode(running: DataTree): ContainerInstance | undefined {
  const n = running.child('nacm', NACM_MODULE);
  return n?.kind === 'container' ? n : undefined;
}

/** Compiles `/nacm`. Rule paths are resolved against `schema`. */
export function compilePolicy(nacm: ContainerInstance | undefined, schema: Schema): Policy {
  if (nacm === undefined) return DEFAULT_POLICY;
  const groupsByUser = new Map<string, Set<string>>();
  const groups = child(nacm, 'groups');
  for (const group of groups?.kind === 'container' ? entries(groups, 'group') : []) {
    const name = leafText(group, 'name')!;
    for (const user of leafListTexts(group, 'user-name')) {
      let set = groupsByUser.get(user);
      if (set === undefined) groupsByUser.set(user, (set = new Set()));
      set.add(name);
    }
  }
  const warnings: string[] = [];
  const ruleLists: RuleList[] = entries(nacm, 'rule-list').map((list) => {
    const listName = leafText(list, 'name')!;
    return {
      name: listName,
      groups: new Set(leafListTexts(list, 'group')),
      rules: entries(list, 'rule').map((r) => {
        const name = `${listName}/${leafText(r, 'name')!}`;
        const target = ruleTarget(r, schema);
        if (target.type === 'data-node' && target.steps === undefined) warnings.push(`NACM rule ${name}: path ${target.path} never matches`);
        return {
          name,
          moduleName: leafText(r, 'module-name') ?? '*',
          target,
          operations: operations(r),
          action: leafText(r, 'action') === 'permit' ? 'permit' : 'deny',
        };
      }),
    };
  });
  return {
    enabled: leafText(nacm, 'enable-nacm') !== 'false',
    readDefault: leafText(nacm, 'read-default') === 'deny' ? 'deny' : 'permit',
    writeDefault: leafText(nacm, 'write-default') === 'permit' ? 'permit' : 'deny',
    execDefault: leafText(nacm, 'exec-default') === 'deny' ? 'deny' : 'permit',
    externalGroups: leafText(nacm, 'enable-external-groups') !== 'false',
    groupsByUser,
    ruleLists,
    warnings,
  };
}

function ruleTarget(rule: ListEntry, schema: Schema): RuleTarget {
  const rpcName = leafText(rule, 'rpc-name');
  if (rpcName !== undefined) return { type: 'protocol-operation', rpcName };
  const notificationName = leafText(rule, 'notification-name');
  if (notificationName !== undefined) return { type: 'notification', notificationName };
  const path = leafText(rule, 'path');
  if (path !== undefined) {
    const steps = resolvePath(schema, path);
    return { type: 'data-node', path, steps: typeof steps === 'string' ? undefined : steps };
  }
  return { type: 'any' };
}

const ALL_OPERATIONS: readonly AccessOperation[] = ['create', 'read', 'update', 'delete', 'exec'];

/** access-operations: `*` (its default), or the bits that are set. */
function operations(rule: ListEntry): ReadonlySet<AccessOperation> | '*' {
  const leaf = child(rule, 'access-operations');
  if (leaf === undefined || leaf.kind !== 'leaf') return '*';
  const value = leaf.value.value;
  const bits = Array.isArray(value) ? (value as readonly string[]) : scalar(value).split(/\s+/);
  if (bits.includes('*')) return '*';
  return new Set(ALL_OPERATIONS.filter((op) => bits.includes(op)));
}

function child(node: ContainerInstance | ListEntry, name: string): InstanceNode | undefined {
  return node.child(name, NACM_MODULE);
}

function entries(node: ContainerInstance | ListEntry, name: string): ListEntry[] {
  return node.childrenNamed(name, NACM_MODULE).filter((n): n is ListEntry => n.kind === 'list');
}

function leafText(node: ContainerInstance | ListEntry, name: string): string | undefined {
  const leaf = child(node, name);
  return leaf?.kind === 'leaf' ? scalar(leaf.value.value) : undefined;
}

function leafListTexts(node: ContainerInstance | ListEntry, name: string): string[] {
  return node.childrenNamed(name, NACM_MODULE).flatMap((n) => (n.kind === 'leaf-list' ? [scalar(n.value.value)] : []));
}

/** A string, number or boolean value as text. NACM's leaves are no other kind. */
function scalar(value: YangValue): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' ? String(value) : '';
}

/** The `nacm:default-deny-*` statements of a schema (§3.5.1.1–2). */
export interface Defaults {
  /** The statement on this node itself, if any. */
  of(node: SchemaNode): 'all' | 'write' | undefined;
}

const defaultsCache = new WeakMap<Schema, Defaults>();

/** The schema's default-deny statements, collected once per schema. */
export function schemaDefaults(schema: Schema): Defaults {
  let d = defaultsCache.get(schema);
  if (d === undefined) defaultsCache.set(schema, (d = collectDefaults(schema)));
  return d;
}

function collectDefaults(schema: Schema): Defaults {
  const marked = new Map<SchemaNode, 'all' | 'write'>();
  const visit = (node: SchemaNode): void => {
    let mark: 'all' | 'write' | undefined;
    for (const e of node.extensions) {
      if (e.module !== NACM_MODULE) continue;
      if (e.name === 'default-deny-all') mark = 'all';
      else if (e.name === 'default-deny-write' && mark === undefined) mark = 'write';
    }
    if (mark !== undefined) marked.set(node, mark);
    for (const c of node.children) visit(c);
  };
  for (const m of schema.implemented) {
    for (const n of [...m.dataNodes, ...m.rpcs, ...m.notifications]) visit(n);
  }
  return { of: (node) => marked.get(node) };
}
