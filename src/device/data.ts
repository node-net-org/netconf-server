/**
 * A device's initial data (DEVICE-04): the running, startup and operational
 * files of its definition, read through a caller's reader (so the core
 * needs no filesystem), decoded as XML or RFC 7951 JSON by extension, and
 * validated against the device's schema. Invalid data stops the device
 * loading, with every violation and where it is.
 */

import { DataTree, YangDataError, decodeJson, decodeXml, formatLocation, mergeTrees, type DataIssue, type Schema } from '@node-net/yang/core';
import { DeviceError, type DeviceIssue } from '../errors.js';
import type { DeviceData } from './definition.js';

/** Reads a data file named in a definition, already resolved. */
export type DataReader = (path: string) => Promise<string | Uint8Array>;

/** The datastore content a device starts with. Never changed once loaded. */
export interface InitialData {
  readonly running: DataTree;
  /** Undefined when the device has no startup datastore. */
  readonly startup: DataTree | undefined;
  /** State (and system configuration) from the operational file; empty without one. */
  readonly operational: DataTree;
}

type Store = keyof DeviceData;

/**
 * Reads, decodes and validates the data files.
 * @throws DeviceError listing every problem, with file, line and column.
 */
export async function loadInitialData(schema: Schema, files: DeviceData, hasStartup: boolean, read: DataReader | undefined): Promise<InitialData> {
  const issues: DeviceIssue[] = [];
  const trees: Partial<Record<Store, DataTree>> = {};
  for (const store of ['running', 'startup', 'operational'] as const) {
    const file = files[store];
    if (file === undefined) continue;
    if (store === 'startup' && !hasStartup) {
      issues.push({ path: '$.data.startup', message: 'the device has no startup datastore: set capabilities.startup' });
      continue;
    }
    if (read === undefined) {
      issues.push({ path: `$.data.${store}`, message: 'data files need loadDeviceFile(), or a readData option to read them' });
      continue;
    }
    let content: string;
    try {
      const raw = await read(file);
      content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    } catch (err) {
      issues.push({ path: `$.data.${store}`, message: `can't read ${file}: ${(err as Error).message}` });
      continue;
    }
    const result = decodeStore(schema, store, file, content);
    if (Array.isArray(result)) issues.push(...result);
    else trees[store] = result;
  }
  if (issues.length > 0) throw new DeviceError('Invalid initial data', issues);

  const running = trees.running ?? new DataTree(schema.forDatastore('running'));
  return {
    running,
    startup: hasStartup ? (trees.startup ?? copyInto(running, schema.forDatastore('startup'))) : undefined,
    operational: trees.operational ?? new DataTree(schema.forDatastore('operational')),
  };
}

/** One file decoded with its datastore's schema, or the issues that stop it. */
function decodeStore(schema: Schema, store: Store, file: string, content: string): DataTree | DeviceIssue[] {
  const view = schema.forDatastore(store);
  const xml = /\.xml$/i.test(file);
  // <operational> may break semantic constraints (RFC 8342 §5.3) and holds only part of the data: the rest comes from running.
  const validate = store === 'operational' ? { partial: true } : true;
  const decode = (positions: boolean): DataTree => (xml ? decodeXml(view, content, { validate, positions }) : decodeJson(view, content, { validate, positions }));
  try {
    return decode(false);
  } catch (first) {
    if (!(first instanceof YangDataError)) {
      return [{ path: `$.data.${store}`, message: `${file}: ${(first as Error).message}` }];
    }
    // Decode again with positions, so each issue says where it is. Only on failure: positions cost memory.
    let issues: readonly DataIssue[];
    try {
      decode(true);
      issues = first instanceof YangDataError ? first.issues : [];
    } catch (err) {
      if (!(err instanceof YangDataError)) return [{ path: `$.data.${store}`, message: `${file}: ${(err as Error).message}` }];
      issues = err.issues;
    }
    const errors = issues.filter((i) => i.severity !== 'warning');
    return errors.map((i) => ({
      path: `$.data.${store}`,
      message: `${i.position === undefined ? file : formatLocation({ ...i.position, source: file })} ${i.path}: ${i.message} (${i.code})`,
    }));
  }
}

/** A copy of a tree's content in another datastore's view of the same schema. */
function copyInto(tree: DataTree, view: Schema): DataTree {
  return mergeTrees(new DataTree(view), tree);
}
