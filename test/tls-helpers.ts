/**
 * Test support for TLS: the fixture certificates (scripts/tls-fixtures.sh),
 * their fingerprints, a server with a TLS listener on a free port, and
 * @node-net/netconf's real tls() client.
 */

import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { connect, tls, type NetconfClient } from '@node-net/netconf';
import {
  createServer,
  staticUsers,
  tlsListener,
  type Authenticate,
  type CertToNameEntry,
  type NetconfServer,
  type ServerOptions,
  type StaticUser,
  type TlsListener,
  type TlsListenerOptions,
} from '../src/index.js';
import { MINIMAL } from './helpers.js';
import { FIXTURES } from './ssh-helpers.js';

export const TLS_DIR = `${FIXTURES}tls/`;

/** A fixture file's text. */
export function pem(name: string): string {
  return readFileSync(`${TLS_DIR}${name}`, 'utf8');
}

/** A fixture certificate (the first in the file). */
export function cert(name: string): X509Certificate {
  return new X509Certificate(pem(`${name}.pem`));
}

/** RFC 7407 tls-fingerprint of a fixture certificate: algorithm octet, then the hash, hex with colons. */
export function tlsFingerprint(name: string, algorithm: 'sha224' | 'sha256' | 'sha384' | 'sha512' = 'sha256'): string {
  const octet = { sha224: '03', sha256: '04', sha384: '05', sha512: '06' }[algorithm];
  const hex = createHash(algorithm).update(cert(name).raw).digest('hex');
  return [octet, ...hex.match(/../g)!].join(':');
}

/** The leaf of a client fixture, then its chain to the trust anchor, as the listener sees it. */
export function chainOf(name: string): X509Certificate[] {
  const leaf = cert(name);
  const chain = [leaf];
  if (name === 'int-client') chain.push(cert('int'), cert('ca'));
  else if (name.startsWith('other-')) chain.push(cert('other-ca'));
  else if (name !== 'self-client') chain.push(cert('ca'));
  return chain;
}

/** Map anything the test CA issued by its subject CN. */
export const BY_CN: readonly CertToNameEntry[] = [{ id: 1, fingerprint: tlsFingerprint('ca'), mapType: 'common-name' }];

export interface TlsFixture {
  readonly server: NetconfServer;
  readonly listener: TlsListener;
  readonly port: number;
  close(): Promise<void>;
}

/** A server with a TLS listener on 127.0.0.1 and a free port, trusting the test CA. */
export async function tlsServer(
  options: {
    readonly users?: readonly StaticUser[];
    readonly authenticate?: Authenticate;
    readonly server?: Partial<ServerOptions>;
    readonly listener?: Partial<TlsListenerOptions>;
  } = {},
): Promise<TlsFixture> {
  const server = await createServer({ device: MINIMAL, ...options.server });
  const listener = tlsListener({
    address: '127.0.0.1',
    port: 0,
    cert: pem('server.pem'),
    key: pem('server.key'),
    ca: pem('ca.pem'),
    certToName: BY_CN,
    authenticate: options.authenticate ?? staticUsers(options.users ?? [{ username: 'netconf' }]),
    ...(options.server?.logger === undefined ? {} : { logger: options.server.logger }),
    ...options.listener,
  });
  await server.listen(listener);
  return { server, listener, port: listener.address()!.port, close: () => server.close() };
}

/** @node-net/netconf over TLS to a test server, as a fixture client. */
export function tlsClient(port: number, client = 'client'): Promise<NetconfClient> {
  return connect({
    transport: tls({ host: '127.0.0.1', port, cert: pem(`${client}.pem`), key: pem(`${client}.key`), ca: pem('ca.pem') }),
  });
}

/**
 * A raw TLS connection: resolves with what the server sent before closing
 * (or within `wait` ms), and whether the handshake completed. A server that
 * accepts a client sends its NETCONF hello at once.
 */
export function rawTls(port: number, options: ConnectionOptions = {}, wait = 3_000): Promise<{ data: string; error?: string }> {
  return new Promise((ok) => {
    let data = '';
    let error: string | undefined;
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: pem('ca.pem'), servername: 'localhost', ...options });
    const done = (): void => {
      clearTimeout(timer);
      socket.destroy();
      ok({ data, ...(error === undefined ? {} : { error }) });
    };
    const timer = setTimeout(done, wait);
    socket.on('data', (d: Buffer) => {
      data += d.toString('utf8');
      if (data.includes('</hello>')) done();
    });
    socket.on('error', (e: Error) => {
      error = e.message;
    });
    socket.on('close', done);
  });
}
