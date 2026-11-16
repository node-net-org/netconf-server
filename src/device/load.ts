/**
 * Loading a device (design §13): validate the definition, compile its YANG
 * modules with the NETCONF base modules the server needs, and work out the
 * capabilities it advertises. Needs nothing from Node.js; loadDeviceFile()
 * (file.ts) adds reading the definition and its module directories from disk.
 */

import { builtinSource, chainSources, compileSchema, decodeJson, encodeJson, formatLocation, type DataTree, type ModuleRequest, type ModuleSource, type Schema } from '@node-net/yang/core';
import { DeviceError, type DeviceIssue } from '../errors.js';
import { baseModuleSource } from '../modules/source.js';
import { protocolCapabilities, resolveProtocol, type ProtocolCapabilities } from './capabilities.js';
import { loadInitialData, type DataReader, type InitialData } from './data.js';
import type { DeviceData, DeviceDefinition, ModuleRef } from './definition.js';
import { validateDefinition } from './validate.js';

/** A loaded device: its definition, compiled schema and capabilities. */
export interface Device {
  readonly id: string;
  readonly description: string | undefined;
  readonly emulates: string | undefined;
  readonly definition: DeviceDefinition;
  /** Every module the server implements: the device's own and the base modules. */
  readonly schema: Schema;
  /** The optional protocol capabilities, with defaults applied. */
  readonly protocol: ProtocolCapabilities;
  /** The capability URIs the server hello advertises, in order. */
  readonly capabilities: readonly string[];
  /** The initial data files, as resolved paths. */
  readonly data: DeviceData;
  /** The datastore content the device starts with, read from the data files and validated. */
  readonly initial: InitialData;
  /** Where the device's module texts come from: what `<get-schema>` returns. */
  readonly source: ModuleSource;
  /** Whether the schema has the control module (design §14.1), which a server implements only when its deployment enables it. */
  readonly control: boolean;
}

export interface LoadDeviceOptions {
  /** Where to find the device's modules, before @node-net/yang's bundled ones. */
  readonly source?: ModuleSource;
  /** Turns `yang.directories` into a module source. loadDeviceFile() supplies one that reads relative to the file. */
  readonly directorySource?: (directories: readonly string[]) => ModuleSource;
  /** Resolves a path in the definition (a data file). Default: unchanged. */
  readonly resolvePath?: (path: string) => string;
  /**
   * Reads a data file the definition names (after resolvePath), as text or
   * bytes. loadDeviceFile() supplies one that reads from disk; in a browser,
   * pass one that answers from memory.
   */
  readonly readData?: DataReader;
  /**
   * Compile the control module (net-netconf-server-control) into the
   * schema, for a server that enables it. Default false. createServer()
   * reloads a device whose setting differs from its own.
   */
  readonly control?: boolean;
}

/** The control module's name. */
export const CONTROL_MODULE = 'net-netconf-server-control';

const NETCONF_FEATURES = ['writable-running', 'candidate', 'confirmed-commit', 'rollback-on-error', 'validate', 'startup', 'xpath'] as const;

/**
 * Loads a device from a definition object.
 * @throws DeviceError listing every problem, when the definition is invalid
 *   or its modules don't compile.
 */
export async function loadDevice(definition: unknown, options: LoadDeviceOptions = {}): Promise<Device> {
  const issues = validateDefinition(definition);
  if (issues.length > 0) throw new DeviceError('Invalid device definition', issues);
  const def = definition as DeviceDefinition;
  const protocol = resolveProtocol(def.capabilities);

  const sources: ModuleSource[] = [];
  if (options.source !== undefined) sources.push(options.source);
  const directories = def.yang.directories ?? [];
  if (directories.length > 0) {
    if (options.directorySource === undefined) {
      throw new DeviceError('Invalid device definition', [
        { path: '$.yang.directories', message: 'module directories need loadDeviceFile(), or pass the modules as a source' },
      ]);
    }
    sources.push(options.directorySource(directories));
  }
  // The device's own sources come first, so its copy of a module wins.
  sources.push(builtinSource, baseModuleSource);

  const modules = new Map<string, ModuleRequest>();
  const want = (ref: ModuleRef): void => {
    const r = typeof ref === 'string' ? { name: ref } : ref;
    if (!modules.has(r.name)) modules.set(r.name, r);
  };
  def.yang.modules.forEach(want);
  (def.yang.deviations ?? []).forEach(want);
  for (const name of baseModules(protocol)) want(name);
  if (options.control === true) want(CONTROL_MODULE);

  const features: Record<string, readonly string[]> = {
    'ietf-netconf': NETCONF_FEATURES.filter((f) => protocol[featureFlag(f)]),
    'ietf-netconf-nmda': protocol.withDefaults === false ? ['origin'] : ['origin', 'with-defaults'],
    ...def.yang.features,
  };

  const source = chainSources(...sources);
  const schema = await compileSchema({
    source,
    modules: [...modules.values()],
    importOnly: (def.yang.importOnly ?? []).map((m) => (typeof m === 'string' ? { name: m } : m)),
    features,
  });
  const errors = schema.errors;
  if (errors.length > 0) {
    const yangIssues: DeviceIssue[] = errors.map((d) => ({ path: formatLocation(d.location), message: `${d.message} (${d.code})` }));
    throw new DeviceError(`The YANG modules of device ${def.id} don't compile`, yangIssues);
  }

  const resolve = options.resolvePath ?? ((p: string) => p);
  const data: { -readonly [K in keyof DeviceData]: string } = {};
  for (const key of ['running', 'startup', 'operational'] as const) {
    const file = def.data?.[key];
    if (file !== undefined) data[key] = resolve(file);
  }
  const initial = await loadInitialData(schema, data, protocol.startup, options.readData);

  return Object.freeze({
    id: def.id,
    description: def.description,
    emulates: def.emulates,
    definition: def,
    schema,
    protocol,
    capabilities: Object.freeze(protocolCapabilities(protocol, schema, def.capabilities)),
    data: Object.freeze(data),
    initial: Object.freeze(initial),
    source,
    control: options.control === true,
  });
}

/**
 * The same device with the control module compiled in or left out: its
 * modules recompiled from the same sources, and its initial data carried
 * over to the new schema.
 */
export async function withControl(device: Device, control: boolean): Promise<Device> {
  if (device.control === control) return device;
  const { data: _data, ...rest } = device.definition;
  const { directories: _directories, ...yang } = rest.yang;
  // The module directories are already part of the device's source, and the initial data is already read.
  const loaded = await loadDevice({ ...rest, yang }, { source: device.source, control });
  const carry = (tree: DataTree, datastore: 'running' | 'startup' | 'operational'): DataTree => decodeJson(loaded.schema.forDatastore(datastore), encodeJson(tree));
  const initial = Object.freeze({
    running: carry(device.initial.running, 'running'),
    startup: device.initial.startup === undefined ? undefined : carry(device.initial.startup, 'startup'),
    operational: carry(device.initial.operational, 'operational'),
  });
  return Object.freeze({ ...loaded, definition: device.definition, description: device.description, data: device.data, initial });
}

/** The modules the server implements for its own protocol support (DEVICE-02). */
function baseModules(protocol: ProtocolCapabilities): string[] {
  const names = ['ietf-netconf', 'ietf-yang-library', 'ietf-datastores', 'ietf-netconf-nmda', 'ietf-origin', 'ietf-netconf-monitoring', 'net-netconf-server-monitoring'];
  if (protocol.withDefaults !== false) names.push('ietf-netconf-with-defaults');
  if (protocol.notification) names.push('notifications', 'nc-notifications', 'ietf-netconf-notifications');
  return names;
}

function featureFlag(feature: (typeof NETCONF_FEATURES)[number]): 'writableRunning' | 'candidate' | 'confirmedCommit' | 'rollbackOnError' | 'validate' | 'startup' | 'xpath' {
  switch (feature) {
    case 'writable-running':
      return 'writableRunning';
    case 'confirmed-commit':
      return 'confirmedCommit';
    case 'rollback-on-error':
      return 'rollbackOnError';
    default:
      return feature;
  }
}
