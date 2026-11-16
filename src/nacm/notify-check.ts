/**
 * Notification access (NACM design §8, RFC 8341 §3.4.6): whether a
 * subscriber may receive a notification, and for `<netconf-config-change>`,
 * which of its edits they may see.
 *
 * - A top-level notification needs read access to its type (§3.4.6 steps
 *   1–11, decideNotification): `<replayComplete>` and
 *   `<notificationComplete>` always pass.
 * - A notification nested in data (YANG 1.1) needs read access to every
 *   instance on the path to it (§3.1.3's "pre-read data node access
 *   control") and then to the notification itself (§3.4.6 → §3.4.5). Each
 *   ancestor is checked on its own, as reads are: a rule permitting the
 *   notification doesn't reach past an ancestor the user can't read.
 * - `<netconf-config-change>` is the one notification that names other
 *   data. Its `edit` entries whose target the user can't read are left out,
 *   which is stricter than RFC 8341 (design §12, decision 3), and one left
 *   with no edits isn't sent. One without an edit list (past 1000 changes,
 *   RFC 6470 §2.1.1) names no data, so its type check decides.
 *
 * RFC 8639/8641 subscriptions are to use this too when they arrive (design
 * §8): notificationAccess() for each event of a subscribed stream, and the
 * session's read plan (read-plan.ts) on the data a YANG-Push update carries.
 */

import { DataTree, pruneTree, type InstanceIdentifier, type InstanceNode } from '@node-net/yang/core';
import { decideChain, decideNotification, type Subject, type Verdict } from './decide.js';
import { valueText, type ChainLink } from './path.js';

const NCN = 'ietf-netconf-notifications';

/** What to send one subscriber. */
export type NotificationAccess =
  /** Nothing: the subscriber may not receive this notification. `path` is a nested notification's data path. */
  | { readonly action: 'deny'; readonly verdict: Verdict; readonly name: string; readonly path?: string }
  /** The notification as it was built. */
  | { readonly action: 'send'; readonly tree: DataTree }
  /** A copy without the edits the subscriber may not read. */
  | { readonly action: 'send-copy'; readonly tree: DataTree }
  /** Nothing: a netconf-config-change whose every edit the subscriber may not read. Not a denial of its type. */
  | { readonly action: 'suppress' };

/**
 * Checks notifications for subscribers. One instance serves one published
 * notification: subscribers whose sessions see the policy the same way
 * (the same rule-lists, which the engine caches per policy and group set)
 * share its answer and its copy, so a notification is never rebuilt per
 * session.
 */
export class NotificationCheck {
  readonly #tree: DataTree;
  readonly #answers = new WeakMap<readonly unknown[], NotificationAccess>();

  constructor(tree: DataTree) {
    this.#tree = tree;
  }

  /** What to send a subscriber, with this session view of the policy; undefined when access isn't checked. */
  access(subject: Subject | undefined): NotificationAccess {
    if (subject === undefined || !subject.policy.enabled || subject.recovery) return { action: 'send', tree: this.#tree };
    // Recovery and enable-nacm were checked above, so the rule-lists are the whole of what decides.
    let answer = this.#answers.get(subject.ruleLists);
    if (answer === undefined) {
      answer = notificationAccess(subject, this.#tree);
      this.#answers.set(subject.ruleLists, answer);
    }
    return answer;
  }
}

/** What a subscriber with this view of the policy may receive of a notification tree. */
export function notificationAccess(subject: Subject, tree: DataTree): NotificationAccess {
  const operation = tree.operation;
  if (operation === undefined) return { action: 'send', tree };
  const schema = operation.schema;
  if (schema.parent === undefined) {
    const verdict = decideNotification(subject, schema);
    if (!verdict.permit) return { action: 'deny', verdict, name: schema.name };
  } else {
    const chain: ChainLink[] = [];
    for (const n of ancestors(operation)) {
      chain.push({ node: n.schema, instance: n });
      const verdict = decideChain(subject, chain, 'read');
      if (!verdict.permit) return { action: 'deny', verdict, name: schema.name, path: operation.path };
    }
  }
  if (schema.module.name === NCN && schema.name === 'netconf-config-change') return configChangeAccess(subject, tree, operation);
  return { action: 'send', tree };
}

/** The instances from the top of the tree down to `node`, `node` included. */
function ancestors(node: InstanceNode): InstanceNode[] {
  const out: InstanceNode[] = [];
  for (let n: InstanceNode | InstanceNode['parent'] = node; n !== undefined && !(n instanceof DataTree); n = n.parent) out.push(n);
  return out.reverse();
}

/** netconf-config-change without the edits whose target the subscriber may not read. */
function configChangeAccess(subject: Subject, tree: DataTree, notification: InstanceNode): NotificationAccess {
  const edits = 'children' in notification ? notification.children.filter((c) => c.schema.name === 'edit') : [];
  // No edit list: past 1000 changes, or nothing to list. Nothing in it names data.
  if (edits.length === 0) return { action: 'send', tree };
  const drop = new Set<InstanceNode>();
  for (const edit of edits) {
    const target = 'children' in edit ? edit.children.find((c) => c.schema.name === 'target') : undefined;
    const value = target !== undefined && target.kind === 'leaf' ? (target.value.value as InstanceIdentifier) : undefined;
    if (value === undefined || !readable(subject, value)) drop.add(edit);
  }
  if (drop.size === 0) return { action: 'send', tree };
  if (drop.size === edits.length) return { action: 'suppress' };
  // Down to the notification, then every edit but the dropped ones, whole.
  const path = new Set(ancestors(notification));
  return { action: 'send-copy', tree: pruneTree(tree, { keep: (n) => (drop.has(n) ? 'drop' : path.has(n) ? 'descend' : 'keep') }) };
}

/** Whether the subscriber may read every node an instance-identifier names, from the top down (as reads and the error sanitiser decide). */
function readable(subject: Subject, id: InstanceIdentifier): boolean {
  const chain: ChainLink[] = [];
  for (const step of id.steps) {
    chain.push({ node: step.node, instance: undefined, values: stepValues(step) });
    if (!decideChain(subject, chain, 'read').permit) return false;
  }
  return true;
}

/** A step's key values, or a leaf-list value, as text (`PathStep.values`). */
function stepValues(step: InstanceIdentifier['steps'][number]): Map<string, string> {
  const values = new Map<string, string>();
  for (const k of step.keys ?? []) values.set(k.key.name, valueText(k.value.value));
  if (step.value !== undefined) values.set('.', valueText(step.value.value));
  return values;
}
