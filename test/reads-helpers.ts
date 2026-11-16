/**
 * Test support for the read operations: the reads fixture device
 * (test/fixtures/reads), a raw session on it, and helpers for `<data>`.
 */

import { fileURLToPath } from 'node:url';
import { NETCONF_NS, type XmlElement } from '@node-net/netconf/core';
import { decodeXml, encodeJson, type JsonValue } from '@node-net/yang/core';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileSource } from '@node-net/yang';
import { createServer, loadDevice, loadDeviceFile, type Device, type NetconfServer } from '../src/index.js';
import type { DeviceDefinition } from '../src/core.js';
import { rawOpen, rpc, type RawClient } from './helpers.js';

export const READS = fileURLToPath(new URL('./fixtures/reads/device.json', import.meta.url));
export const RT = 'urn:example:reads';
export const NMDA = 'urn:ietf:params:xml:ns:yang:ietf-netconf-nmda';
export const WD = 'urn:ietf:params:xml:ns:yang:ietf-netconf-with-defaults';
export const NCM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';

let cached: Promise<Device> | undefined;

/** The reads device, loaded once. */
export function readsDevice(): Promise<Device> {
  cached ??= loadDeviceFile(READS);
  return cached;
}

export type Client = RawClient & { request(text: string): Promise<XmlElement> };

/** A server for the reads device (or a variant of its definition) and an open raw session on it. */
export async function readsSession(change?: (def: DeviceDefinition) => DeviceDefinition): Promise<{ srv: NetconfServer; c: Client; device: Device }> {
  const device = change === undefined ? await readsDevice() : await variant(change);
  const srv = await createServer({ device });
  const c = await rawOpen(srv);
  // The device the server serves: with the control module compiled in.
  return { srv, c, device: srv.device };
}

/** The reads device with a changed definition. */
export async function variant(change: (def: DeviceDefinition) => DeviceDefinition): Promise<Device> {
  const def = change(JSON.parse(await readFile(READS, 'utf8')) as DeviceDefinition);
  const base = dirname(READS);
  return loadDevice(def, {
    directorySource: (dirs) => fileSource(dirs.map((d) => resolve(base, d))),
    resolvePath: (p) => resolve(base, p),
    readData: (p) => readFile(p),
  });
}

let id = 100;

/** Sends an operation and returns the reply. */
export function send(c: Client, body: string): Promise<XmlElement> {
  return c.request(rpc(body, `message-id="${++id}"`));
}

/** The reply's `<data>` (in `ns`) as RFC 7951 JSON, decoded with the device's schema. */
export function dataJson(device: Device, reply: XmlElement, ns: string = NETCONF_NS, datastore = 'operational'): JsonValue {
  const data = reply.child('data', ns);
  if (data === undefined) throw new Error(`no <data> in ${JSON.stringify(reply.toString?.() ?? reply.name)}`);
  return encodeJson(decodeXml(device.schema.forDatastore(datastore), data.elements));
}
