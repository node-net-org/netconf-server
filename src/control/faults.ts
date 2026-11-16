/**
 * Injected faults (CONTROL-03, design §14.1): misbehaviour for a chosen
 * session, fired by a trigger, once or a given number of times. Faults never
 * reach control sessions, which stay usable to clear them.
 */

import type { RpcErrorSpec } from '../rpc/errors.js';

/** Which session a fault is for. */
export type FaultTarget =
  | { readonly kind: 'session'; readonly sessionId: number }
  | { readonly kind: 'user'; readonly username: string }
  /** The next session to open; the fault then belongs to that session. */
  | { readonly kind: 'next-session' };

/** When a fault fires. */
export type FaultTrigger =
  | { readonly kind: 'next-rpc' }
  | { readonly kind: 'operation'; readonly name: string }
  /** At once, on the sessions it targets that are open now (or at connect, for the next session). */
  | { readonly kind: 'immediate' };

export type FaultAction =
  /** Reply with these rpc-errors instead of the real reply. */
  | { readonly kind: 'rpc-error'; readonly errors: readonly RpcErrorSpec[] }
  /** Answer the request but send no reply. */
  | { readonly kind: 'no-reply' }
  /** Answer after this many milliseconds on the server's clock. */
  | { readonly kind: 'delay'; readonly ms: number }
  /** Drop the connection without closing the session. */
  | { readonly kind: 'drop' }
  /** Don't send the server's hello (a next-session fault at connect). */
  | { readonly kind: 'no-hello' }
  /** Send these messages, framed, before the reply. */
  | { readonly kind: 'unsolicited'; readonly messages: readonly string[] }
  /** Write these bytes in place of the framed reply. */
  | { readonly kind: 'raw-bytes'; readonly bytes: Uint8Array };

export interface FaultSpec {
  readonly target: FaultTarget;
  /** Default: the next RPC. */
  readonly trigger?: FaultTrigger;
  /** How many times it fires. Default 1. */
  readonly count?: number;
  readonly action: FaultAction;
}

/** A fault waiting to fire, as the control module lists it. */
export interface FaultInfo {
  readonly id: number;
  readonly target: FaultTarget;
  readonly trigger: FaultTrigger;
  readonly remaining: number;
  readonly action: FaultAction;
  /** For a next-session fault, the session it went to. */
  readonly boundTo: number | undefined;
}

/** Where in a session a fault can fire. */
export type FaultPoint = { readonly kind: 'connect' } | { readonly kind: 'rpc'; readonly operation: string | undefined };

/** What the table needs to know about a session. */
export interface FaultSession {
  readonly id: number;
  readonly username: string;
  readonly exempt: boolean;
}

interface Entry {
  readonly id: number;
  readonly spec: FaultSpec;
  readonly trigger: FaultTrigger;
  remaining: number;
  boundTo: number | undefined;
}

export class FaultTable {
  #entries: Entry[] = [];
  #nextId = 1;

  get size(): number {
    return this.#entries.length;
  }

  /**
   * Adds a fault. Returns its id.
   * @throws TypeError when the spec is wrong
   */
  add(spec: FaultSpec): number {
    const count = spec.count ?? 1;
    if (!Number.isInteger(count) || count < 1) throw new TypeError('A fault fires 1 or more times');
    if (spec.action.kind === 'no-hello' && spec.target.kind !== 'next-session') throw new TypeError('A no-hello fault is for the next session');
    if (spec.action.kind === 'delay' && !(Number.isFinite(spec.action.ms) && spec.action.ms >= 0)) throw new TypeError('A delay is 0 or more milliseconds');
    const id = this.#nextId++;
    const trigger = spec.action.kind === 'no-hello' ? { kind: 'immediate' as const } : (spec.trigger ?? { kind: 'next-rpc' as const });
    this.#entries.push({ id, spec, trigger, remaining: count, boundTo: undefined });
    return id;
  }

  /** Removes one fault, or all of them. Returns how many were removed. */
  clear(id?: number): number {
    const before = this.#entries.length;
    this.#entries = id === undefined ? [] : this.#entries.filter((e) => e.id !== id);
    return before - this.#entries.length;
  }

  list(): FaultInfo[] {
    return this.#entries.map((e) => ({ id: e.id, target: e.spec.target, trigger: e.trigger, remaining: e.remaining, action: e.spec.action, boundTo: e.boundTo }));
  }

  /** A session opened: next-session faults go to it. Returns a fault to fire at once (no-hello), if any. */
  connected(session: FaultSession): FaultAction | undefined {
    if (session.exempt) return undefined;
    for (const e of this.#entries) {
      if (e.spec.target.kind === 'next-session' && e.boundTo === undefined) e.boundTo = session.id;
    }
    return this.take(session, { kind: 'connect' });
  }

  /** The fault that fires for a session at a point, counted as fired; undefined when none does. */
  take(session: FaultSession, point: FaultPoint): FaultAction | undefined {
    if (session.exempt || this.#entries.length === 0) return undefined;
    for (const e of this.#entries) {
      if (!this.#targets(e, session)) continue;
      const fires =
        point.kind === 'connect'
          ? e.trigger.kind === 'immediate' && e.spec.target.kind === 'next-session'
          : e.trigger.kind === 'next-rpc' || (e.trigger.kind === 'operation' && e.trigger.name === point.operation);
      if (!fires) continue;
      this.#fired(e);
      return e.spec.action;
    }
    return undefined;
  }

  /** The faults for open sessions that fire at once when added, for each session given. */
  takeImmediate(id: number, sessions: readonly FaultSession[]): [FaultSession, FaultAction][] {
    const e = this.#entries.find((x) => x.id === id);
    if (e === undefined || e.trigger.kind !== 'immediate' || e.spec.target.kind === 'next-session') return [];
    const out: [FaultSession, FaultAction][] = [];
    for (const s of sessions) {
      if (s.exempt || !this.#targets(e, s) || e.remaining === 0) continue;
      out.push([s, e.spec.action]);
      this.#fired(e);
    }
    return out;
  }

  sessionEnded(sessionId: number): void {
    this.#entries = this.#entries.filter((e) => !(e.spec.target.kind === 'session' && e.spec.target.sessionId === sessionId) && e.boundTo !== sessionId);
  }

  #targets(e: Entry, s: FaultSession): boolean {
    const t = e.spec.target;
    switch (t.kind) {
      case 'session':
        return t.sessionId === s.id;
      case 'user':
        return t.username === s.username;
      case 'next-session':
        return e.boundTo === s.id;
    }
  }

  #fired(e: Entry): void {
    e.remaining--;
    if (e.remaining <= 0) this.#entries = this.#entries.filter((x) => x !== e);
  }
}
