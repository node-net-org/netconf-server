/**
 * The NACM engine (NACM design §5): compiles and caches the policy, gives
 * each session its view of it, and keeps the denial counters.
 *
 * A Policy is cached by the identity of the `/nacm` instance node: trees
 * are immutable and share structure, so a commit that doesn't touch
 * `/nacm` keeps the node and the cache holds. A session's groups and the
 * rule-lists that apply to them are cached per policy by group set.
 */

import type { Logger } from '@node-net/netconf/core';
import type { ContainerInstance, DataTree, JsonValue, Schema } from '@node-net/yang/core';
import type { Principal } from '../session/session.js';
import { applicableRuleLists, userGroups, type Subject } from './decide.js';
import { compilePolicy, DEFAULT_POLICY, NACM_MODULE, nacmNode, schemaDefaults, type Defaults, type Policy, type RuleList } from './policy.js';

/** NACM's settings for createServer() (NACM design §10). */
export interface NacmOptions {
  /**
   * Whether a session is a recovery session, which NACM doesn't restrict
   * (RFC 8341 §3.3.3): asked once, when the session starts, with the
   * user it authenticated as. Default: no session is.
   */
  readonly recovery?: (principal: Principal) => boolean;
}

/** An access the server refused (NACM design §9). */
export interface AccessDeniedEvent {
  readonly sessionId: number;
  readonly username: string;
  /** What was refused: an operation, a write, a notification or an action. */
  readonly kind: 'operation' | 'write' | 'notification' | 'action';
  /** The operation's name, for an operation or an action. */
  readonly operation?: string;
  /** The data path refused, for a write, a nested notification or an action. */
  readonly path?: string;
}

/** RFC 8341's three counters, from the server's start. */
export interface NacmCounters {
  deniedOperations: number;
  deniedDataWrites: number;
  deniedNotifications: number;
}

interface Cached {
  readonly groups: ReadonlySet<string>;
  readonly ruleLists: readonly RuleList[];
}

export class Nacm {
  /** Whether the schema implements ietf-netconf-acm. */
  readonly implemented: boolean;
  /** Whether access is checked at all: whenever the schema implements ietf-netconf-acm (NACM design §3); enable-nacm then decides at run time. */
  readonly enforced: boolean;
  readonly counters: NacmCounters = { deniedOperations: 0, deniedDataWrites: 0, deniedNotifications: 0 };
  readonly #schema: Schema;
  readonly #defaults: Defaults;
  readonly #logger: Logger;
  readonly #policies = new WeakMap<ContainerInstance, Policy>();
  readonly #subjects = new WeakMap<Policy, Map<string, Cached>>();

  constructor(schema: Schema, logger: Logger) {
    this.#schema = schema;
    this.#logger = logger;
    this.implemented = schema.module(NACM_MODULE)?.implemented === true;
    this.enforced = this.implemented;
    this.#defaults = schemaDefaults(schema);
  }

  /** The policy of a running snapshot, compiled once per `/nacm` node. */
  policy(running: DataTree): Policy {
    const node = nacmNode(running);
    if (node === undefined) return DEFAULT_POLICY;
    let policy = this.#policies.get(node);
    if (policy === undefined) {
      policy = compilePolicy(node, this.#schema);
      this.#policies.set(node, policy);
      for (const w of policy.warnings) this.#logger.warn?.(w);
    }
    return policy;
  }

  /**
   * A session's view of the policy in a running snapshot, for the
   * decisions; undefined when access isn't checked.
   */
  subject(running: DataTree, principal: Principal, recovery: boolean): Subject | undefined {
    if (!this.enforced) return undefined;
    const policy = this.policy(running);
    const groups = userGroups(policy, principal.username, principal.groups);
    const key = JSON.stringify([...groups].sort());
    let byGroups = this.#subjects.get(policy);
    if (byGroups === undefined) this.#subjects.set(policy, (byGroups = new Map<string, Cached>()));
    let cached = byGroups.get(key);
    if (cached === undefined) byGroups.set(key, (cached = { groups, ruleLists: applicableRuleLists(policy, groups) }));
    return { policy, defaults: this.#defaults, recovery, groups: cached.groups, ruleLists: cached.ruleLists };
  }

  /** The counters, as `<operational>` state, when the device implements the module. */
  stateJson(): Record<string, JsonValue> {
    if (!this.implemented) return {};
    const c = this.counters;
    return {
      [`${NACM_MODULE}:nacm`]: {
        'denied-operations': c.deniedOperations,
        'denied-data-writes': c.deniedDataWrites,
        'denied-notifications': c.deniedNotifications,
      },
    };
  }
}
