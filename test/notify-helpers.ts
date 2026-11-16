/**
 * Test support for notifications and the control module: the notifications
 * fixture device, a session that waits for replies by message-id (so
 * notifications arriving in between don't get in the way), and readers for
 * the notifications a session received.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { XmlElement } from '@node-net/netconf/core';
import { decodeXml, encodeJson, type JsonValue } from '@node-net/yang/core';
import { fileSource } from '@node-net/yang';
import { createServer, loadDevice, loadDeviceFile, type Device, type DeviceDefinition, type NetconfServer, type ServerOptions } from '../src/index.js';
import { NC, rawOpen, rpc } from './helpers.js';
import { ManualClock } from './writes-helpers.js';

export const NOTIFICATIONS = fileURLToPath(new URL('./fixtures/notifications/device.json', import.meta.url));
export const NT = 'urn:example:notif';
export const NOTIF = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
export const NCN = 'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications';
export const CTL = 'urn:node-net:yang:net-netconf-server-control';

let cached: Promise<Device> | undefined;

/** The notifications device, loaded with the control module so servers that enable it needn't recompile it. */
export function notificationsDevice(): Promise<Device> {
  cached ??= loadDeviceFile(NOTIFICATIONS, { control: true });
  return cached;
}

/** The notifications device with its definition changed. */
export async function notificationsVariant(change: (def: DeviceDefinition) => DeviceDefinition, control = true): Promise<Device> {
  const def = change(JSON.parse(await readFile(NOTIFICATIONS, 'utf8')) as DeviceDefinition);
  const base = dirname(NOTIFICATIONS);
  return loadDevice(def, {
    directorySource: (dirs) => fileSource(dirs.map((d) => resolve(base, d))),
    resolvePath: (p) => resolve(base, p),
    readData: (p) => readFile(p),
    control,
  });
}

export type Session = Awaited<ReturnType<typeof rawOpen>>;

/** A client session that waits for replies by message-id. */
export interface Client {
  readonly raw: Session;
  /** Sends an operation and waits for its reply, however many notifications come first. */
  call(body: string): Promise<XmlElement>;
  /** Sends an operation without waiting; returns its message-id. */
  post(body: string): string;
  /** The reply to a message-id, if it has arrived. */
  reply(mid: string): XmlElement | undefined;
  /** The notifications received so far. */
  notifications(): XmlElement[];
  /** Waits until `n` notifications have arrived; returns them. */
  waitNotifications(n: number, ms?: number): Promise<XmlElement[]>;
}

let id = 5000;

export function client(raw: Session): Client {
  return {
    raw,
    async call(body) {
      const mid = String(++id);
      raw.send(chunk(rpc(body, `message-id="${mid}"`)));
      let found: XmlElement | undefined;
      await raw.until(() => (found = raw.messages.find((m) => m.name === 'rpc-reply' && m.attr('message-id') === mid)) !== undefined, 2000, `the reply to ${mid}`);
      return found!;
    },
    post(body) {
      const mid = String(++id);
      raw.send(chunk(rpc(body, `message-id="${mid}"`)));
      return mid;
    },
    reply: (mid) => raw.messages.find((m) => m.name === 'rpc-reply' && m.attr('message-id') === mid),
    notifications: () => raw.messages.filter((m) => m.name === 'notification'),
    async waitNotifications(n, ms = 2000) {
      await raw.until(() => raw.messages.filter((m) => m.name === 'notification').length >= n, ms, `${n} notifications`);
      return raw.messages.filter((m) => m.name === 'notification');
    },
  };
}

export function chunk(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`\n#${body.length}\n`);
  const tail = new TextEncoder().encode('\n##\n');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

/** A server for the notifications device on a manual clock, with one open session. */
export async function notifySession(options: Partial<ServerOptions> = {}): Promise<{ srv: NetconfServer; c: Client; clock: ManualClock; device: Device; open: (username?: string) => Promise<Client> }> {
  const clock = (options.clock as ManualClock | undefined) ?? new ManualClock();
  const device = (options.device as Device | undefined) ?? (await notificationsDevice());
  const srv = await createServer({ clock, ...options, device });
  const open = async (username = 'tester'): Promise<Client> => client(await rawOpen(srv, '1.1', username));
  return { srv, c: await open(), clock, device: srv.device, open };
}

/**
 * A base:1.1 session that keeps the bytes the server sends as text, for
 * quirks that break framing (which RawClient's decoder can't read).
 */
export async function byteSession(srv: NetconfServer, username = 'tester'): Promise<{ text: () => string; closed: () => boolean; send: (body: string) => void }> {
  const { connectionPair } = await import('@node-net/netconf/core');
  const [clientEnd, serverEnd] = connectionPair();
  let text = '';
  let closed = false;
  clientEnd.receive({ data: (b) => (text += new TextDecoder().decode(b)), end: () => undefined, close: () => (closed = true) });
  srv.serve(serverEnd, { principal: { username }, transport: 'test' });
  clientEnd.write(new TextEncoder().encode(`<hello xmlns="${NC}"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability><capability>urn:ietf:params:netconf:base:1.1</capability></capabilities></hello>]]>]]>`));
  return { text: () => text, closed: () => closed, send: (body) => clientEnd.write(chunk(rpc(body, `message-id="${++id}"`))) };
}

/** Polls until `check` holds, for up to a second. */
export async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

/** `<create-subscription>` with optional content (a filter). */
export function createSubscription(content = ''): string {
  return `<create-subscription xmlns="${NOTIF}">${content}</create-subscription>`;
}

/** A notification's eventTime text. */
export function eventTime(n: XmlElement): string | undefined {
  return n.child('eventTime', NOTIF)?.text();
}

/** A notification's content as RFC 7951 JSON, decoded with the device's schema. */
export function content(device: Device, n: XmlElement): JsonValue {
  return encodeJson(decodeXml(device.schema, n.elements.filter((e) => e.name !== 'eventTime'), { type: 'notification' }));
}

/** The name of a notification's content element. */
export function kind(n: XmlElement): string | undefined {
  return n.elements.find((e) => e.name !== 'eventTime')?.name;
}

export { NC };
