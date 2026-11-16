/**
 * Start-up (design §9, STORE-02, STORE-03 AC4, STORE-05): the trees a server
 * starts with. A saved datastore wins over the device's initial data; with
 * :startup, running boots from the saved startup, as a router applies its
 * startup configuration at boot. Saved data is decoded and validated like
 * everything else, and a server never starts with configuration that breaks
 * the schema.
 */

import { DataTree, decodeJson, mergeTrees, YangDataError } from '@node-net/yang/core';
import type { StartTrees } from '../datastore/datastores.js';
import type { Device } from '../device/load.js';
import { DeviceError } from '../errors.js';
import type { Store, StoredDatastore } from './store.js';

/** How the server and its providers start (design §9). Without providers (M3) both start the same way. */
export type StartupMode = 'push' | 'adopt';

export async function startTrees(device: Device, store: Store): Promise<StartTrees> {
  await store.open?.();
  const saved: StoredDatastore = device.protocol.startup ? 'startup' : 'running';
  const text = await store.load(saved);
  if (text === undefined) return device.initial;
  const where = store.describe?.(saved) ?? `${store.location} (${saved})`;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new DeviceError(`Can't start: the saved ${saved} configuration is not valid JSON`, [{ path: where, message: (err as Error).message }], { cause: err });
  }
  let tree: DataTree;
  try {
    tree = decodeJson(device.schema.forDatastore(saved), json, { validate: true });
  } catch (err) {
    if (!(err instanceof YangDataError)) throw err;
    const issues = err.issues.filter((i) => i.severity !== 'warning').map((i) => ({ path: `${where} ${i.path}`, message: `${i.message} (${i.code})` }));
    throw new DeviceError(`Can't start: the saved ${saved} configuration is not valid`, issues, { cause: err });
  }
  if (saved === 'running') return { running: tree, startup: undefined };
  return { running: mergeTrees(new DataTree(device.schema.forDatastore('running')), tree), startup: tree };
}
