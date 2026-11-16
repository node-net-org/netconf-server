/**
 * The server (design §14): a loaded device, its sessions, and the ways in.
 * Everything here runs in any JavaScript runtime; listeners that need Node
 * (SSH, in the root entry) plug in through listen().
 */

import { connectionPair, type Connection, type ConnectionFactory, type Logger } from '@node-net/netconf/core';
import { DataTree, decodeJson, encodeJson as encodeJsonTree, ListEntry, validate, YangDataError, type DataChange, type InstanceNode, type JsonValue, type ModuleSource } from '@node-net/yang/core';
import type { Listener, ServeOptions } from './auth.js';

export type { ServeOptions } from './auth.js';
import { Control, CONTROL_PATH, controlProvider, type ControlOptions, type ServerControl } from './control/control.js';
import { FaultTable } from './control/faults.js';
import { CONFIG_CHANGE, CONFIRMED_COMMIT, configChange, confirmedCommit, SESSION_END, SESSION_START, sessionEnd, sessionStart, type SessionParms } from './notify/base.js';
import { NETCONF_STREAM, NotificationBus } from './notify/bus.js';
import { QuirkState } from './quirks/state.js';
import { errorReply } from './rpc/dispatch.js';
import { Nacm, type AccessDeniedEvent, type NacmOptions } from './nacm/engine.js';
import { registerNotificationOperations } from './rpc/notifications.js';
import { Reader } from './rpc/reads.js';
import { systemClock, type Clock } from './clock.js';
import type { DeviceDefinition } from './device/definition.js';
import { loadDevice, withControl, type Device } from './device/load.js';
import { Emitter } from './events.js';
import { Datastores, type StartTrees } from './datastore/datastores.js';
import { LockTable, type LockChangedEvent, type Locks } from './datastore/locks.js';
import { OperationalState, type StateChangedEvent, type StateEdit } from './datastore/operational.js';
import { Writer, type CommitEvent } from './datastore/writer.js';
import { Operations } from './provider/operations.js';
import { DEFAULT_TIMEOUTS, Registry, type HookTimeouts, type OutOfSyncEvent, type Provider, type ProviderHandle, type Registration } from './provider/provider.js';
import { ReadHooks } from './provider/reads.js';
import { adopt, checkStartup, loadSubtree, push } from './provider/startup.js';
import { Transactions } from './provider/transaction.js';
import { Dispatcher, type OperationHandler } from './rpc/dispatch.js';
import { registerGetSchema } from './rpc/get-schema.js';
import { registerReadOperations } from './rpc/reads.js';
import { registerSessionOperations } from './rpc/sessions.js';
import { registerWriteOperations } from './rpc/writes.js';
import { DeviceError } from './errors.js';
import { startTrees, type StartupMode } from './store/startup.js';
import { memoryStore, type Store } from './store/store.js';
import { yangLibraryJson } from './state/library.js';
import { monitoringJson, newCounters, providersJson, type MonitoredSession, type ServerStatistics } from './state/monitoring.js';
import { MAX_SESSION_ID, ServerSession, type Principal, type SessionEndReason, type SessionHost } from './session/session.js';

export interface ServerOptions {
  /** The device to emulate: loaded with loadDevice() or loadDeviceFile(), or a definition object to load. */
  readonly device: Device | DeviceDefinition;
  /** Where to find the device's modules, when `device` is a definition object. */
  readonly source?: ModuleSource;
  /** Every timer and timestamp goes through this. Default: the runtime's clock. */
  readonly clock?: Clock;
  /** @node-net/netconf's Logger. Default: log nothing. */
  readonly logger?: Logger;
  /** How long a new connection has to send its hello, in milliseconds. Default 60 000. */
  readonly helloTimeout?: number;
  /** Largest message accepted, in bytes; a larger one ends the session. Default: @node-net/netconf's (64 MiB). */
  readonly maxMessageBytes?: number;
  /**
   * Where the configuration is saved across restarts (design §9): startup
   * with :startup, otherwise running. Default: a new memoryStore(), so the
   * server starts from the device's initial data. fileStore() (Node only)
   * saves to a state directory.
   */
  readonly store?: Store;
  /**
   * How saved configuration meets the providers' backends at start-up
   * (design §9): `push` (the default) gives it to them through prepare and
   * commit; `adopt` takes each provider's own configuration from its
   * load(). A provider's own `startup` overrides this.
   */
  readonly startup?: StartupMode;
  /**
   * Providers to register before the server starts, so their start-up
   * modes run before any session can open. `provide()` registers more later.
   */
  readonly providers?: readonly { readonly path: string; readonly provider: Provider }[];
  /** Default hook timeouts in milliseconds: read and prepare 10 000, commit 30 000, load 60 000. */
  readonly providerTimeouts?: Partial<HookTimeouts>;
  /**
   * Configuration no provider claims (design §4.1): stored like any other
   * (`store`, the default), or refused with operation-not-supported (`reject`).
   */
  readonly unclaimed?: 'store' | 'reject';
  /**
   * The control module (design §14.1): on by default when no providers are
   * given here, off when any are. Providers registered later with provide()
   * don't change it.
   */
  readonly control?: ControlOptions;
  /**
   * NACM (RFC 8341, NACM design §4): which sessions are recovery sessions.
   * The policy itself is the device's ietf-netconf-acm configuration.
   */
  readonly nacm?: NacmOptions;
}

/** When a notification is sent, for server.notify(). */
export interface NotifyOptions {
  /** The eventTime, in milliseconds since the epoch. Default: the server's clock. */
  readonly eventTime?: number;
}

/** Changes to running from outside NETCONF (design §7). */
export interface RunningDatastore {
  /**
   * Apply a change the backend made by another route: an edit (a @node-net/yang
   * edit tree, or RFC 7951 JSON with NETCONF edit annotations), validated
   * and applied whole, after any write in progress. Locks don't stop it and
   * providers aren't called.
   * @throws YangDataError with every problem; running is unchanged
   */
  applyExternal(edit: DataTree | Readonly<Record<string, JsonValue>>, options: { readonly source: string }): Promise<readonly DataChange[]>;
}

/** The state the server holds for `<operational>` (design §5). */
export interface OperationalDatastore {
  /** The held state: the device's operational file, pushed updates and read hooks' results. */
  readonly state: DataTree;
  /**
   * Push a state update (PROVIDER-04): an edit of the state, validated.
   * Configuration only appears as structure, or with an origin of system or learned.
   * @throws YangDataError with every problem; the state is unchanged
   */
  update(edit: StateEdit): void;
}

export interface SessionStartEvent {
  readonly sessionId: number;
  readonly username: string;
  readonly transport: string;
}

export interface SessionEndEvent {
  readonly sessionId: number;
  readonly username: string;
  readonly transport: string;
  readonly reason: SessionEndReason;
  /** The session that killed this one, when the reason is `killed`. */
  readonly killedBy?: number;
}

export interface ServerEvents {
  sessionStart: SessionStartEvent;
  sessionEnd: SessionEndEvent;
  /** A datastore was locked or unlocked (design §7: embedding code may hold its backend back while a lock is held). */
  lockChanged: LockChangedEvent;
  /** Running changed: an edit, a commit, a copy-config, a confirmed commit rolled back, a change from outside, or an adopting provider. */
  commit: CommitEvent;
  /** The held operational state changed: a pushed update or a read hook's result. */
  stateChanged: StateChangedEvent;
  /** A provider's subtree was marked out of sync with its backend, or the mark was cleared. */
  outOfSync: OutOfSyncEvent;
  /** NACM refused an access (NACM design §9). */
  accessDenied: AccessDeniedEvent;
}

/** An open session, as the server reports it. */
export interface SessionInfo {
  readonly id: number;
  readonly username: string;
  readonly transport: string;
  readonly version: '1.0' | '1.1';
}

export interface TransportOptions {
  /** Who in-process sessions are authenticated as. Default `{ username: 'local' }`. */
  readonly principal?: Principal;
}

const DEFAULT_PRINCIPAL: Principal = Object.freeze({ username: 'local' });
const CLIENT_PEER = Object.freeze({ host: '@node-net/netconf-server', port: 0 });
const SERVER_PEER = Object.freeze({ host: 'in-process', port: 0 });

/** Creates a server for a device. */
export async function createServer(options: ServerOptions): Promise<NetconfServer> {
  const control = options.control?.enabled ?? (options.providers ?? []).length === 0;
  const device = isDevice(options.device)
    ? await withControl(options.device, control)
    : await loadDevice(options.device, { ...(options.source === undefined ? {} : { source: options.source }), control });
  const mode = options.startup ?? 'push';
  if (mode !== 'push' && mode !== 'adopt') throw new TypeError(`startup is 'push' or 'adopt', not ${JSON.stringify(mode)}`);
  const store = options.store ?? memoryStore();
  const start = await startTrees(device, store);
  const server = new NetconfServer(device, { ...options, store }, start);
  try {
    await server[START](options.providers ?? [], start, store);
  } catch (err) {
    await server.close();
    throw err;
  }
  return server;
}

/** Runs the providers' start-up; createServer() calls it before returning the server. */
const START = Symbol('start');

export class NetconfServer extends Emitter<ServerEvents> {
  readonly device: Device;
  readonly clock: Clock;
  readonly #logger: Logger;
  readonly #dispatcher: Dispatcher;
  /** The datastores (design §5). */
  readonly #datastores: Datastores;
  readonly #locks: LockTable;
  readonly #writer: Writer;
  readonly #registry: Registry;
  readonly #state: OperationalState;
  readonly #transactions: Transactions;
  readonly #operations: Operations;
  readonly #stats: ServerStatistics;
  readonly #bus: NotificationBus;
  readonly #quirks: QuirkState;
  readonly #faults = new FaultTable();
  readonly #control: Control | undefined;
  readonly #controlUsers: readonly string[] | undefined;
  readonly #nacm: Nacm;
  /** Every session with a connection, open or still in its hello. */
  readonly #sessions = new Map<number, ServerSession>();
  readonly #host: SessionHost;
  #nextId = 1;
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly #listeners = new Set<Listener>();

  /** @internal Use createServer(). */
  constructor(device: Device, options: Omit<ServerOptions, 'device'> = {}, start?: StartTrees) {
    const logger = options.logger ?? {};
    super(logger);
    this.device = device;
    this.clock = options.clock ?? systemClock;
    this.#logger = logger;
    this.#dispatcher = new Dispatcher(device.schema, logger);
    this.#nacm = new Nacm(device.schema, logger);
    const recovery = options.nacm?.recovery;
    if (recovery !== undefined && typeof recovery !== 'function') throw new TypeError('nacm.recovery is a function');
    this.#stats = { ...newCounters(), startTime: this.clock.now(), inBadHellos: 0, inSessions: 0, droppedSessions: 0 };
    if (options.unclaimed !== undefined && options.unclaimed !== 'store' && options.unclaimed !== 'reject') {
      throw new TypeError(`unclaimed is 'store' or 'reject', not ${JSON.stringify(options.unclaimed)}`);
    }
    this.#registry = new Registry({
      schema: device.schema,
      startup: options.startup ?? 'push',
      timeouts: { ...DEFAULT_TIMEOUTS, ...options.providerTimeouts },
      outOfSync: (event) => this.emit('outOfSync', event),
      operationsChanged: () => this.#operations.sync(),
    });
    this.#state = new OperationalState(device.schema.forDatastore('operational'), device.initial.operational, this.#registry);
    this.#datastores = new Datastores(
      device,
      [
        () => yangLibraryJson(device),
        () => monitoringJson(device, this.#monitored(), this.#stats, this.#locks.list()),
        () => providersJson(this.#registry.all),
        () => streamsJson(device),
        () => this.#nacm.stateJson(),
      ],
      start,
      () => this.#state.tree,
    );
    this.#quirks = new QuirkState(device.definition.quirks);
    this.#controlUsers = device.control ? options.control?.users : undefined;
    this.#locks = new LockTable((event) => this.emit('lockChanged', event));
    this.#transactions = new Transactions({ registry: this.#registry, schema: device.schema, clock: this.clock, logger, unclaimed: options.unclaimed ?? 'store' });
    this.#writer = new Writer({
      device,
      datastores: this.#datastores,
      locks: this.#locks,
      store: options.store ?? memoryStore(),
      clock: this.clock,
      logger,
      committed: (event) => {
        this.emit('commit', event);
        // A write that changed nothing (a replace with the same content) is no change to report.
        if (event.changes.length > 0) this.#publishBase(CONFIG_CHANGE, () => configChange(event, this.#parms(event.sessionId, event.username)));
      },
      transactions: this.#transactions,
      username: (id) => this.#sessions.get(id)?.principal.username,
      confirmedCommit: (event) => this.#publishBase(CONFIRMED_COMMIT, () => confirmedCommit(event, this.#parms(event.sessionId, event.username))),
      writeDenied: (sessionId, denied) => {
        this.#nacm.counters.deniedDataWrites++;
        const username = this.#sessions.get(sessionId)?.principal.username ?? '';
        const path = denied.node.path;
        this.#logger.info?.('Access denied', { sessionId, username, write: denied.access, path, ...(denied.verdict.rule === undefined ? {} : { rule: denied.verdict.rule }), step: denied.verdict.step });
        this.emit('accessDenied', { sessionId, username, kind: 'write', path });
      },
    });
    const hooks = new ReadHooks({
      registry: this.#registry,
      state: this.#state,
      schema: device.schema,
      clock: this.clock,
      logger,
      stateChanged: (event) => this.emit('stateChanged', event),
    });
    this.#dispatcher.access({
      subject: (session) => (session.recovery ? undefined : this.#nacm.subject(this.#datastores.running, session.principal, false)),
      denied: (session, rpc, verdict) => {
        this.#nacm.counters.deniedOperations++;
        this.#logger.info?.('Access denied', {
          sessionId: session.id,
          username: session.principal.username,
          operation: rpc.name,
          module: rpc.module.name,
          ...(verdict.rule === undefined ? {} : { rule: verdict.rule }),
          step: verdict.step,
        });
        this.emit('accessDenied', { sessionId: session.id, username: session.principal.username, kind: 'operation', operation: rpc.name });
      },
    });
    registerSessionOperations(this.#dispatcher, { session: (id) => this.#open(id), clock: this.clock });
    registerReadOperations(this.#dispatcher, device, this.#datastores, hooks);
    registerWriteOperations(this.#dispatcher, device, this.#datastores, this.#writer);
    registerGetSchema(this.#dispatcher, device);
    // With NACM, the policy in running when the notification is sent decides (NACM design §8).
    this.#bus = new NotificationBus(new Reader(device, this.#datastores), logger, !this.#nacm.enforced ? undefined : {
      subject: (session) => (session.recovery ? undefined : this.#nacm.subject(this.#datastores.running, session.principal, false)),
      denied: (session, denial) => {
        this.#nacm.counters.deniedNotifications++;
        const username = session.principal.username;
        const path = denial.path === undefined ? {} : { path: denial.path };
        const rule = denial.verdict.rule === undefined ? {} : { rule: denial.verdict.rule };
        this.#logger.info?.('Access denied', { sessionId: session.id, username, notification: denial.name, ...path, ...rule, step: denial.verdict.step });
        this.emit('accessDenied', { sessionId: session.id, username, kind: 'notification', operation: denial.name, ...path });
      },
    });
    registerNotificationOperations(this.#dispatcher, device, new Reader(device, this.#datastores), this.#bus);
    this.#control = device.control ? new Control(this.#controlHost()) : undefined;
    this.#operations = new Operations({
      dispatcher: this.#dispatcher,
      registry: this.#registry,
      schema: device.schema,
      datastores: this.#datastores,
      logger,
      actionDenied: (session, action, path, verdict) => {
        this.#nacm.counters.deniedOperations++;
        const username = session.principal.username;
        this.#logger.info?.('Access denied', { sessionId: session.id, username, action: action.name, module: action.module.name, path, ...(verdict.rule === undefined ? {} : { rule: verdict.rule }), step: verdict.step });
        this.emit('accessDenied', { sessionId: session.id, username, kind: 'action', operation: action.name, path });
      },
    });

    this.#host = {
      device,
      clock: this.clock,
      logger,
      helloTimeout: options.helloTimeout ?? 60_000,
      maxMessageBytes: options.maxMessageBytes,
      allocateSessionId: () => this.#allocateId(),
      isControlUser: (principal) => this.#controlUsers?.includes(principal.username) === true,
      isRecovery: (principal) => {
        if (recovery === undefined) return false;
        try {
          return recovery(principal) === true;
        } catch (err) {
          this.#logger.error?.('nacm.recovery threw; the session is not a recovery session', { username: principal.username, error: (err as Error).message });
          return false;
        }
      },
      newSessionQuirks: () => this.#quirks.forNewSession(),
      quirks: (session) => this.#quirks.forSession(session.id, session.openedQuirks),
      hasFaults: () => this.#faults.size > 0,
      fault: (session, point) => {
        const s = { id: session.id, username: session.principal.username, exempt: session.exempt };
        return point.kind === 'connect' ? this.#faults.connected(s) : this.#faults.take(s, point);
      },
      errorReply: (request, errors) => errorReply(request, errors),
      errorSent: (session) => {
        session.counters.outRpcErrors++;
        this.#stats.outRpcErrors++;
      },
      notificationSent: () => {
        this.#stats.outNotifications++;
      },
      sessionStarted: (session) => {
        this.#stats.inSessions++;
        this.#logger.info?.('Session started', { sessionId: session.id, username: session.principal.username, transport: session.transport });
        this.emit('sessionStart', { sessionId: session.id, username: session.principal.username, transport: session.transport });
        this.#publishBase(SESSION_START, () => sessionStart(sessionParms(session)));
      },
      badHello: () => {
        this.#stats.inBadHellos++;
      },
      sessionEnded: (session, reason, killedBy) => {
        this.#sessions.delete(session.id);
        if (session.version === undefined) return;
        if (reason === 'dropped') this.#stats.droppedSessions++;
        this.#bus.sessionEnded(session.id);
        this.#faults.sessionEnded(session.id);
        this.#quirks.sessionEnded(session.id);
        this.#writer.sessionEnded(session.id, session.principal.username);
        this.#logger.info?.('Session ended', { sessionId: session.id, username: session.principal.username, reason, ...(killedBy === undefined ? {} : { killedBy }) });
        this.emit('sessionEnd', {
          sessionId: session.id,
          username: session.principal.username,
          transport: session.transport,
          reason,
          ...(killedBy === undefined ? {} : { killedBy }),
        });
        this.#publishBase(SESSION_END, () => sessionEnd(sessionParms(session), reason, killedBy));
      },
      answer: (session, text) =>
        this.#dispatcher.answer(session, text, (correct) => {
          const counter = correct ? 'inRpcs' : 'inBadRpcs';
          session.counters[counter]++;
          this.#stats[counter]++;
        }),
    };
  }

  /**
   * Register a provider on a subtree (design §4, PROVIDER-01). Resolves once
   * it is in step: under push, its subtree of running has gone through its
   * prepare and commit; under adopt, its load() has replaced that subtree.
   * Rejects, leaving nothing registered, when the registration is wrong (a
   * path not in the schema, one already registered, adopt without load, a
   * commit-order cycle, an RPC or action outside its subtree) or the
   * provider refuses its configuration.
   */
  async provide(path: string, provider: Provider): Promise<ProviderHandle> {
    if (this.#closed) throw new Error('The server is closed');
    const r = this.#registry.add(path, provider);
    try {
      const loaded = r.startup === 'adopt' ? await loadSubtree(r, this.device.schema.forDatastore('running'), this.clock) : undefined;
      await this.#writer.start(r, (running) => {
        if (loaded === undefined) return undefined;
        const next = adopt(running, new Map([[r, loaded]]), this.#registry);
        const errors = validateTree(next);
        if (errors.length > 0) throw new YangDataError(errors);
        return next;
      });
    } catch (err) {
      r.unregister();
      throw err;
    }
    return r;
  }

  /** Changes to running from outside NETCONF (design §7). */
  get running(): RunningDatastore {
    return {
      applyExternal: (edit, options) => {
        const source = options?.source;
        if (typeof source !== 'string' || source === '') return Promise.reject(new TypeError('applyExternal needs a source naming where the change came from'));
        let tree: DataTree;
        try {
          tree = edit instanceof DataTree ? edit : decodeJson(this.device.schema.forDatastore('running'), edit, { edit: true });
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
        return this.#writer.external(tree, source);
      },
    };
  }

  /** The state the server holds for `<operational>`, and the way to push updates to it (PROVIDER-04). */
  get operational(): OperationalDatastore {
    return {
      state: this.#state.tree,
      update: (edit) => {
        const paths = this.#state.update(edit);
        if (paths.length > 0) this.emit('stateChanged', { paths });
      },
    };
  }

  /**
   * Send a notification (NOTIF-04, design §12) to every subscription whose
   * filter selects it. `path` is the notification's schema path
   * (`/module:name`), or for a YANG 1.1 notification nested in data, the
   * data path of its parent instance followed by its name. `content` is
   * RFC 7951 JSON (or a @node-net/yang notification tree, when `path` is
   * ignored). It is validated against the schema and the current
   * `<operational>` data, so a nested notification's parent must exist;
   * nothing is sent when it is invalid.
   * @throws YangDataError with every problem
   * @throws TypeError when the device has no :notification
   */
  notify(path: string, content: Readonly<Record<string, JsonValue>> | DataTree = {}, options: NotifyOptions = {}): void {
    if (!this.device.protocol.notification) throw new TypeError(`Device ${this.device.id} has no :notification capability`);
    const operational = this.#datastores.operational();
    let tree: DataTree;
    if (content instanceof DataTree) {
      if (content.kind !== 'notification') throw new TypeError('A notification tree has kind notification');
      const errors = validate(content, { operational }).filter((i) => i.severity === 'error');
      if (errors.length > 0) throw new YangDataError(errors);
      tree = content;
    } else {
      tree = decodeJson(this.device.schema, content, { type: 'notification', operation: path, validate: { operational } });
    }
    this.#bus.publish(tree, options.eventTime ?? this.clock.now());
  }

  /** The control module's operations in process (design §14.1), when the server implements it. */
  get control(): ServerControl | undefined {
    return this.#control;
  }

  /** The registered providers, in registration order. */
  get providers(): ProviderHandle[] {
    return this.#registry.all;
  }

  /** @internal Start-up with the providers given to createServer(). */
  async [START](providers: readonly { readonly path: string; readonly provider: Provider }[], start: StartTrees, store: Store): Promise<void> {
    await this.#startProviders(providers, start, store);
    // The control module is an ordinary provider (design §14.1).
    if (this.#control !== undefined) {
      await this.provide(CONTROL_PATH, controlProvider(this.#control, { users: this.#controlUsers, session: (id) => this.#open(id) }));
    }
  }

  async #startProviders(providers: readonly { readonly path: string; readonly provider: Provider }[], start: StartTrees, store: Store): Promise<void> {
    if (providers.length === 0) return;
    const registrations: Registration[] = providers.map(({ path, provider }) => this.#registry.add(path, provider));
    const running = this.device.schema.forDatastore('running');
    const loaded = new Map<Registration, DataTree>();
    for (const r of registrations.filter((x) => x.startup === 'adopt')) {
      try {
        loaded.set(r, await loadSubtree(r, running, this.clock));
      } catch (err) {
        throw new DeviceError(`Can't start: the provider at ${r.path} could not load its configuration`, [{ path: r.path, message: (err as Error).message }], { cause: err });
      }
    }
    let tree = this.#datastores.running;
    if (loaded.size > 0) {
      const saved = this.device.protocol.startup ? 'startup' : 'running';
      const other = start.running === this.device.initial.running ? 'the device definition' : (store.describe?.(saved) ?? `${store.location} (${saved})`);
      tree = adopt(tree, loaded, this.#registry);
      checkStartup(tree, new Set(loaded.keys()), this.#registry, this.device.schema, other);
      // The backend's configuration replaces the saved copy (design §9).
      if (saved === 'startup' && start.startup !== undefined) {
        const startup = adopt(start.startup, loaded, this.#registry);
        await store.save('startup', JSON.stringify(encodeJsonTree(startup), null, 2));
        this.#datastores.setStartup(startup);
      } else await store.save('running', JSON.stringify(encodeJsonTree(tree), null, 2));
      this.#datastores.setRunning(tree);
    }
    await push(tree, registrations, this.#transactions);
  }

  /** The datastore locks (design §7), for embedding code that holds its backend back while one is held. */
  get locks(): Locks {
    return this.#locks;
  }

  /** The open sessions: those that have exchanged hellos. */
  get sessions(): SessionInfo[] {
    return [...this.#sessions.values()]
      .filter((s) => s.version !== undefined && !s.ended)
      .map((s) => ({ id: s.id, username: s.principal.username, transport: s.transport, version: s.version! }));
  }

  /**
   * A connection factory for @node-net/netconf's `connect({ transport })`: each
   * call opens a new in-process session, with no network listener.
   */
  transport(options: TransportOptions = {}): ConnectionFactory {
    const principal = options.principal ?? DEFAULT_PRINCIPAL;
    return (signal) => {
      if (signal.aborted) return Promise.reject(signal.reason as Error);
      if (this.#closed) return Promise.reject(new Error('The server is closed'));
      const [client, server] = connectionPair({ client: CLIENT_PEER, server: SERVER_PEER });
      this.serve(server, { principal, transport: 'in-process' });
      return Promise.resolve(client);
    };
  }

  /**
   * Serve a NETCONF session on a connection that is already authenticated.
   * Transports call this; tests can use it with one end of a connectionPair().
   * @throws Error if the server is closed.
   */
  serve(connection: Connection, options: ServeOptions): void {
    if (this.#closed) {
      connection.destroy();
      throw new Error('The server is closed');
    }
    const session = new ServerSession(connection, this.#host, options.principal, options.transport, options.sourceHost);
    this.#sessions.set(session.id, session);
  }

  /** Handle an operation the schema defines. @internal until providers (M3) define the public way. */
  handle(namespace: string, name: string, handler: OperationHandler): void {
    this.#dispatcher.handle(namespace, name, handler);
  }

  /**
   * Start a listener (such as the SSH listener) that hands its connections
   * to serve(). close() closes it.
   * @throws Error if the server is closed, or what the listener's start throws.
   */
  async listen(listener: Listener): Promise<void> {
    if (this.#closed) throw new Error('The server is closed');
    this.#listeners.add(listener);
    try {
      await listener.start((connection, options) => this.serve(connection, options));
    } catch (err) {
      this.#listeners.delete(listener);
      throw err;
    }
  }

  /**
   * Shut down (NNCD-05): stop the listeners, let the write in progress and
   * requests already received finish, then end every session. As when a
   * session ends, a confirmed commit without persist is rolled back; the
   * promise resolves once that is done. Idempotent.
   */
  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#listeners].map((l) =>
        l.close().catch((err: unknown) => this.#logger.error?.('A listener failed to close', { error: (err as Error).message })),
      ),
    );
    this.#listeners.clear();
    // The write in progress (and any queued behind it), then the replies they owe.
    await this.#writer.queue.run(() => undefined);
    await Promise.all([...this.#sessions.values()].map((s) => s.settled()));
    for (const session of [...this.#sessions.values()]) {
      session.end('closed');
    }
    // Rollbacks of confirmed commits whose sessions just ended.
    await this.#writer.queue.run(() => undefined);
    this.#writer.close();
  }

  /** The open sessions, as NETCONF monitoring reports them. */
  #monitored(): MonitoredSession[] {
    return [...this.#sessions.values()]
      .filter((s) => s.version !== undefined && !s.ended)
      .map((s) => ({ id: s.id, transport: s.transport, username: s.principal.username, sourceHost: s.sourceHost, loginTime: s.loginTime, counters: s.counters, recovery: s.recovery }));
  }

  /**
   * Sends a base notification (RFC 6470) when anyone is subscribed. It is
   * decoded, so its types are checked, but not validated against data:
   * netconf-config-change's edit targets are instance-identifiers, and a
   * deleted node's no longer exists.
   */
  #publishBase(path: string, content: () => Record<string, JsonValue>): void {
    if (this.#bus.size === 0) return;
    try {
      const tree = decodeJson(this.device.schema, content(), { type: 'notification', operation: path });
      this.#bus.publish(tree, this.clock.now());
    } catch (err) {
      const detail = err instanceof YangDataError ? err.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : (err as Error).message;
      this.#logger.error?.(`Could not send ${path}`, { error: detail });
    }
  }

  /** RFC 6470's session parameters for a session, or undefined for the server. */
  #parms(sessionId: number | undefined, username: string | undefined): SessionParms | undefined {
    if (sessionId === undefined) return undefined;
    const s = this.#sessions.get(sessionId);
    return { username: username ?? s?.principal.username ?? '', sessionId, sourceHost: s?.sourceHost };
  }

  #controlHost(): ConstructorParameters<typeof Control>[0] {
    return {
      device: this.device,
      faults: this.#faults,
      quirks: this.#quirks,
      now: () => this.clock.now(),
      sessions: () => [...this.#sessions.values()].filter((s) => s.version !== undefined && !s.ended),
      session: (id) => this.#open(id),
      trees: () => ({ running: this.#datastores.running, startup: this.#datastores.has('startup') ? this.#datastores.config('startup') : undefined, state: this.#state.tree }),
      restoreConfig: (running, startup, releaseLocks, by) => this.#writer.restore({ running, startup, releaseLocks }, by),
      restoreState: (state) => {
        const paths = this.#state.restore(state);
        if (paths.length > 0) this.emit('stateChanged', { paths });
      },
      updateState: (edit) => {
        const tree = edit instanceof DataTree ? edit : decodeJson(this.device.schema.forDatastore('operational'), edit, { edit: true });
        const config = [...tree.walk()].filter((n) => n.schema.config && (n.schema.kind === 'leaf' || n.schema.kind === 'leaf-list') && !isKey(n));
        if (config.length > 0) throw new YangDataError(config.map((n) => ({ code: 'invalid-value', severity: 'error' as const, path: n.path, message: 'set-state changes state data only; this is configuration' })));
        this.operational.update(tree);
      },
      notify: (path, content, eventTime) => this.notify(path, content, eventTime === undefined ? {} : { eventTime }),
    };
  }

  #open(id: number): ServerSession | undefined {
    const s = this.#sessions.get(id);
    return s !== undefined && s.version !== undefined && !s.ended ? s : undefined;
  }

  #allocateId(): number {
    // Unique among the server's sessions (RFC 6241 §8.1); wraps after 2^32-1.
    for (;;) {
      const id = this.#nextId;
      this.#nextId = id >= MAX_SESSION_ID ? 1 : id + 1;
      if (!this.#sessions.has(id)) return id;
    }
  }
}

/** RFC 6470's session parameters for an open session. */
function sessionParms(session: ServerSession): SessionParms {
  return { username: session.principal.username, sessionId: session.id, sourceHost: session.sourceHost };
}

/** Whether a leaf is a list key: structure, not a configuration value. */
function isKey(node: InstanceNode): boolean {
  return node.parent instanceof ListEntry && node.parent.keys.includes(node as never);
}

/** The event streams (RFC 5277 §3.2.3): the NETCONF stream, without replay. */
function streamsJson(device: Device): Record<string, JsonValue> {
  if (!device.protocol.notification) return {};
  return {
    'nc-notifications:netconf': {
      streams: { stream: [{ name: NETCONF_STREAM, description: 'Default NETCONF event stream', replaySupport: false }] },
    },
  };
}

function isDevice(d: Device | DeviceDefinition): d is Device {
  return 'schema' in d && 'protocol' in d;
}

function validateTree(tree: DataTree): ReturnType<typeof validate> {
  return validate(tree).filter((i) => i.severity === 'error');
}
