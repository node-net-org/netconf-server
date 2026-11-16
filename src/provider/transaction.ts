/**
 * The provider transaction (design §6 steps 2–4, PROVIDER-05, -06, -07,
 * -09, -10): a validated change to running is split by owning provider; the
 * providers involved prepare concurrently; if all accept, they commit one at
 * a time in commit order. A refusal aborts every provider that prepared. A
 * commit that fails is compensated: the providers that already committed
 * are given the inverse changes, through prepare and commit, in reverse
 * order. A provider whose compensation fails too is marked out of sync.
 */

import { diffTrees, YangDataError, type DataChange, type DataTree, type Schema } from '@node-net/yang/core';
import type { Logger } from '@node-net/netconf/core';
import type { Clock } from '../clock.js';
import { errorPath, issueErrors } from '../rpc/data-errors.js';
import { info, operationFailed, RpcFailure, type RpcErrorSpec } from '../rpc/errors.js';
import type { ProviderTransaction, Registration, Registry, TransactionCause } from './provider.js';
import { splitChanges } from './split.js';
import { HookTimeout, withTimeout } from './timeout.js';

/** Who and what a transaction is for. */
export interface TransactionContext {
  readonly cause: TransactionCause;
  readonly sessionId?: number | undefined;
  readonly username?: string | undefined;
}

export interface TransactionOptions {
  /** Refuse changes to unclaimed configuration (the `reject` policy). */
  readonly checkUnclaimed: boolean;
  /** Only these providers take part (start-up, and a provider registered later). */
  readonly only?: ReadonlySet<Registration>;
}

/** A transaction whose providers committed: the caller can still undo it if it fails afterwards. */
export interface Applied {
  /** Undo every commit, in reverse order (the caller failed to save, say). */
  compensate(why: string): Promise<void>;
}

/** A provider refused or failed: the rpc-errors, and the providers at fault. */
export class ProviderFailure extends RpcFailure {
  override name = 'ProviderFailure';

  constructor(
    errors: readonly RpcErrorSpec[],
    readonly providers: readonly Registration[],
  ) {
    super(errors);
  }
}

export interface TransactionsOptions {
  readonly registry: Registry;
  readonly schema: Schema;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly unclaimed: 'store' | 'reject';
}

export class Transactions {
  constructor(private readonly o: TransactionsOptions) {}

  /**
   * Runs the providers' part of changing running from `before` to `after`.
   * Resolves when every involved provider has committed; rejects with a
   * ProviderFailure (running must then stay `before`) when one refused or
   * failed, after aborting or compensating the rest.
   */
  async apply(before: DataTree, after: DataTree, changes: readonly DataChange[], ctx: TransactionContext, options: TransactionOptions): Promise<Applied> {
    const { registry } = this.o;
    const nothing: Applied = { compensate: () => Promise.resolve() };
    if (registry.size === 0 && !(options.checkUnclaimed && this.o.unclaimed === 'reject')) return nothing;
    const split = splitChanges(changes, registry);

    if (options.checkUnclaimed && this.o.unclaimed === 'reject' && split.unclaimed.length > 0) {
      throw new ProviderFailure(split.unclaimed.map((c) => this.#unclaimedError(c)), []);
    }

    const involved = registry.commitOrder(
      [...split.byProvider.keys()].filter((r) => r.provider.prepare !== undefined && (options.only === undefined || options.only.has(r))),
    );
    if (involved.length === 0) return nothing;

    const prepared = await this.#prepareAll(involved, split.byProvider, ctx);
    const committed: Registration[] = [];
    for (const r of involved) {
      const txn = prepared.get(r);
      try {
        if (txn?.commit !== undefined) await withTimeout(this.o.clock, r.timeouts.commit, `The commit of the provider at ${r.path}`, (signal) => txn.commit!(signal));
        committed.push(r);
      } catch (err) {
        this.o.logger.error?.('A provider failed to commit', { provider: r.path, error: (err as Error).message });
        // It and those after it never committed: drop what they staged. Those before it are given the inverse changes.
        await this.#abortAll(involved.slice(involved.indexOf(r)), prepared);
        const failed = await this.#compensate(committed, before, after, ctx);
        const timedOut = err instanceof HookTimeout;
        throw new ProviderFailure(
          [operationFailed(`The provider at ${r.path} failed to commit${timedOut ? ` within ${r.timeouts.commit} ms` : `: ${(err as Error).message}`}; the change was not applied`)],
          [r, ...failed],
        );
      }
    }
    return {
      compensate: async (why: string) => {
        this.o.logger.warn?.('Undoing a committed transaction', { reason: why });
        await this.#compensate(committed, before, after, ctx);
      },
    };
  }

  /** Every provider's prepare, concurrently; on any refusal, aborts those that prepared and throws. */
  async #prepareAll(involved: readonly Registration[], byProvider: ReadonlyMap<Registration, readonly DataChange[]>, ctx: TransactionContext): Promise<Map<Registration, ProviderTransaction | undefined>> {
    const results = await Promise.allSettled(
      involved.map((r) =>
        withTimeout(this.o.clock, r.timeouts.prepare, `The prepare of the provider at ${r.path}`, (signal) => r.provider.prepare!(byProvider.get(r) ?? [], { ...hookCtx(ctx), signal })),
      ),
    );
    const prepared = new Map<Registration, ProviderTransaction | undefined>();
    const errors: RpcErrorSpec[] = [];
    const refused: Registration[] = [];
    results.forEach((res, i) => {
      const r = involved[i]!;
      if (res.status === 'fulfilled') prepared.set(r, res.value ?? undefined);
      else {
        refused.push(r);
        errors.push(...this.#refusal(r, res.reason as Error));
      }
    });
    if (refused.length > 0) {
      await this.#abortAll(involved, prepared);
      throw new ProviderFailure(errors, refused);
    }
    return prepared;
  }

  async #abortAll(registrations: readonly Registration[], prepared: ReadonlyMap<Registration, ProviderTransaction | undefined>): Promise<void> {
    await Promise.all(
      registrations.map(async (r) => {
        const txn = prepared.get(r);
        if (txn?.abort === undefined) return;
        try {
          await withTimeout(this.o.clock, r.timeouts.commit, `The abort of the provider at ${r.path}`, (signal) => txn.abort!(signal));
        } catch (err) {
          this.o.logger.warn?.('A provider failed to abort', { provider: r.path, error: (err as Error).message });
        }
      }),
    );
  }

  /**
   * Gives each provider, last first, the inverse of its changes through
   * prepare and commit. Returns those whose compensation failed, which are
   * marked out of sync.
   */
  async #compensate(registrations: readonly Registration[], before: DataTree, after: DataTree, ctx: TransactionContext): Promise<Registration[]> {
    if (registrations.length === 0) return [];
    const inverse = splitChanges(diffTrees(after, before), this.o.registry).byProvider;
    const failed: Registration[] = [];
    for (const r of [...registrations].reverse()) {
      const changes = inverse.get(r);
      if (changes === undefined || changes.length === 0) continue;
      try {
        const c = { ...ctx, cause: 'compensation' as const };
        const txn = await withTimeout(this.o.clock, r.timeouts.prepare, `The prepare of the provider at ${r.path}`, (signal) => r.provider.prepare!(changes, { ...hookCtx(c), signal }));
        if (txn?.commit !== undefined) await withTimeout(this.o.clock, r.timeouts.commit, `The commit of the provider at ${r.path}`, (signal) => txn.commit!(signal));
      } catch (err) {
        const reason = `Undoing a failed change failed: ${(err as Error).message}`;
        this.o.logger.error?.('A provider could not be brought back in step with running', { provider: r.path, error: (err as Error).message });
        r.markOutOfSync(reason);
        failed.push(r);
      }
    }
    return failed;
  }

  /** The rpc-errors for a provider's refusal. */
  #refusal(r: Registration, err: Error): RpcErrorSpec[] {
    if (err instanceof RpcFailure) return [...err.errors];
    if (err instanceof YangDataError) return issueErrors(err.issues, this.o.schema);
    if (err instanceof HookTimeout) return [operationFailed(`The provider at ${r.path} did not prepare within ${err.ms} ms`)];
    return [operationFailed(`The provider at ${r.path} refused the change: ${err.message}`)];
  }

  #unclaimedError(c: DataChange): RpcErrorSpec {
    const name = c.node.schema.name;
    const path = errorPath(c.path, this.o.schema);
    return {
      type: 'application',
      tag: 'operation-not-supported',
      message: `No provider applies ${c.path}, and the server rejects unclaimed configuration`,
      ...(path.text === '/' ? {} : { path: path.text, pathDeclarations: path.declarations }),
      info: [info('bad-element', name)],
    };
  }
}

function hookCtx(ctx: TransactionContext): { cause: TransactionCause; sessionId?: number; username?: string } {
  return {
    cause: ctx.cause,
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    ...(ctx.username === undefined ? {} : { username: ctx.username }),
  };
}
