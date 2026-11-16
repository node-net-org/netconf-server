/**
 * Test support for providers: the providers fixture device
 * (test/fixtures/providers), servers and sessions on it, and a provider
 * that records what it is given.
 */

import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileSource } from '@node-net/yang';
import type { DataChange } from '@node-net/yang/core';
import { createServer, loadDevice, loadDeviceFile, type Device, type NetconfServer, type ServerOptions } from '../src/index.js';
import type { DeviceDefinition, HookContext, Provider, ProviderTransaction } from '../src/core.js';
import { rawOpen } from './helpers.js';
import type { Client } from './reads-helpers.js';

export const PROVIDERS = fileURLToPath(new URL('./fixtures/providers/device.json', import.meta.url));
export const PT = 'urn:example:providers';

let cached: Promise<Device> | undefined;

/** The providers device, loaded once. */
export function providersDevice(): Promise<Device> {
  cached ??= loadDeviceFile(PROVIDERS);
  return cached;
}

/** The providers device with its definition changed. */
export async function providersVariant(change: (def: DeviceDefinition) => DeviceDefinition): Promise<Device> {
  const def = change(JSON.parse(await readFile(PROVIDERS, 'utf8')) as DeviceDefinition);
  const base = dirname(PROVIDERS);
  return loadDevice(def, {
    directorySource: (dirs) => fileSource(dirs.map((d) => resolve(base, d))),
    resolvePath: (p) => resolve(base, p),
    readData: (p) => readFile(p),
  });
}

/** A server for the providers device with one open session (user `tester`). `open()` opens more. */
export async function providersSession(options: Partial<ServerOptions> = {}): Promise<{ srv: NetconfServer; c: Client; device: Device; open: () => Promise<Client> }> {
  const device = (options.device as Device | undefined) ?? (await providersDevice());
  // The provider tests count the registered providers, so the control module's provider stays out unless asked for.
  const srv = await createServer({ control: { enabled: false }, ...options, device });
  const c = await rawOpen(srv);
  return { srv, c, device, open: () => rawOpen(srv) };
}

/** One call a recording provider saw. */
export interface Call {
  readonly hook: 'prepare' | 'commit' | 'abort';
  readonly name: string;
  readonly changes?: readonly { readonly operation: string; readonly path: string }[];
  readonly cause?: string;
}

/**
 * A provider that records its prepare, commit and abort calls in `log`
 * (shared between providers, so the order across them shows), and can be
 * told to refuse or to fail on commit.
 */
export function recorder(
  name: string,
  log: Call[],
  behaviour: {
    refuse?: (changes: readonly DataChange[], ctx: HookContext) => Error | undefined;
    failCommit?: (changes: readonly DataChange[], ctx: HookContext) => Error | undefined;
    noAbort?: boolean;
  } = {},
  extra: Partial<Provider> = {},
): Provider {
  return {
    ...extra,
    prepare(changes, ctx): ProviderTransaction {
      log.push({ hook: 'prepare', name, changes: changes.map((c) => ({ operation: c.operation, path: c.path })), cause: ctx.cause });
      const refusal = behaviour.refuse?.(changes, ctx);
      if (refusal !== undefined) throw refusal;
      return {
        commit: () => {
          log.push({ hook: 'commit', name, cause: ctx.cause });
          const failure = behaviour.failCommit?.(changes, ctx);
          if (failure !== undefined) throw failure;
        },
        ...(behaviour.noAbort === true ? {} : { abort: () => void log.push({ hook: 'abort', name, cause: ctx.cause }) }),
      };
    },
  };
}

/** A promise with its resolve and reject, for hooks a test holds. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** `<interfaces>` content with one interface. */
export function iface(name: string, inner = ''): string {
  return `<interfaces xmlns="${PT}"><interface><name>${name}</name>${inner}</interface></interfaces>`;
}

/** A `<get-data>` of operational with a subtree filter ('' for none). */
export function getData(filter: string): string {
  const ds = '<datastore xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores">ds:operational</datastore>';
  return `<get-data xmlns="${NMDA}">${ds}${filter === '' ? '' : `<subtree-filter>${filter}</subtree-filter>`}</get-data>`;
}

/** A `<get>` with a subtree filter ('' for none). */
export function get(filter: string): string {
  return `<get>${filter === '' ? '' : `<filter type="subtree">${filter}</filter>`}</get>`;
}

export const NMDA = 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda';

/** The providers device's data as RFC 7951 JSON, typed for assertions. */
export interface ProvidersData {
  readonly 'providers-test:interfaces': { readonly interface: readonly { readonly name: string; readonly mtu?: number; readonly state?: Record<string, unknown> }[] };
  readonly 'providers-test:system': Record<string, unknown>;
  readonly 'net-netconf-server-monitoring:providers': { readonly provider: readonly Record<string, unknown>[] };
}

export type { NetconfServer };
