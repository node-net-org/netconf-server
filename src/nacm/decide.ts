/**
 * The NACM decisions (RFC 8341 §3.4.4–§3.4.6), each following its RFC
 * procedure step by step. Every verdict carries the step that reached it,
 * so the tests can show each step is reached.
 */

import type { InstanceNode, RpcNode, SchemaNode } from '@node-net/yang/core';
import { chainOf, pathMatches, type ChainLink } from './path.js';
import type { AccessOperation, Defaults, Policy, Rule, RuleList } from './policy.js';

export const NETCONF_MODULE = 'ietf-netconf';
export const NOTIFICATIONS_MODULE = 'nc-notifications';

/** A session's view of a policy: what the decisions need to know about who is asking. */
export interface Subject {
  readonly policy: Policy;
  readonly defaults: Defaults;
  /** A recovery session bypasses NACM (§3.3.3). */
  readonly recovery: boolean;
  /** The user's groups (§3.4.4 step 4), and the rule-lists that name any of them, in order. */
  readonly groups: ReadonlySet<string>;
  readonly ruleLists: readonly RuleList[];
}

export interface Verdict {
  readonly permit: boolean;
  /** The step of the RFC procedure that decided. */
  readonly step: number;
  /** The rule that decided, as `rule-list/rule`, when one did. */
  readonly rule?: string;
}

/** The rule-lists that apply to a user with these groups (§3.4.4 step 6): those naming one of them, or `*`. */
export function applicableRuleLists(policy: Policy, groups: ReadonlySet<string>): RuleList[] {
  if (groups.size === 0) return [];
  return policy.ruleLists.filter((l) => l.groups.has('*') || [...l.groups].some((g) => groups.has(g)));
}

/** The user's groups (§3.4.4 step 4): from /nacm/groups, plus the transport's when enable-external-groups is true. */
export function userGroups(policy: Policy, username: string, external: readonly string[] | undefined): Set<string> {
  const groups = new Set(policy.groupsByUser.get(username) ?? []);
  if (policy.externalGroups) for (const g of external ?? []) groups.add(g);
  return groups;
}

/** May the subject invoke this protocol operation (§3.4.4)? */
export function decideExec(s: Subject, rpc: RpcNode): Verdict {
  // 1. enable-nacm false
  if (!s.policy.enabled) return { permit: true, step: 1 };
  // 2. a recovery session
  if (s.recovery) return { permit: true, step: 2 };
  const moduleName = rpc.module.name;
  // 3. <close-session>
  if (moduleName === NETCONF_MODULE && rpc.name === 'close-session') return { permit: true, step: 3 };
  // 4–5. the user's groups; none, and the rules are skipped (s.ruleLists is empty).
  // 6–8. the first matching rule of the applicable rule-lists, in order.
  const rule = firstMatch(s, (r) => {
    if (!moduleMatches(r, moduleName)) return false;
    if (r.target.type !== 'any' && !(r.target.type === 'protocol-operation' && nameMatches(r.target.rpcName, rpc.name))) return false;
    return covers(r, 'exec');
  });
  if (rule !== undefined) return { permit: rule.action === 'permit', step: 8, rule: rule.name };
  // 9. no rule matched.
  // 10. nacm:default-deny-all on the rpc
  if (s.defaults.of(rpc) === 'all') return { permit: false, step: 10 };
  // 11. <kill-session> and <delete-config>
  if (moduleName === NETCONF_MODULE && (rpc.name === 'kill-session' || rpc.name === 'delete-config')) return { permit: false, step: 11 };
  // 12. exec-default
  return { permit: s.policy.execDefault === 'permit', step: 12 };
}

/**
 * May the subject perform `access` on a data node (§3.4.5)? `target` is a
 * node instance, or a schema node when no instance is named; a rule whose
 * path names particular list entries matches only an instance.
 */
export function decideData(s: Subject, target: SchemaNode | InstanceNode, access: AccessOperation): Verdict {
  return decideChain(s, chainOf(target), access);
}

/** decideData for the chain of nodes from the top of the tree down to the requested node. */
export function decideChain(s: Subject, chain: readonly ChainLink[], access: AccessOperation): Verdict {
  // 1. enable-nacm false
  if (!s.policy.enabled) return { permit: true, step: 1 };
  // 2. a recovery session
  if (s.recovery) return { permit: true, step: 2 };
  const node = chain[chain.length - 1]!.node;
  // 3–4. the user's groups; none, and the rules are skipped.
  // 5–7. the first matching rule of the applicable rule-lists, in order.
  const rule = firstMatch(s, (r) => {
    if (!moduleMatches(r, node.module.name)) return false;
    if (r.target.type !== 'any' && !(r.target.type === 'data-node' && r.target.steps !== undefined && pathMatches(r.target.steps, chain))) return false;
    return covers(r, access);
  });
  if (rule !== undefined) return { permit: rule.action === 'permit', step: 7, rule: rule.name };
  // 8. no rule matched.
  const mark = defaultMark(s, chain);
  // 9. read: nacm:default-deny-all on the node or an ancestor
  if (access === 'read' && mark === 'all') return { permit: false, step: 9 };
  const write = access === 'create' || access === 'update' || access === 'delete';
  // 10. write: nacm:default-deny-write or default-deny-all
  if (write && mark !== undefined) return { permit: false, step: 10 };
  // 11. read-default
  if (access === 'read') return { permit: s.policy.readDefault === 'permit', step: 11 };
  // 12. write-default
  if (write) return { permit: s.policy.writeDefault === 'permit', step: 12 };
  // 13. exec-default
  return { permit: s.policy.execDefault === 'permit', step: 13 };
}

/**
 * May the subject receive a notification of this type (§3.4.6)? A
 * notification nested in data needs read access to it as a data node
 * (§3.4.5), so pass its instance, or its schema node.
 */
export function decideNotification(s: Subject, notification: SchemaNode | InstanceNode): Verdict {
  const schema = 'schema' in notification ? notification.schema : notification;
  if (schema.parent !== undefined) return decideData(s, notification, 'read');
  // 1. enable-nacm false
  if (!s.policy.enabled) return { permit: true, step: 1 };
  // 2. a recovery session
  if (s.recovery) return { permit: true, step: 2 };
  const moduleName = schema.module.name;
  // 3. <replayComplete> and <notificationComplete>
  if (moduleName === NOTIFICATIONS_MODULE && (schema.name === 'replayComplete' || schema.name === 'notificationComplete')) return { permit: true, step: 3 };
  // 4–5. the user's groups; none, and the rules are skipped.
  // 6–8. the first matching rule of the applicable rule-lists, in order.
  const rule = firstMatch(s, (r) => {
    if (!moduleMatches(r, moduleName)) return false;
    if (r.target.type !== 'any' && !(r.target.type === 'notification' && nameMatches(r.target.notificationName, schema.name))) return false;
    return covers(r, 'read');
  });
  if (rule !== undefined) return { permit: rule.action === 'permit', step: 8, rule: rule.name };
  // 9. no rule matched.
  // 10. nacm:default-deny-all on the notification
  if (s.defaults.of(schema) === 'all') return { permit: false, step: 10 };
  // 11. read-default
  return { permit: s.policy.readDefault === 'permit', step: 11 };
}

function firstMatch(s: Subject, matches: (r: Rule) => boolean): Rule | undefined {
  for (const list of s.ruleLists) {
    for (const rule of list.rules) if (matches(rule)) return rule;
  }
  return undefined;
}

export function moduleMatches(rule: Rule, moduleName: string): boolean {
  return rule.moduleName === '*' || rule.moduleName === moduleName;
}

function nameMatches(pattern: string, name: string): boolean {
  return pattern === '*' || pattern === name;
}

export function covers(rule: Rule, access: AccessOperation): boolean {
  return rule.operations === '*' || rule.operations.has(access);
}

/** The strongest default-deny statement on a node or its ancestors: it covers the node and all its descendants. */
export function defaultMark(s: Subject, chain: readonly ChainLink[]): 'all' | 'write' | undefined {
  let mark: 'all' | 'write' | undefined;
  for (const link of chain) {
    const m = s.defaults.of(link.node);
    if (m === 'all') return 'all';
    mark ??= m;
  }
  return mark;
}
