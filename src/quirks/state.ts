/**
 * Which quirks are in force (design §13, CONTROL-04): the device
 * definition's, changed at run time for new sessions or for one session.
 * A session takes the device's and the new-session layer's quirks when it
 * opens; changes for one session apply from its next message, except quirks
 * that act at session start, which only sessions opened later can get.
 */

import { quirkSpec, resolveQuirk, type ActiveQuirks, type QuirkSettings } from './catalogue.js';

/** A run-time quirk change, as the control module lists it. */
export interface QuirkChange {
  readonly name: string;
  /** Undefined for new sessions. */
  readonly sessionId: number | undefined;
  /** The settings, or undefined when the change turns the quirk off. */
  readonly settings: QuirkSettings | undefined;
}

export class QuirkState {
  readonly #device: ActiveQuirks;
  /** Run-time changes for new sessions: settings, or null for off. */
  readonly #forNew = new Map<string, QuirkSettings | null>();
  /** Run-time changes for one session. */
  readonly #forSession = new Map<number, Map<string, QuirkSettings | null>>();

  constructor(device: Readonly<Record<string, unknown>> | undefined) {
    const quirks = new Map<string, QuirkSettings>();
    for (const [name, value] of Object.entries(device ?? {})) {
      const settings = resolveQuirk(name, value);
      // The definition was validated when the device loaded.
      if (typeof settings !== 'string') quirks.set(name, settings);
    }
    this.#device = quirks;
  }

  /** The quirks a session opening now gets. */
  forNewSession(): ActiveQuirks {
    const out = new Map(this.#device);
    for (const [name, s] of this.#forNew) {
      if (s === null) out.delete(name);
      else out.set(name, s);
    }
    return out;
  }

  /** A session's quirks now: what it opened with, changed by its own layer. */
  forSession(sessionId: number, opened: ActiveQuirks): ActiveQuirks {
    const own = this.#forSession.get(sessionId);
    if (own === undefined) return opened;
    const out = new Map(opened);
    for (const [name, s] of own) {
      if (quirkSpec(name)?.atSessionStart === true) continue;
      if (s === null) out.delete(name);
      else out.set(name, s);
    }
    return out;
  }

  /**
   * Turns a quirk on with its settings (`true` for the defaults) or off
   * (`false`), for new sessions or for one session.
   * @returns a message saying what is wrong, or undefined
   */
  set(name: string, value: unknown, sessionId?: number): string | undefined {
    let settings: QuirkSettings | null;
    if (value === false) {
      if (quirkSpec(name) === undefined) return `${name} is not a known quirk`;
      settings = null;
    } else {
      const s = resolveQuirk(name, value);
      if (typeof s === 'string') return `${name} ${s}`;
      settings = s;
    }
    if (sessionId === undefined) this.#forNew.set(name, settings);
    else {
      let own = this.#forSession.get(sessionId);
      if (own === undefined) this.#forSession.set(sessionId, (own = new Map<string, QuirkSettings | null>()));
      own.set(name, settings);
    }
    return undefined;
  }

  /** The run-time changes, for the control module's state. */
  changes(): QuirkChange[] {
    const out: QuirkChange[] = [...this.#forNew].map(([name, s]) => ({ name, sessionId: undefined, settings: s ?? undefined }));
    for (const [id, own] of this.#forSession) for (const [name, s] of own) out.push({ name, sessionId: id, settings: s ?? undefined });
    return out;
  }

  sessionEnded(sessionId: number): void {
    this.#forSession.delete(sessionId);
  }

  /** Back to the device definition's quirks. */
  reset(): void {
    this.#forNew.clear();
    this.#forSession.clear();
  }
}
