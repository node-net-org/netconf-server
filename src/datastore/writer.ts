/**
 * Every change to a configuration datastore (design §6, §8): edits, commit
 * and discard-changes, confirmed commits and their rollback, copy-config and
 * delete-config, and the locks that guard them. Each write runs in the
 * server-wide write queue, checks locks when it runs (not when it was
 * queued), validates what it would store, saves to the store, and only then
 * replaces the snapshot, so a failed save changes nothing.
 *
 * A write to running runs the provider transaction (design §6, provider/
 * transaction.ts) between validation and the save: the providers involved
 * prepare, then commit, and only then is the result saved and swapped in. A
 * failed save undoes the providers' commits. Changes from outside NETCONF
 * (applyExternal, design §7) take the same queue but skip locks and
 * providers: the backend has already made them.
 */

import type { Logger } from '@node-net/netconf/core';
import { DataTree, diffEdit, diffTrees, encodeJson, tryApplyEdit, validate, YangDataError, type DataChange, type DataIssue, type ErrorOption } from '@node-net/yang/core';
import type { Clock } from '../clock.js';
import type { Device } from '../device/load.js';
import { errorPath, issueErrors } from '../rpc/data-errors.js';
import { inUse, lockDenied, operationFailed, RpcFailure, type RpcErrorSpec } from '../rpc/errors.js';
import { invalid } from '../rpc/params.js';
import type { Store, StoredDatastore } from '../store/store.js';
import type { Datastores } from './datastores.js';
import type { LockableDatastore, LockTable } from './locks.js';
import type { Registration } from '../provider/provider.js';
import { ProviderFailure, type Transactions } from '../provider/transaction.js';
import type { Subject } from '../nacm/decide.js';
import { firstDeniedWrite, type DeniedWrite } from '../nacm/write-check.js';
import { WriteQueue } from './queue.js';

/**
 * What changed running, as the `commit` event reports it: a session's
 * `edit`, `commit` or `copy`, a confirmed commit's `rollback`, a change from
 * outside NETCONF (`external`), a provider adopting its backend's
 * configuration (`startup`), or the control module's reset or restore
 * (`restore`).
 */
export type CommitCause = 'edit' | 'commit' | 'copy' | 'rollback' | 'external' | 'startup' | 'restore';

export interface CommitEvent {
  readonly datastore: 'running';
  /** The session whose operation changed it; undefined for a change the server or a provider made. */
  readonly sessionId: number | undefined;
  /** That session's user. */
  readonly username: string | undefined;
  /** For an `external` change, the source applyExternal named; for `startup`, the provider's path. */
  readonly source: string | undefined;
  readonly cause: CommitCause;
  /** What changed, as @node-net/yang's diff of the old and new running. */
  readonly changes: readonly DataChange[];
}

/** A step of a confirmed commit (RFC 6241 §8.4), as RFC 6470's netconf-confirmed-commit reports it. */
export interface ConfirmedCommitEvent {
  readonly event: 'start' | 'extend' | 'complete' | 'cancel' | 'timeout';
  /** The session whose operation (or end) caused it; undefined for a timeout. */
  readonly sessionId: number | undefined;
  readonly username: string | undefined;
  /** Seconds until the timeout, for start and extend. */
  readonly timeout?: number;
}

/** Who made a change to running. */
interface Actor {
  readonly sessionId: number | undefined;
  readonly source?: string;
}

export type TestOption = 'test-then-set' | 'set' | 'test-only';

export interface EditRequest {
  readonly target: 'running' | 'candidate';
  readonly edit: DataTree;
  readonly sessionId: number;
  readonly defaultOperation: 'merge' | 'replace' | 'none';
  readonly errorOption: ErrorOption;
  readonly testOption: TestOption;
  /** The session's view of the NACM policy for this message; undefined when writes aren't checked. */
  readonly access?: Subject | undefined;
}

export interface CommitRequest {
  readonly sessionId: number;
  readonly confirmed: boolean;
  /** Seconds; RFC 6241 §8.4.5.1's default is 600. */
  readonly timeout: number;
  readonly persist: string | undefined;
  readonly persistId: string | undefined;
  /** The session's view of the NACM policy for this message; undefined when the commit isn't checked. */
  readonly access?: Subject | undefined;
}

/** A confirmed commit waiting to be confirmed (RFC 6241 §8.4). */
interface PendingCommit {
  /** Running before the first confirmed commit: what a rollback restores. */
  readonly backup: DataTree;
  /** The session that must confirm it, when it has no persist token. */
  readonly sessionId: number | undefined;
  readonly persist: string | undefined;
  timer: unknown;
}

export interface WriterOptions {
  readonly device: Device;
  readonly datastores: Datastores;
  readonly locks: LockTable;
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly committed: (event: CommitEvent) => void;
  /** The provider transaction. */
  readonly transactions: Transactions;
  /** A session's user, while the session is open. */
  readonly username: (sessionId: number) => string | undefined;
  /** A confirmed commit started, was extended, completed, cancelled or timed out. */
  readonly confirmedCommit?: (event: ConfirmedCommitEvent) => void;
  /** NACM refused a session's write (NACM design §7.2): count, log and report it. */
  readonly writeDenied?: (sessionId: number, denied: DeniedWrite) => void;
}

/** What the control module's reset or restore puts back (CONTROL-02, CONTROL-07). */
export interface RestoreTrees {
  readonly running: DataTree;
  readonly startup: DataTree | undefined;
  /** Release every lock too (reset). */
  readonly releaseLocks: boolean;
}

export class Writer {
  readonly queue = new WriteQueue();
  readonly #device: Device;
  readonly #ds: Datastores;
  readonly #locks: LockTable;
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #committed: (event: CommitEvent) => void;
  readonly #transactions: Transactions;
  readonly #username: (sessionId: number) => string | undefined;
  readonly #confirmed: (event: ConfirmedCommitEvent) => void;
  readonly #writeDenied: (sessionId: number, denied: DeniedWrite) => void;
  /** The datastore RFC 6241 says survives a restart. */
  readonly #saved: StoredDatastore;
  #pending: PendingCommit | undefined;

  constructor(o: WriterOptions) {
    this.#device = o.device;
    this.#ds = o.datastores;
    this.#locks = o.locks;
    this.#store = o.store;
    this.#clock = o.clock;
    this.#logger = o.logger;
    this.#committed = o.committed;
    this.#transactions = o.transactions;
    this.#username = o.username;
    this.#confirmed = o.confirmedCommit ?? (() => undefined);
    this.#writeDenied = o.writeDenied ?? (() => undefined);
    this.#saved = o.device.protocol.startup ? 'startup' : 'running';
  }

  /** Whether a confirmed commit is waiting to be confirmed. */
  get confirmPending(): boolean {
    return this.#pending !== undefined;
  }

  // --- edits -----------------------------------------------------------------

  /**
   * `<edit-config>` and `<edit-data>` (WRITE-01, -02, -03). Resolves with the
   * errors of the parts that failed when the rest was applied (stop-on-error
   * and continue-on-error); rejects with an RpcFailure when nothing was.
   */
  edit(r: EditRequest): Promise<readonly DataIssue[]> {
    return this.queue.run(async () => {
      this.#mayWrite(r.target, r.sessionId);
      const current = this.#ds.config(r.target);
      // Strict schema (REQ-10): running is always validated; the candidate unless test-option is set.
      const check = r.target === 'running' || r.testOption !== 'set';
      const result = tryApplyEdit(current, r.edit, { defaultOperation: r.defaultOperation, errorOption: r.errorOption, validate: check });
      if (result.rejected) throw this.#failure(result.errors);
      const changes = r.access !== undefined || result.errors.length > 0 ? diffTrees(current, result.tree) : undefined;
      // Parts failed: store nothing if nothing else applied.
      if (result.errors.length > 0 && changes!.length === 0) return result.errors;
      // NACM: on the changes the edit makes, whatever the error-option (NACM design §7.2, decision 5).
      if (changes !== undefined) this.#checkAccess(r.access, changes, r.sessionId);
      if (r.testOption === 'test-only') return result.errors;
      if (r.target === 'running') await this.#replaceRunning(result.tree, { sessionId: r.sessionId }, 'edit');
      else this.#ds.setCandidate(result.tree, r.sessionId);
      return result.errors;
    });
  }

  /** `<validate>` (WRITE-05): every error in a tree, without changing anything or calling providers. */
  validate(tree: DataTree): void {
    const errors = validate(tree).filter((i) => i.severity === 'error');
    if (errors.length > 0) throw this.#failure(errors);
  }

  // --- the candidate ---------------------------------------------------------

  /** `<commit>`, confirmed or not (WRITE-07, WRITE-08). */
  commit(r: CommitRequest): Promise<void> {
    return this.queue.run(async () => {
      const pending = this.#pending;
      if (pending !== undefined) this.#checkConfirmer(pending, r.sessionId, r.persistId, 'commit');
      else if (r.persistId !== undefined) throw invalid(`No confirmed commit is waiting for persist-id ${JSON.stringify(r.persistId)}`, 'persist-id');
      this.#mayWrite('running', r.sessionId);

      const before = this.#ds.running;
      const next = this.#candidateResult();
      // NACM: the committing user needs access to everything the commit changes in running (RFC 8341 §3.2.8).
      if (next !== before && r.access !== undefined) this.#checkAccess(r.access, diffTrees(before, next), r.sessionId);
      if (next !== before) await this.#replaceRunning(next, { sessionId: r.sessionId }, 'commit');
      this.#ds.resetCandidate();

      if (!r.confirmed) {
        if (pending !== undefined) this.#confirmed({ event: 'complete', sessionId: r.sessionId, username: this.#username(r.sessionId) });
        this.#settle();
        return;
      }
      // A confirmed commit: a new one keeps the first one's backup; each restarts the timer (RFC 6241 §8.4.5.1).
      if (pending !== undefined) this.#clock.clearTimeout(pending.timer);
      const next2: PendingCommit = {
        backup: pending?.backup ?? before,
        sessionId: r.persist === undefined ? r.sessionId : undefined,
        persist: r.persist,
        timer: undefined,
      };
      next2.timer = this.#clock.setTimeout(() => void this.#rollback('the confirm timeout expired', { event: 'timeout', sessionId: undefined, username: undefined }), r.timeout * 1000);
      this.#pending = next2;
      this.#confirmed({ event: pending === undefined ? 'start' : 'extend', sessionId: r.sessionId, username: this.#username(r.sessionId), timeout: r.timeout });
    });
  }

  /** `<discard-changes>`: the candidate equals running again. */
  discard(sessionId: number): Promise<void> {
    return this.queue.run(() => {
      this.#mayWrite('candidate', sessionId);
      this.#ds.resetCandidate();
    });
  }

  /** `<cancel-commit>` (RFC 6241 §8.4.4.1): roll back the pending confirmed commit now. */
  cancelCommit(sessionId: number, persistId: string | undefined): Promise<void> {
    return this.queue.run(async () => {
      const pending = this.#pending;
      if (pending === undefined) throw new RpcFailure(operationFailed('No confirmed commit is in progress', 'protocol'));
      this.#checkConfirmer(pending, sessionId, persistId, 'cancel-commit');
      await this.#restore(pending, sessionId);
      this.#confirmed({ event: 'cancel', sessionId, username: this.#username(sessionId) });
    });
  }

  // --- copy and delete -------------------------------------------------------

  /** `<copy-config>` (WRITE-09): replace a whole datastore with a validated tree. */
  copy(target: LockableDatastore, tree: DataTree, sessionId: number, access?: Subject): Promise<void> {
    return this.queue.run(async () => {
      this.#mayWrite(target, sessionId);
      this.validate(tree);
      // NACM: on the modified nodes of the target (RFC 8341 §3.2.6).
      if (access !== undefined) this.#checkAccess(access, diffTrees(this.#ds.config(target), tree), sessionId);
      if (target === 'running') await this.#replaceRunning(tree, { sessionId }, 'copy');
      else if (target === 'candidate') this.#ds.setCandidate(tree, sessionId);
      else await this.#replaceStartup(tree);
    });
  }

  /** `<delete-config>` of startup: empty it. */
  deleteStartup(sessionId: number): Promise<void> {
    return this.queue.run(async () => {
      this.#mayWrite('startup', sessionId);
      await this.#replaceStartup(new DataTree(this.#device.schema.forDatastore('startup')));
    });
  }

  // --- locks -----------------------------------------------------------------

  /** `<lock>` (WRITE-06, RFC 6241 §7.5). */
  lock(datastore: LockableDatastore, sessionId: number): void {
    const holder = this.#locks.holder(datastore);
    if (holder !== undefined) throw new RpcFailure(lockDenied(`The ${datastore} datastore is already locked by session ${holder}`, holder));
    if (datastore === 'candidate') {
      const other = [...(this.#ds.candidate?.modifiedBy ?? [])].find((id) => id !== sessionId);
      if (other !== undefined) {
        throw new RpcFailure(lockDenied(`The candidate has uncommitted changes from session ${other}`, other));
      }
    }
    this.#locks.take(datastore, sessionId, this.#username(sessionId), this.#clock.now());
  }

  /** `<unlock>` (RFC 6241 §7.6). Releasing the candidate discards its uncommitted changes. */
  unlock(datastore: LockableDatastore, sessionId: number): void {
    const holder = this.#locks.holder(datastore);
    if (holder === undefined) throw new RpcFailure(operationFailed(`The ${datastore} datastore is not locked`, 'protocol'));
    if (holder !== sessionId) throw new RpcFailure(operationFailed(`The ${datastore} datastore is locked by session ${holder}, not this one`, 'protocol'));
    this.#release(datastore);
  }

  /** A session ended: release its locks and roll back its unconfirmed commit (RFC 6241 §7.5, §8.4.1). */
  sessionEnded(sessionId: number, username?: string): void {
    for (const datastore of this.#locks.heldBy(sessionId)) this.#release(datastore);
    const pending = this.#pending;
    if (pending !== undefined && pending.persist === undefined && pending.sessionId === sessionId) {
      void this.#rollback(`session ${sessionId} ended before confirming its commit`, { event: 'cancel', sessionId, username });
    }
  }

  /**
   * The control module's reset and restore (CONTROL-02, CONTROL-07): put
   * running and startup back to the given trees, from the queue, without
   * providers. The candidate follows running, and any pending confirmed
   * commit is dropped without a rollback.
   */
  restore(trees: RestoreTrees, sessionId: number | undefined): Promise<readonly DataChange[]> {
    return this.queue.run(async () => {
      if (this.#pending !== undefined) this.#clock.clearTimeout(this.#pending.timer);
      this.#pending = undefined;
      if (trees.releaseLocks) for (const l of this.#locks.list()) this.#release(l.datastore);
      this.#ds.resetCandidate();
      if (trees.startup !== undefined && this.#ds.has('startup')) await this.#replaceStartup(trees.startup);
      if (trees.running === this.#ds.running) return [];
      return this.#replaceRunning(trees.running, { sessionId, source: 'control' }, 'restore', false);
    });
  }

  // --- outside NETCONF and start-up ----------------------------------------

  /**
   * A change the backend made by another route (design §7, PROVIDER-08):
   * queued like any write, validated, applied whole or not at all, and
   * neither stopped by locks nor passed to providers.
   * @throws YangDataError with every problem; running is unchanged
   */
  external(edit: DataTree, source: string): Promise<readonly DataChange[]> {
    return this.queue.run(async () => {
      const current = this.#ds.running;
      const result = tryApplyEdit(current, edit, { validate: true });
      if (result.rejected) throw new YangDataError(result.errors);
      return this.#replaceRunning(result.tree, { sessionId: undefined, source }, 'external', false);
    });
  }

  /**
   * Brings a provider registered after start-up in step (design §9): under
   * push, its subtree of running goes to it through prepare and commit;
   * under adopt, `adopted` (running with its subtree replaced by the
   * backend's) becomes running.
   */
  start(r: Registration, adopted: (running: DataTree) => DataTree | undefined): Promise<void> {
    return this.queue.run(async () => {
      const running = this.#ds.running;
      if (r.startup === 'adopt') {
        const next = adopted(running);
        if (next !== undefined) await this.#replaceRunning(next, { sessionId: undefined, source: r.path }, 'startup', false);
        return;
      }
      const empty = new DataTree(running.schema);
      await this.#transactions.apply(empty, running, diffTrees(empty, running), { cause: 'startup' }, { checkUnclaimed: false, only: new Set([r]) });
    });
  }

  /** Stop the confirm timer, for server.close(). */
  close(): void {
    if (this.#pending !== undefined) this.#clock.clearTimeout(this.#pending.timer);
  }

  // --- internals -------------------------------------------------------------

  #release(datastore: LockableDatastore): void {
    this.#locks.release(datastore);
    if (datastore === 'candidate') this.#ds.resetCandidate();
  }

  /** The tree a commit would make running: validated, and computed against running as it is now (WRITE-07 AC5). */
  #candidateResult(): DataTree {
    const running = this.#ds.running;
    const changes = this.#ds.candidate;
    if (changes === undefined) return running;
    if (changes.base === running) {
      this.validate(changes.tree);
      return changes.tree;
    }
    // Running changed since the candidate was edited: apply only the candidate's own changes to it.
    const result = tryApplyEdit(running, diffEdit(changes.base, changes.tree), { validate: true });
    if (result.rejected) throw this.#failure(result.errors);
    return result.tree;
  }

  /** Who may confirm or cancel a pending commit (RFC 6241 §8.4.5.1). */
  #checkConfirmer(pending: PendingCommit, sessionId: number, persistId: string | undefined, operation: string): void {
    if (pending.persist !== undefined) {
      if (persistId !== pending.persist) {
        throw invalid(persistId === undefined ? `${operation} needs the persist-id of the pending confirmed commit` : `persist-id ${JSON.stringify(persistId)} does not match the pending confirmed commit`, 'persist-id');
      }
      return;
    }
    if (persistId !== undefined) throw invalid('The pending confirmed commit was made without persist', 'persist-id');
    if (pending.sessionId !== sessionId) {
      throw new RpcFailure(operationFailed(`The pending confirmed commit belongs to session ${pending.sessionId}`, 'protocol'));
    }
  }

  /** The pending commit is confirmed: it stays. */
  #settle(): void {
    if (this.#pending === undefined) return;
    this.#clock.clearTimeout(this.#pending.timer);
    this.#pending = undefined;
  }

  /** Roll back the pending confirmed commit from the queue: the timer fired, or its session ended. */
  #rollback(why: string, event: ConfirmedCommitEvent): Promise<void> {
    return this.queue
      .run(async () => {
        const pending = this.#pending;
        if (pending === undefined) return;
        this.#logger.info?.(`Rolling back the confirmed commit: ${why}`);
        try {
          await this.#restore(pending, undefined);
          this.#confirmed(event);
        } catch (err) {
          // A provider refused or failed the rollback: running keeps the confirmed configuration, and the backend may not match it.
          if (err instanceof ProviderFailure) for (const r of err.providers) r.markOutOfSync(`Rolling back a confirmed commit failed: ${err.message}`);
          throw err;
        }
      })
      .catch((err: unknown) => this.#logger.error?.('Rolling back the confirmed commit failed', { error: (err as Error).message }));
  }

  /** Restores the backup of a pending commit. Locks don't stop it: the server is undoing its own change. */
  async #restore(pending: PendingCommit, sessionId: number | undefined): Promise<void> {
    this.#clock.clearTimeout(pending.timer);
    this.#pending = undefined;
    if (this.#ds.running !== pending.backup) await this.#replaceRunning(pending.backup, { sessionId }, 'rollback');
  }

  /**
   * NACM's write check (NACM design §7.2): one access-denied for the first
   * refused node, which fails the whole operation. Its error-path names the
   * node; the dispatcher's sanitiser cuts it back to what the user may read.
   */
  #checkAccess(access: Subject | undefined, changes: readonly DataChange[], sessionId: number): void {
    if (access === undefined || changes.length === 0) return;
    const denied = firstDeniedWrite(access, changes);
    if (denied === undefined) return;
    this.#writeDenied(sessionId, denied);
    const path = errorPath(denied.node.path, this.#device.schema);
    throw new RpcFailure({
      type: 'application',
      tag: 'access-denied',
      ...(path.text === '/' ? {} : { path: path.text, pathDeclarations: path.declarations }),
      // No path in the message: the error-path carries it, and the sanitiser can cut that; the log has it in full.
      message: `Access to ${denied.access} this data is denied`,
    });
  }

  /** The lock check for a write by `sessionId` to `datastore`, made when the write runs. */
  #mayWrite(datastore: LockableDatastore, sessionId: number): void {
    const holder = this.#locks.holder(datastore);
    if (holder !== undefined && holder !== sessionId) throw new RpcFailure(inUse(datastore, holder));
  }

  /**
   * Makes `tree` (already validated) running: the provider transaction
   * (unless the change came from a backend), the save, the swap, the event.
   */
  async #replaceRunning(tree: DataTree, actor: Actor, cause: CommitCause, providers = true): Promise<DataChange[]> {
    const before = this.#ds.running;
    const changes = diffTrees(before, tree);
    const username = actor.sessionId === undefined ? undefined : this.#username(actor.sessionId);
    const applied = providers
      ? await this.#transactions.apply(before, tree, changes, { cause: cause === 'external' || cause === 'restore' ? 'startup' /* never: these skip providers */ : cause, sessionId: actor.sessionId, username }, { checkUnclaimed: cause !== 'rollback' })
      : undefined;
    if (this.#saved === 'running') {
      try {
        await this.#save('running', tree);
      } catch (err) {
        await applied?.compensate('saving running failed');
        throw err;
      }
    }
    this.#ds.setRunning(tree);
    this.#committed({ datastore: 'running', sessionId: actor.sessionId, username, source: actor.source, cause, changes });
    return changes;
  }

  async #replaceStartup(tree: DataTree): Promise<void> {
    if (this.#saved === 'startup') await this.#save('startup', tree);
    this.#ds.setStartup(tree);
  }

  async #save(datastore: StoredDatastore, tree: DataTree): Promise<void> {
    try {
      await this.#store.save(datastore, JSON.stringify(encodeJson(tree), null, 2));
    } catch (err) {
      this.#logger.error?.(`Saving ${datastore} failed`, { error: (err as Error).message, location: this.#store.location });
      throw new RpcFailure(operationFailed(`The ${datastore} datastore could not be saved`));
    }
  }

  #failure(issues: readonly DataIssue[]): RpcFailure {
    const errors: RpcErrorSpec[] = issueErrors(issues, this.#device.schema);
    return new RpcFailure(errors.length > 0 ? errors : [operationFailed('The configuration is not valid')]);
  }
}
