/**
 * Providers (design §4, PROVIDER-01): optional behaviour registered on a
 * subtree of the schema. The schema says what exists and the datastores hold
 * every node; a provider only adds behaviour (read hooks, a two-phase apply,
 * start-up, RPCs and actions) to the nodes it owns. The deepest registration
 * owns a node; a node no provider owns is unclaimed, and is simply stored.
 */

import { schemaPath, type DataChange, type DataTree, type JsonValue, type RpcNode, type Schema, type SchemaNode } from '@node-net/yang/core';
import type { StartupMode } from '../store/startup.js';

/** What a hook is told about the write it is part of. */
export interface HookContext {
  /**
   * Why running is changing: a session's `edit`, `commit` or `copy`, a
   * confirmed commit's `rollback`, the server undoing a failed transaction
   * (`compensation`), or start-up (`startup`).
   */
  readonly cause: TransactionCause;
  /** The session whose operation this is, if any. */
  readonly sessionId?: number;
  /** The session's user, if any. */
  readonly username?: string;
  /** Aborted when the hook's timeout expires. */
  readonly signal: AbortSignal;
}

export type TransactionCause = 'edit' | 'commit' | 'copy' | 'rollback' | 'compensation' | 'startup';

/** What a provider's prepare returns: how to finish, or undo, what it prepared. */
export interface ProviderTransaction {
  /** Switch over to what prepare staged. Must not fail in normal use (design §6). */
  commit?(signal: AbortSignal): void | Promise<void>;
  /** Drop what prepare staged: another provider refused, or the server failed. */
  abort?(signal: AbortSignal): void | Promise<void>;
}

/** What a read hook is told. */
export interface ReadContext {
  /** The session reading, if any. */
  readonly sessionId?: number;
  readonly username?: string;
  /** Aborted when the hook's timeout expires. */
  readonly signal: AbortSignal;
}

/**
 * Data for a subtree: a @node-net/yang tree, or RFC 7951 JSON for the whole
 * document (`{ "module:top": { ... } }`).
 */
export type SubtreeData = DataTree | Readonly<Record<string, JsonValue>>;

/** What an RPC or action handler is given. */
export interface OperationCall {
  /** The input parameters as RFC 7951 JSON members (`{ "delay": 5 }`), validated. */
  readonly input: Readonly<Record<string, JsonValue>>;
  /** The whole decoded operation tree: for an action, with its data ancestors. */
  readonly tree: DataTree;
  /** For an action: the data path of the instance it was invoked on, with keys. */
  readonly path?: string;
  readonly sessionId: number;
  readonly username: string;
  /** Aborted when the session ends. */
  readonly signal: AbortSignal;
}

/**
 * An RPC or action handler. It returns the output parameters as RFC 7951
 * JSON members, or nothing for `<ok/>`. Throw an RpcFailure for specific
 * rpc-errors; anything else thrown becomes operation-failed with its message.
 */
export type OperationCallHandler = (call: OperationCall) => void | Readonly<Record<string, JsonValue>> | Promise<void | Readonly<Record<string, JsonValue>>>;

/** Per-hook timeouts, in milliseconds. */
export interface HookTimeouts {
  readonly read: number;
  readonly prepare: number;
  readonly commit: number;
  readonly load: number;
}

export const DEFAULT_TIMEOUTS: HookTimeouts = Object.freeze({ read: 10_000, prepare: 10_000, commit: 30_000, load: 60_000 });

/** A provider (design §4). Every member is optional. */
export interface Provider {
  /**
   * Refresh state before a `<get>` or a `<get-data>` of operational whose
   * filter selects this subtree. Return the subtree's new state (it
   * replaces what the provider supplied before), or nothing when the hook
   * pushed its changes with `server.operational.update()`.
   */
  onRead?(context: ReadContext): void | SubtreeData | Promise<void | SubtreeData>;
  /** Answer reads from the last data for this long after a successful read hook, in milliseconds. */
  readonly maxAge?: number;
  /** What a read does when the read hook times out: serve the last data with a warning (`stale`, the default), or fail (`error`). */
  readonly onReadTimeout?: 'stale' | 'error';
  /**
   * The first phase of applying a change to running: check and stage
   * `changes` (only those in this provider's subtree, already validated).
   * Throw to refuse: an RpcFailure for specific rpc-errors, anything else
   * for operation-failed with its message.
   */
  prepare?(changes: readonly DataChange[], context: HookContext): void | ProviderTransaction | Promise<void | ProviderTransaction>;
  /** Paths of providers that must commit before this one. */
  readonly after?: readonly string[];
  /** How this subtree meets the backend at start-up, overriding the server's `startup`. */
  readonly startup?: StartupMode;
  /** The backend's configuration for this subtree, for the `adopt` start-up mode. */
  load?(context: { readonly signal: AbortSignal }): SubtreeData | Promise<SubtreeData>;
  /** Handlers for RPCs of this subtree's module, by `module:name`. */
  readonly rpcs?: Readonly<Record<string, OperationCallHandler>>;
  /** Handlers for actions in this subtree, by schema path (`/module:a/b/reset`). */
  readonly actions?: Readonly<Record<string, OperationCallHandler>>;
  /** Hook timeouts, overriding the server's `providerTimeouts`. */
  readonly timeouts?: Partial<HookTimeouts>;
}

/** A registered provider, as `server.provide()` returns it. */
export interface ProviderHandle {
  /** The schema path the provider is registered on. */
  readonly path: string;
  /** Whether the backend is known to differ from running for this subtree (design §6). */
  readonly outOfSync: boolean;
  /** Why it is out of sync. */
  readonly outOfSyncReason: string | undefined;
  /** Mark the subtree out of sync: the backend drifted and couldn't be reconciled. */
  markOutOfSync(reason: string): void;
  /** Clear the mark after reconciling with the backend. */
  clearOutOfSync(): void;
  /** Remove the provider; its subtree is unclaimed from now on. */
  unregister(): void;
}

/** A change of a provider's out-of-sync mark, as the `outOfSync` event reports it. */
export interface OutOfSyncEvent {
  readonly path: string;
  readonly outOfSync: boolean;
  readonly reason: string | undefined;
}

/** One registration. */
export class Registration implements ProviderHandle {
  outOfSyncReason: string | undefined;
  /** When the read hook last succeeded (clock ms). */
  lastRead: number | undefined;
  /** The read hook run in progress, which concurrent reads share. */
  reading: Promise<void> | undefined;

  constructor(
    readonly path: string,
    readonly node: SchemaNode,
    readonly provider: Provider,
    readonly seq: number,
    readonly timeouts: HookTimeouts,
    readonly startup: StartupMode,
    private readonly registry: Registry,
  ) {}

  get outOfSync(): boolean {
    return this.outOfSyncReason !== undefined;
  }

  markOutOfSync(reason: string): void {
    this.registry.setOutOfSync(this, reason);
  }

  clearOutOfSync(): void {
    this.registry.setOutOfSync(this, undefined);
  }

  unregister(): void {
    this.registry.remove(this);
  }
}

/** The RPC and action handlers providers registered, by RPC node or action schema node. */
export interface OperationHandlers {
  readonly rpcs: ReadonlyMap<RpcNode, { readonly registration: Registration; readonly handler: OperationCallHandler }>;
  readonly actions: ReadonlyMap<SchemaNode, { readonly registration: Registration; readonly handler: OperationCallHandler }>;
}

export interface RegistryOptions {
  readonly schema: Schema;
  readonly startup: StartupMode;
  readonly timeouts: HookTimeouts;
  readonly outOfSync: (event: OutOfSyncEvent) => void;
  /** Called when a registration's RPC handlers are added or removed. */
  readonly operationsChanged: () => void;
}

/** The registered providers. */
export class Registry {
  readonly #byNode = new Map<SchemaNode, Registration>();
  readonly #rpcs = new Map<RpcNode, { registration: Registration; handler: OperationCallHandler }>();
  readonly #actions = new Map<SchemaNode, { registration: Registration; handler: OperationCallHandler }>();
  #seq = 0;

  constructor(private readonly o: RegistryOptions) {}

  /** Every registration, in registration order. */
  get all(): Registration[] {
    return [...this.#byNode.values()].sort((a, b) => a.seq - b.seq);
  }

  get size(): number {
    return this.#byNode.size;
  }

  get operations(): OperationHandlers {
    return { rpcs: this.#rpcs, actions: this.#actions };
  }

  /**
   * Checks and adds a registration (PROVIDER-01, -06, -11; STORE-04 AC2).
   * @throws TypeError naming the path, or the providers in an ordering cycle
   */
  add(path: string, provider: Provider): Registration {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError(`A provider path is a schema data path such as /module:top, not ${JSON.stringify(path)}`);
    const node = this.o.schema.find(path);
    if (node === undefined || !DATA_KINDS.has(node.kind)) throw new TypeError(`${path} is not a data node in the device's schema`);
    const normal = schemaPath(node);
    const existing = this.#byNode.get(node);
    if (existing !== undefined) throw new TypeError(`A provider is already registered at ${normal}`);
    const startup = provider.startup ?? this.o.startup;
    if (startup !== 'push' && startup !== 'adopt') throw new TypeError(`The provider at ${normal}: startup is 'push' or 'adopt', not ${JSON.stringify(startup)}`);
    if (startup === 'adopt' && typeof provider.load !== 'function') throw new TypeError(`The provider at ${normal} uses the adopt start-up mode but has no load function`);
    for (const a of provider.after ?? []) {
      if (this.o.schema.find(a) === undefined) throw new TypeError(`The provider at ${normal} commits after ${a}, which is not in the device's schema`);
    }
    const timeouts = { ...this.o.timeouts, ...provider.timeouts };
    for (const [k, v] of Object.entries(timeouts)) {
      if (!(typeof v === 'number' && v > 0)) throw new TypeError(`The provider at ${normal}: the ${k} timeout must be a positive number of milliseconds`);
    }

    const rpcs = this.#resolveRpcs(normal, node, provider);
    const actions = this.#resolveActions(normal, node, provider);
    const registration = new Registration(normal, node, provider, this.#seq++, timeouts, startup, this);
    this.#byNode.set(node, registration);
    const cycle = this.#cycle();
    if (cycle !== undefined) {
      this.#byNode.delete(node);
      throw new TypeError(`The commit order of the providers at ${cycle.join(', ')} has a cycle`);
    }
    for (const r of rpcs) this.#rpcs.set(r.node, { registration, handler: r.handler });
    for (const a of actions) this.#actions.set(a.node, { registration, handler: a.handler });
    if (rpcs.length > 0 || actions.length > 0) this.o.operationsChanged();
    return registration;
  }

  remove(r: Registration): void {
    if (this.#byNode.get(r.node) !== r) return;
    this.#byNode.delete(r.node);
    let changed = false;
    for (const [k, v] of this.#rpcs) if (v.registration === r) changed = this.#rpcs.delete(k);
    for (const [k, v] of this.#actions) if (v.registration === r) changed = this.#actions.delete(k) || changed;
    if (changed) this.o.operationsChanged();
  }

  setOutOfSync(r: Registration, reason: string | undefined): void {
    if (r.outOfSyncReason === reason) return;
    r.outOfSyncReason = reason;
    this.o.outOfSync({ path: r.path, outOfSync: reason !== undefined, reason });
  }

  /** The registration on exactly this schema node. */
  at(node: SchemaNode): Registration | undefined {
    return this.#byNode.get(node);
  }

  /** The provider that owns a schema node: the deepest registration at or above it. */
  ownerOf(node: SchemaNode): Registration | undefined {
    for (let n: SchemaNode | undefined = node; n !== undefined; n = n.parent) {
      const r = this.#byNode.get(n);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  /** Whether any registration is strictly below a schema node. */
  hasBelow(node: SchemaNode): boolean {
    for (const r of this.#byNode.values()) {
      for (let n = r.node.parent; n !== undefined; n = n.parent) if (n === node) return true;
    }
    return false;
  }

  /**
   * Registrations in commit order (PROVIDER-06): those each one names in
   * `after` first, otherwise registration order.
   */
  commitOrder(registrations: readonly Registration[]): Registration[] {
    const set = new Set(registrations);
    const pending = [...registrations].sort((a, b) => a.seq - b.seq);
    const done = new Set<Registration>();
    const out: Registration[] = [];
    while (pending.length > 0) {
      const i = pending.findIndex((r) => this.#predecessors(r).every((p) => !set.has(p) || done.has(p)));
      // No cycles get past add(); fall back to registration order if one somehow did.
      const [next] = pending.splice(i === -1 ? 0 : i, 1);
      done.add(next!);
      out.push(next!);
    }
    return out;
  }

  #predecessors(r: Registration): Registration[] {
    const out: Registration[] = [];
    for (const a of r.provider.after ?? []) {
      const node = this.o.schema.find(a);
      const p = node === undefined ? undefined : this.#byNode.get(node);
      if (p !== undefined && p !== r) out.push(p);
    }
    return out;
  }

  /** The paths of providers in an ordering cycle, if there is one. */
  #cycle(): string[] | undefined {
    const state = new Map<Registration, 'visiting' | 'done'>();
    const stack: Registration[] = [];
    const visit = (r: Registration): string[] | undefined => {
      const s = state.get(r);
      if (s === 'done') return undefined;
      if (s === 'visiting') return stack.slice(stack.indexOf(r)).map((x) => x.path);
      state.set(r, 'visiting');
      stack.push(r);
      for (const p of this.#predecessors(r)) {
        const found = visit(p);
        if (found !== undefined) return found;
      }
      stack.pop();
      state.set(r, 'done');
      return undefined;
    };
    for (const r of this.all) {
      const found = visit(r);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  #resolveRpcs(path: string, node: SchemaNode, provider: Provider): { node: RpcNode; handler: OperationCallHandler }[] {
    const out: { node: RpcNode; handler: OperationCallHandler }[] = [];
    for (const [name, handler] of Object.entries(provider.rpcs ?? {})) {
      const colon = name.indexOf(':');
      const rpc = this.o.schema.rpcs.find((r) => r.module.name === name.slice(0, colon) && r.name === name.slice(colon + 1));
      if (colon === -1 || rpc === undefined) throw new TypeError(`The provider at ${path} handles ${name}, which is not an RPC in the device's schema`);
      if (rpc.module !== node.module) throw new TypeError(`The provider at ${path} handles ${name}, which is not in its subtree's module ${node.module.name}`);
      if (typeof handler !== 'function') throw new TypeError(`The provider at ${path}: the handler for ${name} is not a function`);
      if (this.#rpcs.has(rpc)) throw new TypeError(`The provider at ${path} handles ${name}, which the provider at ${this.#rpcs.get(rpc)!.registration.path} already handles`);
      out.push({ node: rpc, handler });
    }
    return out;
  }

  #resolveActions(path: string, node: SchemaNode, provider: Provider): { node: SchemaNode; handler: OperationCallHandler }[] {
    const out: { node: SchemaNode; handler: OperationCallHandler }[] = [];
    for (const [actionPath, handler] of Object.entries(provider.actions ?? {})) {
      const action = this.o.schema.find(actionPath);
      if (action === undefined || action.kind !== 'action') throw new TypeError(`The provider at ${path} handles ${actionPath}, which is not an action in the device's schema`);
      let inside = false;
      for (let n = action.parent; n !== undefined && !inside; n = n.parent) inside = n === node;
      if (!inside) throw new TypeError(`The provider at ${path} handles ${actionPath}, which is not in its subtree`);
      if (typeof handler !== 'function') throw new TypeError(`The provider at ${path}: the handler for ${actionPath} is not a function`);
      if (this.#actions.has(action)) throw new TypeError(`The provider at ${path} handles ${actionPath}, which the provider at ${this.#actions.get(action)!.registration.path} already handles`);
      out.push({ node: action, handler });
    }
    return out;
  }
}

const DATA_KINDS: ReadonlySet<string> = new Set(['container', 'list', 'leaf', 'leaf-list', 'anydata', 'anyxml']);
