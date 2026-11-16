/**
 * Global locks on the configuration datastores (RFC 6241 §7.5, §7.6,
 * WRITE-06). The server only keeps and publishes the lock state; holding
 * back a backend while a lock is held is the embedding code's job (design §7).
 */

/** A datastore that can be locked. */
export type LockableDatastore = 'running' | 'candidate' | 'startup';

/** One held lock. */
export interface LockInfo {
  readonly datastore: LockableDatastore;
  /** The session holding it. */
  readonly sessionId: number;
  /** That session's user. */
  readonly username: string | undefined;
  /** When it was taken, in milliseconds since the epoch. */
  readonly lockedAt: number;
}

/** A change of a datastore's lock, as the `lockChanged` event reports it. */
export interface LockChangedEvent {
  readonly datastore: LockableDatastore;
  /** The new holder, or undefined when the lock was released. */
  readonly sessionId: number | undefined;
  /** The new holder's user. */
  readonly username: string | undefined;
  /** The holder before, or undefined when it was unlocked. */
  readonly previous: number | undefined;
  /** The previous holder's user. */
  readonly previousUsername: string | undefined;
}

/** The lock state, as `server.locks` publishes it to embedding code. */
export interface Locks {
  /** The session holding a datastore's lock, or undefined. */
  holder(datastore: LockableDatastore): number | undefined;
  /** The lock on a datastore, with its holder's session and user, or undefined. */
  get(datastore: LockableDatastore): LockInfo | undefined;
  /** Every held lock. */
  list(): LockInfo[];
}

export class LockTable implements Locks {
  readonly #held = new Map<LockableDatastore, LockInfo>();

  constructor(private readonly changed: (event: LockChangedEvent) => void) {}

  holder(datastore: LockableDatastore): number | undefined {
    return this.#held.get(datastore)?.sessionId;
  }

  get(datastore: LockableDatastore): LockInfo | undefined {
    return this.#held.get(datastore);
  }

  list(): LockInfo[] {
    return [...this.#held.values()];
  }

  /** Whether `sessionId` may write `datastore`: it is unlocked, or that session holds it. */
  allows(datastore: LockableDatastore, sessionId: number | undefined): boolean {
    const holder = this.holder(datastore);
    return holder === undefined || holder === sessionId;
  }

  take(datastore: LockableDatastore, sessionId: number, username: string | undefined, now: number): void {
    this.#held.set(datastore, { datastore, sessionId, username, lockedAt: now });
    this.changed({ datastore, sessionId, username, previous: undefined, previousUsername: undefined });
  }

  release(datastore: LockableDatastore): void {
    const info = this.#held.get(datastore);
    if (info === undefined) return;
    this.#held.delete(datastore);
    this.changed({ datastore, sessionId: undefined, username: undefined, previous: info.sessionId, previousUsername: info.username });
  }

  /** The datastores a session holds. */
  heldBy(sessionId: number): LockableDatastore[] {
    return this.list()
      .filter((l) => l.sessionId === sessionId)
      .map((l) => l.datastore);
  }
}
