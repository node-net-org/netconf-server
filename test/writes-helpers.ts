/**
 * Test support for the write operations: the writes fixture device
 * (test/fixtures/writes), servers and sessions on it, a manual clock for
 * confirmed-commit timers, and helpers for replies.
 */

import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NETCONF_NS, type XmlElement } from '@node-net/netconf/core';
import { fileSource } from '@node-net/yang';
import { decodeXml, encodeJson, type JsonValue } from '@node-net/yang/core';
import { createServer, loadDevice, loadDeviceFile, memoryStore, type Clock, type Store, type Device, type NetconfServer, type ServerOptions } from '../src/index.js';
import type { DeviceDefinition } from '../src/core.js';
import { NC, rawOpen, rpc } from './helpers.js';
import type { Client } from './reads-helpers.js';

export const WRITES = fileURLToPath(new URL('./fixtures/writes/device.json', import.meta.url));
export const WT = 'urn:example:writes';
export const NMDA = 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda';
export const DS = 'urn:ietf:params:xml:ns:yang:ietf-datastores';
export const YANG = 'urn:ietf:params:xml:ns:yang:1';

let cached: Promise<Device> | undefined;

/** The writes device, loaded once. */
export function writesDevice(): Promise<Device> {
  cached ??= loadDeviceFile(WRITES);
  return cached;
}

/** The writes device with its definition changed. */
export async function writesVariant(change: (def: DeviceDefinition) => DeviceDefinition): Promise<Device> {
  const def = change(JSON.parse(await readFile(WRITES, 'utf8')) as DeviceDefinition);
  const base = dirname(WRITES);
  return loadDevice(def, {
    directorySource: (dirs) => fileSource(dirs.map((d) => resolve(base, d))),
    resolvePath: (p) => resolve(base, p),
    readData: (p) => readFile(p),
  });
}

/** A server for the writes device (or another) with one open session. `open()` opens more. */
export async function writesSession(options: Partial<ServerOptions> = {}): Promise<{ srv: NetconfServer; c: Client; device: Device; open: () => Promise<Client> }> {
  const device = (options.device as Device | undefined) ?? (await writesDevice());
  const srv = await createServer({ ...options, device });
  const c = await rawOpen(srv);
  return { srv, c, device, open: () => rawOpen(srv) };
}

let id = 1000;

/** Sends an operation and returns the reply. */
export function send(c: Client, body: string): Promise<XmlElement> {
  return c.request(rpc(body, `message-id="${++id}"`));
}

/** An `<edit-config>` of `config` (XML content) to `target`, with extra parameters before the config. */
export function editConfig(target: string, config: string, params = ''): string {
  return `<edit-config><target><${target}/></target>${params}<config>${config}</config></edit-config>`;
}

/** A datastore's configuration through get-config, as RFC 7951 JSON (`{}` when empty). */
export async function config(c: Client, device: Device, datastore = 'running'): Promise<JsonValue> {
  const reply = await send(c, `<get-config><source><${datastore}/></source></get-config>`);
  const data = reply.child('data', NC);
  if (data === undefined) throw new Error(`get-config ${datastore} failed: ${errorTags(reply).join(', ')}`);
  return encodeJson(decodeXml(device.schema.forDatastore(datastore), data.elements));
}

export function isOk(reply: XmlElement): boolean {
  return reply.child('ok', NETCONF_NS) !== undefined;
}

export interface ErrorView {
  readonly type: string | undefined;
  readonly tag: string | undefined;
  readonly appTag: string | undefined;
  readonly path: string | undefined;
  readonly message: string | undefined;
  readonly element: XmlElement;
}

/** Every rpc-error in a reply. */
export function rpcErrors(reply: XmlElement): ErrorView[] {
  return reply.childrenNamed('rpc-error', NC).map((e) => ({
    type: e.child('error-type', NC)?.text(),
    tag: e.child('error-tag', NC)?.text(),
    appTag: e.child('error-app-tag', NC)?.text(),
    path: e.child('error-path', NC)?.text(),
    message: e.child('error-message', NC)?.text(),
    element: e,
  }));
}

export function errorTags(reply: XmlElement): string[] {
  return rpcErrors(reply).map((e) => e.tag ?? '?');
}

/** A clock whose time moves only when a test says so. */
export class ManualClock implements Clock {
  #now = Date.UTC(2026, 10, 13, 12, 0, 0);
  #next = 1;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.#next++;
    this.#timers.set(handle, { at: this.#now + ms, fn });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Timers waiting to fire. */
  get pending(): number {
    return this.#timers.size;
  }

  /** Moves time on, firing every timer that comes due, in order. */
  advance(ms: number): void {
    const until = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].fn();
    }
    this.#now = until;
  }
}

/** Lets queued writes run: resolves after pending promise callbacks. */
export function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

/** A memory store whose saves wait until released, so a write can be held part-way. */
export function heldStore(): Store & { release(): void; waiting: number } {
  const inner = memoryStore();
  let gates: (() => void)[] = [];
  const store = {
    location: 'held',
    waiting: 0,
    load: (ds: 'running' | 'startup') => inner.load(ds),
    async save(ds: 'running' | 'startup', json: string) {
      store.waiting++;
      await new Promise<void>((r) => gates.push(r));
      store.waiting--;
      return inner.save(ds, json);
    },
    release() {
      const g = gates;
      gates = [];
      for (const f of g) f();
    },
  };
  return store;
}

