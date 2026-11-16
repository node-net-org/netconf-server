/**
 * The control module (design §14.1, CONTROL area): reset, faults, quirks,
 * notifications on demand, state, and snapshots, for tests and tutorials.
 * The in-process API is `server.control`; over NETCONF the same operations
 * are the RPCs of net-netconf-server-control, served by an ordinary
 * provider (controlProvider) through the provider interface.
 */

import { YangDataError, type DataChange, type DataTree, type JsonValue } from '@node-net/yang/core';
import type { StateEdit } from '../datastore/operational.js';
import type { Device } from '../device/load.js';
import type { OperationCall, Provider } from '../provider/provider.js';
import { issueErrors } from '../rpc/data-errors.js';
import { RpcFailure, type RpcErrorSpec } from '../rpc/errors.js';
import { invalid } from '../rpc/params.js';
import { dateTime } from '../notify/bus.js';
import type { ServerSession } from '../session/session.js';
import type { FaultAction, FaultInfo, FaultSpec, FaultTable, FaultTarget, FaultTrigger } from './faults.js';
import type { QuirkChange, QuirkState } from '../quirks/state.js';

export const CONTROL_NS = 'urn:node-net:yang:net-netconf-server-control';
export const CONTROL_PATH = '/net-netconf-server-control:control';

/** How a deployment uses the control module (CONTROL-01). */
export interface ControlOptions {
  /** Whether the server implements the control module. Default: true when createServer() is given no providers, false when it is given any. */
  readonly enabled?: boolean;
  /**
   * The users who may use it. Their sessions are control sessions, exempt
   * from quirks and faults (CONTROL-08). Without a list anyone may use it,
   * and a session becomes a control session with its first control RPC.
   */
  readonly users?: readonly string[];
}

/** What reset() does beyond restoring the datastores. */
export interface ResetOptions {
  /** End every other session, as killed by `by`. Default false. */
  readonly endOtherSessions?: boolean;
  /** The session asking, which is kept open. */
  readonly by?: number;
}

/** The control module's operations, in process (design §14.1). */
export interface ServerControl {
  /** Every datastore back to the device's initial data; locks, a pending confirmed commit, faults, run-time quirks and snapshots cleared. */
  reset(options?: ResetOptions): Promise<void>;
  /** Adds a fault; returns its id. */
  injectFault(spec: FaultSpec): number;
  /** Removes a fault, or all of them; returns how many went. */
  clearFaults(id?: number): number;
  faults(): FaultInfo[];
  /** Turns a quirk on (`true` or settings) or off (`false`), for new sessions or one session. @throws TypeError for an unknown quirk or bad settings */
  setQuirk(name: string, value: unknown, sessionId?: number): void;
  quirks(): QuirkChange[];
  /** server.notify() by another name, for symmetry with the RPC. @throws YangDataError when the content is invalid */
  sendNotification(path: string, content?: Readonly<Record<string, JsonValue>>, eventTime?: number): void;
  /** An edit of the held state (configuration nodes refused). @throws YangDataError */
  setState(edit: StateEdit): void;
  /** Saves every datastore under a name. */
  snapshot(name: string): void;
  /** Puts every datastore back to a snapshot. @throws TypeError for an unknown name */
  restore(name: string): Promise<void>;
  snapshots(): string[];
}

/** What the control module needs from the server. */
export interface ControlHost {
  readonly device: Device;
  readonly faults: FaultTable;
  readonly quirks: QuirkState;
  now(): number;
  /** The open sessions. */
  sessions(): ServerSession[];
  session(id: number): ServerSession | undefined;
  /** The current running, startup and held operational state. */
  trees(): { readonly running: DataTree; readonly startup: DataTree | undefined; readonly state: DataTree };
  /** Puts running and startup back, without providers. */
  restoreConfig(running: DataTree, startup: DataTree | undefined, releaseLocks: boolean, by: number | undefined): Promise<readonly DataChange[]>;
  /** Replaces the held operational state. */
  restoreState(state: DataTree): void;
  updateState(edit: StateEdit): void;
  notify(path: string, content: Readonly<Record<string, JsonValue>>, eventTime: number | undefined): void;
}

interface Snapshot {
  readonly running: DataTree;
  readonly startup: DataTree | undefined;
  readonly state: DataTree;
  readonly taken: number;
}

export class Control implements ServerControl {
  readonly #snapshots = new Map<string, Snapshot>();

  constructor(private readonly host: ControlHost) {}

  /** The device's schema, for mapping data problems to rpc-errors. */
  get schema(): Device['schema'] {
    return this.host.device.schema;
  }

  async reset(options: ResetOptions = {}): Promise<void> {
    const { initial } = this.host.device;
    this.host.faults.clear();
    this.host.quirks.reset();
    this.#snapshots.clear();
    if (options.endOtherSessions === true) {
      for (const s of this.host.sessions()) if (s.id !== options.by) s.end('killed', options.by);
    }
    // The server puts its own state back: changed-by is the server, as for restore.
    await this.host.restoreConfig(initial.running, initial.startup, true, undefined);
    this.host.restoreState(initial.operational);
  }

  injectFault(spec: FaultSpec): number {
    const id = this.host.faults.add(spec);
    const open = this.host.sessions().map((s) => ({ id: s.id, username: s.principal.username, exempt: s.exempt }));
    for (const [session, action] of this.host.faults.takeImmediate(id, open)) this.host.session(session.id)?.applyFault(action);
    return id;
  }

  clearFaults(id?: number): number {
    return this.host.faults.clear(id);
  }

  faults(): FaultInfo[] {
    return this.host.faults.list();
  }

  setQuirk(name: string, value: unknown, sessionId?: number): void {
    if (sessionId !== undefined && this.host.session(sessionId) === undefined) throw new TypeError(`No session ${sessionId}`);
    const problem = this.host.quirks.set(name, value, sessionId);
    if (problem !== undefined) throw new TypeError(problem);
  }

  quirks(): QuirkChange[] {
    return this.host.quirks.changes();
  }

  sendNotification(path: string, content: Readonly<Record<string, JsonValue>> = {}, eventTime?: number): void {
    this.host.notify(path, content, eventTime);
  }

  setState(edit: StateEdit): void {
    this.host.updateState(edit);
  }

  snapshot(name: string): void {
    const t = this.host.trees();
    this.#snapshots.set(name, { running: t.running, startup: t.startup, state: t.state, taken: this.host.now() });
  }

  async restore(name: string): Promise<void> {
    const s = this.#snapshots.get(name);
    if (s === undefined) throw new TypeError(`No snapshot ${JSON.stringify(name)}`);
    await this.host.restoreConfig(s.running, s.startup, false, undefined);
    this.host.restoreState(s.state);
  }

  snapshots(): string[] {
    return [...this.#snapshots.keys()];
  }

  /** The control container's state, as RFC 7951 JSON. */
  stateJson(): Record<string, JsonValue> {
    const faults = this.faults().map((f) => ({
      id: f.id,
      target: describeTarget(f.target),
      trigger: describeTrigger(f.trigger),
      action: f.action.kind,
      remaining: f.remaining,
      ...(f.boundTo === undefined ? {} : { 'session-id': f.boundTo }),
    }));
    const quirks = this.quirks().map((q) => ({
      name: q.name,
      scope: q.sessionId === undefined ? 'new-sessions' : `session ${q.sessionId}`,
      ...(q.settings === undefined ? {} : { settings: JSON.stringify(q.settings) }),
    }));
    const snapshots = [...this.#snapshots].map(([name, s]) => ({ name, taken: dateTime(s.taken).replace(/\.\d{3}Z$/, 'Z') }));
    return {
      'net-netconf-server-control:control': {
        ...(faults.length === 0 ? {} : { faults: { fault: faults } }),
        ...(quirks.length === 0 ? {} : { quirks: { quirk: quirks } }),
        ...(snapshots.length === 0 ? {} : { snapshots: { snapshot: snapshots } }),
      },
    };
  }
}

function describeTarget(t: FaultTarget): string {
  return t.kind === 'session' ? `session ${t.sessionId}` : t.kind === 'user' ? `user ${t.username}` : 'next-session';
}

function describeTrigger(t: FaultTrigger): string {
  return t.kind === 'operation' ? t.name : t.kind;
}

/** What the provider needs to check who is calling. */
export interface ControlAccess {
  /** The control users, or undefined when anyone may use the module. */
  readonly users: readonly string[] | undefined;
  session(id: number): ServerSession | undefined;
}

/**
 * The control module as a provider (design §14.1): its RPCs and its state
 * through the ordinary provider interface.
 */
export function controlProvider(control: Control, access: ControlAccess): Provider {
  /** Wraps a handler with the access check (CONTROL-01 AC3) and makes the caller a control session. */
  const guarded =
    (handler: (call: OperationCall) => void | Readonly<Record<string, JsonValue>> | Promise<void | Readonly<Record<string, JsonValue>>>) =>
    async (call: OperationCall): Promise<void | Readonly<Record<string, JsonValue>>> => {
      if (access.users !== undefined && !access.users.includes(call.username)) {
        throw new RpcFailure({ type: 'application', tag: 'access-denied', message: `User ${call.username} may not use the control module` });
      }
      access.session(call.sessionId)?.makeExempt();
      return handler(call);
    };

  return {
    // It holds no configuration, so whatever the server's start-up mode, there is nothing to adopt.
    startup: 'push',
    onRead: () => control.stateJson(),
    rpcs: {
      'net-netconf-server-control:reset': guarded(async ({ input, sessionId }) => {
        await control.reset({ endOtherSessions: input['end-other-sessions'] === true, by: sessionId });
      }),
      'net-netconf-server-control:inject-fault': guarded(({ input }) => {
        let id: number;
        try {
          id = control.injectFault(faultSpec(input));
        } catch (err) {
          if (err instanceof TypeError) throw invalid(err.message, 'inject-fault');
          throw err;
        }
        return { id };
      }),
      'net-netconf-server-control:clear-faults': guarded(({ input }) => ({ cleared: control.clearFaults(typeof input['id'] === 'number' ? input['id'] : undefined) })),
      'net-netconf-server-control:set-quirk': guarded(({ input }) => {
        const name = text(input['name']);
        let value: unknown = true;
        if (input['off'] !== undefined) value = false;
        else if (typeof input['settings'] === 'string') value = parseJson(input['settings'], 'settings');
        try {
          control.setQuirk(name, value, typeof input['session-id'] === 'number' ? input['session-id'] : undefined);
        } catch (err) {
          if (err instanceof TypeError) throw invalid(err.message, 'name');
          throw err;
        }
      }),
      'net-netconf-server-control:send-notification': guarded(({ input }) => {
        const content = parseJson(typeof input['content'] === 'string' ? input['content'] : '{}', 'content');
        if (typeof content !== 'object' || content === null || Array.isArray(content)) throw invalid('content is a JSON object', 'content');
        const time = typeof input['event-time'] === 'string' ? Date.parse(input['event-time']) : undefined;
        try {
          control.sendNotification(text(input['path']), content as Record<string, JsonValue>, time);
        } catch (err) {
          throw dataFailure(err, control);
        }
      }),
      'net-netconf-server-control:set-state': guarded(({ input }) => {
        const edit = parseJson(text(input['edit']), 'edit');
        if (typeof edit !== 'object' || edit === null || Array.isArray(edit)) throw invalid('edit is a JSON object', 'edit');
        try {
          control.setState(edit as Record<string, JsonValue>);
        } catch (err) {
          throw dataFailure(err, control);
        }
      }),
      'net-netconf-server-control:snapshot': guarded(({ input }) => {
        control.snapshot(text(input['name']));
      }),
      'net-netconf-server-control:restore': guarded(async ({ input }) => {
        try {
          await control.restore(text(input['name']));
        } catch (err) {
          if (err instanceof TypeError) throw invalid(err.message, 'name');
          throw err;
        }
      }),
    },
  };
}

/** A fault from inject-fault's input. */
function faultSpec(input: Readonly<Record<string, JsonValue>>): FaultSpec {
  const target: FaultTarget =
    typeof input['session-id'] === 'number'
      ? { kind: 'session', sessionId: input['session-id'] }
      : typeof input['username'] === 'string'
        ? { kind: 'user', username: input['username'] }
        : { kind: 'next-session' };
  const trigger: FaultTrigger =
    typeof input['on-operation'] === 'string' ? { kind: 'operation', name: input['on-operation'] } : input['immediately'] !== undefined ? { kind: 'immediate' } : { kind: 'next-rpc' };
  return { target, trigger, count: typeof input['count'] === 'number' ? input['count'] : 1, action: faultAction(input) };
}

function faultAction(input: Readonly<Record<string, JsonValue>>): FaultAction {
  const e = input['rpc-error'];
  if (typeof e === 'object' && e !== null && !Array.isArray(e)) {
    const spec = {
      type: (e['error-type'] ?? 'application') as RpcErrorSpec['type'],
      tag: (e['error-tag'] ?? 'operation-failed') as RpcErrorSpec['tag'],
      ...(typeof e['error-message'] === 'string' ? { message: e['error-message'] } : {}),
    };
    return { kind: 'rpc-error', errors: [spec] };
  }
  if (input['no-reply'] !== undefined) return { kind: 'no-reply' };
  if (typeof input['delay'] === 'number') return { kind: 'delay', ms: input['delay'] };
  if (input['drop'] !== undefined) return { kind: 'drop' };
  if (input['no-hello'] !== undefined) return { kind: 'no-hello' };
  if (Array.isArray(input['unsolicited'])) return { kind: 'unsolicited', messages: input['unsolicited'].map(String) };
  if (typeof input['raw-bytes'] === 'string') return { kind: 'raw-bytes', bytes: new TextEncoder().encode(input['raw-bytes']) };
  throw invalid('inject-fault needs an action', 'inject-fault');
}

/** A string parameter (validated as one by the schema). */
function text(v: JsonValue | undefined): string {
  return typeof v === 'string' ? v : '';
}

function parseJson(json: string, element: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (err) {
    throw invalid(`${element} is not JSON: ${(err as Error).message}`, element);
  }
}

/** A YangDataError as rpc-errors (CONTROL-05 AC2, CONTROL-06 AC3); other errors pass through. */
function dataFailure(err: unknown, control: Control): unknown {
  if (err instanceof YangDataError) return new RpcFailure(issueErrors(err.issues, control.schema));
  if (err instanceof TypeError) return invalid(err.message, 'path');
  return err;
}
