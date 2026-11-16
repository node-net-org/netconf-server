/**
 * Test support: a server for a small device, and a raw client that speaks
 * framed bytes over an in-memory connection, so tests can send what a real
 * client never would.
 */

import { connectionPair, FrameDecoder, NETCONF_NS, parseXml, type Connection, type XmlElement } from '@node-net/netconf/core';
import { createServer, type NetconfServer, type ServerOptions } from '../src/core.js';
import type { DeviceDefinition } from '../src/core.js';

export const BASE_1_0 = 'urn:ietf:params:netconf:base:1.0';
export const BASE_1_1 = 'urn:ietf:params:netconf:base:1.1';
export const NC = NETCONF_NS;

export const MINIMAL: DeviceDefinition = { id: 'test', yang: { modules: [] } };

export function server(options: Partial<ServerOptions> = {}): Promise<NetconfServer> {
  return createServer({ device: MINIMAL, ...options });
}

const encoder = new TextEncoder();

export function eom(text: string): Uint8Array {
  return encoder.encode(`${text}]]>]]>`);
}

export function chunked(text: string, chunkSize = Infinity): Uint8Array {
  const bytes = encoder.encode(text);
  // Chunks split on byte boundaries, so a multi-byte character may straddle two.
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const piece = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    out.push(encoder.encode(`\n#${piece.length}\n`), piece);
  }
  out.push(encoder.encode('\n##\n'));
  const total = out.reduce((n, p) => n + p.length, 0);
  const frame = new Uint8Array(total);
  let at = 0;
  for (const p of out) {
    frame.set(p, at);
    at += p.length;
  }
  return frame;
}

export function hello(caps: readonly string[] = [BASE_1_0, BASE_1_1], extra = ''): string {
  return `<hello xmlns="${NC}"><capabilities>${caps.map((c) => `<capability>${c}</capability>`).join('')}</capabilities>${extra}</hello>`;
}

export function rpc(body: string, attrs = 'message-id="1"'): string {
  return `<rpc xmlns="${NC}" ${attrs}>${body}</rpc>`;
}

/** A client end that records what the server sends, decoded with the framing in use. */
export class RawClient {
  readonly messages: XmlElement[] = [];
  readonly texts: string[] = [];
  closed = false;
  readonly #decoder = new FrameDecoder();
  #waiters: (() => void)[] = [];

  constructor(readonly connection: Connection) {
    connection.receive({
      data: (chunk) => {
        this.#decoder.push(chunk);
        for (let t = this.#decoder.next(); t !== undefined; t = this.#decoder.next()) {
          this.texts.push(t);
          this.messages.push(parseXml(t));
          this.#wake();
        }
      },
      end: () => undefined,
      close: () => {
        this.closed = true;
        this.#wake();
      },
    });
  }

  /** Switch our decoder to chunked, as after a base:1.1 hello. */
  useChunked(): void {
    this.#decoder.setMode('chunked');
  }

  send(bytes: Uint8Array | string): void {
    this.connection.write(typeof bytes === 'string' ? encoder.encode(bytes) : bytes);
  }

  /** Waits until `n` messages have arrived (the server hello counts), or fails. */
  async waitFor(n: number, ms = 2000): Promise<XmlElement> {
    await this.until(() => this.messages.length >= n, ms, `${n} messages (have ${this.messages.length})`);
    return this.messages[n - 1]!;
  }

  async waitClosed(ms = 2000): Promise<void> {
    await this.until(() => this.closed, ms, 'the connection to close');
  }

  async until(check: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }

  #wake(): void {
    const w = this.#waiters;
    this.#waiters = [];
    for (const f of w) f();
  }
}

/** Opens a raw session on `srv`: returns the client after the server hello arrived. */
export async function raw(srv: NetconfServer, username = 'tester'): Promise<RawClient> {
  const [client, serverEnd] = connectionPair();
  srv.serve(serverEnd, { principal: { username }, transport: 'test' });
  const c = new RawClient(client);
  await c.waitFor(1);
  return c;
}

/** A raw session past the hellos, in base:1.1 (chunked) or base:1.0 (EOM). */
export async function rawOpen(srv: NetconfServer, version: '1.0' | '1.1' = '1.1', username = 'tester'): Promise<RawClient & { request(text: string): Promise<XmlElement> }> {
  const c = await raw(srv, username);
  c.send(eom(hello(version === '1.1' ? [BASE_1_0, BASE_1_1] : [BASE_1_0])));
  if (version === '1.1') c.useChunked();
  await c.until(() => srv.sessions.length > 0, 2000, 'the session to open');
  const send = (text: string): Uint8Array => (version === '1.1' ? chunked(text) : eom(text));
  return Object.assign(c, {
    async request(text: string): Promise<XmlElement> {
      const n = c.messages.length + 1;
      c.send(send(text));
      return c.waitFor(n);
    },
  });
}

export function errorTag(reply: XmlElement): string | undefined {
  return reply.child('rpc-error', NC)?.child('error-tag', NC)?.text();
}

export function errorInfo(reply: XmlElement, name: string): string | undefined {
  return reply.child('rpc-error', NC)?.child('error-info', NC)?.child(name, NC)?.text();
}
