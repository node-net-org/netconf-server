/**
 * The read plan (NACM design §5, §7.1): for a session's view of the policy,
 * which parts of a data tree it may read, worked out per schema node so
 * that a read walks only the parts the rules actually divide.
 *
 * For each schema node the plan knows whether the whole subtree is
 * permitted, denied, or mixed. A rule that matches a node also matches its
 * descendants (RFC 8341 §3.4.5 step 6), and a node that can't be read takes
 * its descendants out of the reply with it, so a denial is final. A node is
 * mixed when a rule names particular list entries, or a rule or a
 * `default-deny-all` below it decides differently.
 *
 * A rule naming list entries by key is resolved at the entry: below it the
 * rule either applies outright or not at all. The subtree under the entry
 * then gets a plan of its own, shared by every entry that resolves the
 * rules the same way, so a list of 25,000 entries under one keyed rule
 * needs two.
 *
 * Every verdict agrees with decideData() for read (the tests check this):
 * the plan only decides it once per schema node instead of once per node.
 */

import { DataTree, dataChildren, type InstanceNode, type Schema, type SchemaNode } from '@node-net/yang/core';
import { covers, defaultMark, moduleMatches, type Subject } from './decide.js';
import { chainOf, instanceValue, type PathStep } from './path.js';
import type { Rule, RuleList } from './policy.js';

/** A subtree's read access: all of it, none of it, or decided further down. */
export type ReadAccess = 'permit' | 'deny' | 'mixed';

/** What pruning does with a node: pruneTree's `keep` answers. */
export type KeepVerdict = 'keep' | 'drop' | 'descend';

export interface ReadPlan {
  /** The access to the whole tree. */
  readonly root: ReadAccess;
  /** A pruner for one read. */
  pruner(): Pruner;
  /**
   * Whether every node at and below this schema node is denied, whatever
   * the instance: a provider there needn't be asked for data.
   */
  denies(node: SchemaNode): boolean;
}

/** Prunes the trees of one read. Ask about each node only after its parent. */
export interface Pruner {
  /** @node-net/yang pruneTree's `keep` callback. */
  readonly keep: (node: InstanceNode) => KeepVerdict;
  /** The nodes to take out of a tree, top-down; visits only mixed nodes. */
  readonly drops: (tree: DataTree) => InstanceNode[];
}

/** The plan when nothing is checked: enable-nacm false, or a recovery session. */
export const READ_ALL: ReadPlan = Object.freeze({
  root: 'permit',
  pruner: () => ({ keep: () => 'keep', drops: () => [] }),
  denies: () => false,
});

const plans = new WeakMap<readonly RuleList[], ReadPlan>();

/**
 * The read plan for a session's view of the policy, built once per
 * compiled policy and group set (the rule-lists that apply are cached by
 * both).
 */
export function readPlan(subject: Subject, schema: Schema): ReadPlan {
  if (!subject.policy.enabled || subject.recovery) return READ_ALL;
  let plan = plans.get(subject.ruleLists);
  if (plan === undefined) plans.set(subject.ruleLists, (plan = new Plan(subject, schema)));
  return plan;
}

/** A read rule still in play: `pending` is the index of its first step whose key values aren't resolved yet, or -1. */
interface Active {
  readonly rule: Rule;
  readonly steps: readonly PathStep[] | undefined;
  readonly pending: number;
}

type Decision = 'permit' | 'deny' | 'keyed';

const DATA_KINDS = new Set(['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml']);

class Plan implements ReadPlan {
  readonly root: ReadAccess;
  readonly #top: Context;

  constructor(
    readonly subject: Subject,
    schema: Schema,
  ) {
    const active: Active[] = [];
    for (const list of subject.ruleLists) {
      for (const rule of list.rules) {
        if (!covers(rule, 'read')) continue;
        if (rule.target.type === 'any') active.push({ rule, steps: undefined, pending: -1 });
        else if (rule.target.type === 'data-node' && rule.target.steps !== undefined) active.push({ rule, steps: rule.target.steps, pending: nextKeyed(rule.target.steps, 0) });
      }
    }
    this.#top = new Context(this, active);
    const states = new Set(schema.dataNodes.filter(isData).map((n) => this.#top.state(n)));
    this.root = states.size === 0 ? 'permit' : states.size === 1 ? [...states][0]! : 'mixed';
  }

  pruner(): Pruner {
    const top = this.#top;
    // The context in force below each node the pruner descended into.
    const below = new Map<InstanceNode, Context>();
    const contextOf = (node: InstanceNode): Context => {
      const parent = node.parent;
      if (parent === undefined || parent instanceof DataTree) return top;
      let c = below.get(parent);
      if (c === undefined) {
        keep(parent);
        c = below.get(parent) ?? contextOf(parent);
      }
      return c;
    };
    const keep = (node: InstanceNode): KeepVerdict => {
      let c = contextOf(node);
      let state = c.state(node.schema);
      if (state === 'mixed' && c.resolvesAt(node.schema)) {
        c = c.resolve(node);
        state = c.state(node.schema);
      }
      if (state === 'permit') return 'keep';
      if (state === 'deny') return 'drop';
      below.set(node, c);
      return 'descend';
    };
    const drops = (tree: DataTree): InstanceNode[] => {
      const out: InstanceNode[] = [];
      const walk = (parent: DataTree | InstanceNode, children: readonly InstanceNode[]): void => {
        const keys = parent instanceof DataTree || parent.kind !== 'list' ? undefined : parent.schema.keys;
        for (const c of children) {
          if (keys?.includes(c.schema as never) === true) continue; // a list entry's keys go with it
          const verdict = keep(c);
          if (verdict === 'drop') out.push(c);
          else if (verdict === 'descend' && 'children' in c) walk(c, c.children);
        }
      };
      if (this.root === 'deny') return [...tree.children];
      if (this.root === 'mixed') walk(tree, tree.children);
      return out;
    };
    return { keep, drops };
  }

  denies(node: SchemaNode): boolean {
    return schemaChain(node).some((n) => this.#top.decision(n) === 'deny');
  }
}

/** The rules in play for part of a tree, with what they decide for each schema node there. */
class Context {
  readonly #decisions = new Map<SchemaNode, Decision>();
  readonly #states = new Map<SchemaNode, ReadAccess>();
  readonly #resolvesAt = new Map<SchemaNode, boolean>();
  /** Contexts below an entry of a keyed list, by schema node and by which keyed rules the entry matched. */
  readonly #resolved = new Map<SchemaNode, Map<string, Context>>();

  constructor(
    readonly plan: Plan,
    readonly rules: readonly Active[],
  ) {}

  /** The first matching rule's verdict (§3.4.5 steps 5–7), 'keyed' when it depends on an entry not yet resolved; else the defaults (steps 9, 11). */
  decision(node: SchemaNode): Decision {
    let d = this.#decisions.get(node);
    if (d !== undefined) return d;
    const chain = schemaChain(node);
    d = this.#decide(node, chain);
    this.#decisions.set(node, d);
    return d;
  }

  #decide(node: SchemaNode, chain: readonly SchemaNode[]): Decision {
    for (const a of this.rules) {
      if (!moduleMatches(a.rule, node.module.name)) continue;
      if (a.steps !== undefined) {
        if (a.steps.length > chain.length || !a.steps.every((s, i) => s.node === chain[i])) continue;
        if (a.pending !== -1) return 'keyed';
      }
      return a.rule.action === 'permit' ? 'permit' : 'deny';
    }
    const s = this.plan.subject;
    if (defaultMark(s, chain.map((n) => ({ node: n, instance: undefined }))) === 'all') return 'deny';
    return s.policy.readDefault;
  }

  /** The access to the subtree at a schema node. */
  state(node: SchemaNode): ReadAccess {
    let st = this.#states.get(node);
    if (st !== undefined) return st;
    const d = this.decision(node);
    if (d === 'deny') st = 'deny';
    else {
      st = d === 'permit' ? 'permit' : 'mixed';
      if (st === 'permit') {
        for (const c of dataChildren(node)) {
          if (isData(c) && this.state(c) !== 'permit') {
            st = 'mixed';
            break;
          }
        }
      }
    }
    this.#states.set(node, st);
    return st;
  }

  /** Whether some rule's next unresolved key values are on this schema node. */
  resolvesAt(node: SchemaNode): boolean {
    let r = this.#resolvesAt.get(node);
    if (r === undefined) this.#resolvesAt.set(node, (r = this.rules.some((a) => a.pending !== -1 && a.steps![a.pending]!.node === node)));
    return r;
  }

  /** The context below an entry, with the rules whose key values it names resolved: kept when they match it, dropped when not. */
  resolve(entry: InstanceNode): Context {
    let signature = '';
    const next: Active[] = [];
    for (const a of this.rules) {
      const step = a.pending === -1 ? undefined : a.steps![a.pending]!;
      if (step === undefined || step.node !== entry.schema) {
        next.push(a);
        continue;
      }
      const matches = [...step.values].every(([key, value]) => instanceValue(entry, key) === value);
      signature += matches ? '1' : '0';
      if (matches) next.push({ rule: a.rule, steps: a.steps, pending: nextKeyed(a.steps!, a.pending + 1) });
    }
    let byNode = this.#resolved.get(entry.schema);
    if (byNode === undefined) this.#resolved.set(entry.schema, (byNode = new Map<string, Context>()));
    let c = byNode.get(signature);
    if (c === undefined) byNode.set(signature, (c = new Context(this.plan, next)));
    return c;
  }
}

/** The index of the first step from `from` with key values, or -1. */
function nextKeyed(steps: readonly PathStep[], from: number): number {
  for (let i = from; i < steps.length; i++) if (steps[i]!.values.size > 0) return i;
  return -1;
}

function isData(node: SchemaNode): boolean {
  return DATA_KINDS.has(node.kind);
}

const chains = new WeakMap<SchemaNode, readonly SchemaNode[]>();

/** The data nodes from the top of the schema down to a node. */
function schemaChain(node: SchemaNode): readonly SchemaNode[] {
  let c = chains.get(node);
  if (c === undefined) chains.set(node, (c = chainOf(node).map((l) => l.node)));
  return c;
}
