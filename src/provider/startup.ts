/**
 * Start-up with providers (design §9; STORE-03, STORE-04, STORE-05 AC2).
 * Under `adopt`, a provider's `load()` gives its backend's configuration,
 * which replaces the saved copy of its subtree; the combined configuration is
 * then validated, and each violation names where it came from. Under `push`
 * (the default), the saved configuration of each provider's subtree is given
 * to it through prepare and commit, and a refusal stops the server starting.
 */

import { DataTree, decodeJson, diffTrees, validate, YangDataError, type DataIssue, type Schema } from '@node-net/yang/core';
import { replaceRegion } from '../datastore/operational.js';
import { DeviceError, type DeviceIssue } from '../errors.js';
import type { Clock } from '../clock.js';
import type { Registration, Registry, SubtreeData } from './provider.js';
import { withTimeout } from './timeout.js';
import { ProviderFailure, type Transactions } from './transaction.js';

/** The backend's configuration for a provider's subtree, through its load() and decoded for `schema`. */
export async function loadSubtree(r: Registration, schema: Schema, clock: Clock): Promise<DataTree> {
  const content: SubtreeData = await withTimeout(clock, r.timeouts.load, `The load of the provider at ${r.path}`, (signal) => r.provider.load!({ signal }));
  return content instanceof DataTree ? content : decodeJson(schema, content);
}

/** `tree` with each adopting provider's subtree replaced by what its load() returned. */
export function adopt(tree: DataTree, loaded: ReadonlyMap<Registration, DataTree>, registry: Registry): DataTree {
  let next = tree;
  for (const [r, given] of loaded) next = replaceRegion(next, r, registry, given);
  return next;
}

/**
 * Validates the start-up configuration. Each violation names its source:
 * the provider whose load() supplied it, or `other` (the saved file, or the
 * device definition's initial data).
 * @throws DeviceError listing every violation
 */
export function checkStartup(tree: DataTree, adopted: ReadonlySet<Registration>, registry: Registry, schema: Schema, other: string): void {
  const errors = validate(tree).filter((i) => i.severity === 'error');
  if (errors.length === 0) return;
  const issues: DeviceIssue[] = errors.map((i) => {
    const owner = ownerOfPath(i, registry, schema);
    const source = owner !== undefined && adopted.has(owner) ? `the provider at ${owner.path} (load)` : other;
    return { path: `${source} ${i.path}`, message: `${i.message} (${i.code})` };
  });
  throw new DeviceError("Can't start: the start-up configuration is not valid", issues, { cause: new YangDataError(errors) });
}

/**
 * Pushes the start-up configuration to the push-mode providers through
 * prepare and commit.
 * @throws DeviceError with the providers' errors when one refuses
 */
export async function push(running: DataTree, registrations: readonly Registration[], transactions: Transactions): Promise<void> {
  const only = new Set(registrations.filter((r) => r.startup === 'push'));
  if (only.size === 0) return;
  const empty = new DataTree(running.schema);
  try {
    await transactions.apply(empty, running, diffTrees(empty, running), { cause: 'startup' }, { checkUnclaimed: false, only });
  } catch (err) {
    if (!(err instanceof ProviderFailure)) throw err;
    const who = err.providers.map((r) => r.path).join(', ') || 'a provider';
    throw new DeviceError(
      `Can't start: ${who} refused the start-up configuration`,
      err.errors.map((e) => ({ path: e.path ?? who, message: e.message ?? e.tag })),
      { cause: err },
    );
  }
}

/** The provider owning the node an issue is about, found by the issue's path. */
function ownerOfPath(issue: DataIssue, registry: Registry, schema: Schema): Registration | undefined {
  // Strip predicates (they may hold '/'), then walk up until a step names a schema node.
  let path = issue.path.replace(/\[(?:[^\]'"]|'[^']*'|"[^"]*")*\]/g, '');
  while (path.length > 1) {
    const node = schema.find(path);
    if (node !== undefined) return registry.ownerOf(node);
    path = path.slice(0, path.lastIndexOf('/'));
  }
  return undefined;
}
