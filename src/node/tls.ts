/**
 * The NETCONF over TLS listener (Node only, RFC 7589, design §11, TLS-01):
 * mutual X.509 authentication against configured trust anchors, cert-to-name
 * for the username (cert-to-name.ts), then the Authenticate hook. Each TLS
 * connection is one session, handed to the server through `server.serve()`.
 *
 * Only the byte stream differs from SSH: hello, framing and everything above
 * are the same.
 */

import { X509Certificate } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import { duplexConnection, type Logger } from '@node-net/netconf';
import type { Authenticate, Listener, Serve } from '../auth.js';
import { certificateFingerprint, certToName, type CertToNameEntry } from './cert-to-name.js';
import { decide } from './decide.js';

/** RFC 7589 §2: the IANA port for NETCONF over TLS. */
export const NETCONF_TLS_PORT = 6513;

/** A PEM certificate, key or bundle. */
export type Pem = string | Buffer;

export interface TlsListenerOptions {
  /** The address to listen on. Default: every address. */
  readonly address?: string;
  /** Default 6513. 0 picks a free port (see address()). */
  readonly port?: number;
  /** The server's certificate (PEM), optionally followed by its intermediate CAs. */
  readonly cert: Pem;
  /** The private key for `cert` (PEM). */
  readonly key: Pem;
  readonly passphrase?: string;
  /**
   * Trust anchors for client certificates: every client must present a
   * certificate that chains to one of them. A self-signed client certificate
   * is trusted by listing it here. Node's public root store is never used.
   * List an intermediate CA here too when cert-to-name should match it, or
   * the anchor above it: a TLS server can't see intermediates a client sends.
   */
  readonly ca: Pem | readonly Pem[];
  /** How client certificates map to usernames (RFC 7407). */
  readonly certToName: readonly CertToNameEntry[];
  /** Decides each login, given the mapped username; staticUsers() is one. */
  readonly authenticate: Authenticate;
  /** How long `authenticate` has to decide, in milliseconds. Default 10 000. */
  readonly authTimeout?: number;
  /** How long a client has to finish the TLS handshake, in milliseconds. Default 10 000. */
  readonly handshakeTimeout?: number;
  readonly logger?: Logger;
}

export interface TlsListener extends Listener {
  /** Where it is listening, once started. */
  address(): { readonly address: string; readonly port: number } | undefined;
}

const MIN_VERSION = 'TLSv1.2';

/** A listener for NETCONF over TLS, started with `server.listen(tlsListener({ … }))`. */
export function tlsListener(options: TlsListenerOptions): TlsListener {
  const cas = typeof options.ca === 'string' || Buffer.isBuffer(options.ca) ? [options.ca] : [...options.ca];
  if (cas.length === 0) throw new TypeError('tlsListener needs at least one trust anchor (ca)');
  const anchors = cas.flatMap((pem, i) => certificatesIn(pem, `ca ${i + 1}`));
  const map = certToName(options.certToName);
  const logger = options.logger ?? {};
  const authTimeout = options.authTimeout ?? 10_000;
  let serverFingerprint: string;
  try {
    serverFingerprint = certificateFingerprint(new X509Certificate(options.cert).raw);
  } catch (err) {
    throw new TypeError(`tlsListener: cert is not a PEM certificate: ${(err as Error).message}`, { cause: err });
  }
  const sockets = new Set<TLSSocket>();
  let server: TlsServer | undefined;
  let closed = false;
  let listening = false;

  const onSecure = async (socket: TLSSocket, serve: Serve): Promise<void> => {
    const sourceHost = socket.remoteAddress;
    const peer = { host: sourceHost ?? '', port: socket.remotePort ?? 0 };
    // rejectUnauthorized has already refused anything else; this is a second lock on the same door.
    const chain = socket.authorized ? peerChain(socket, anchors) : [];
    const leaf = chain[0];
    if (leaf === undefined) {
      logger.info?.('Login refused', { method: 'certificate', reason: 'no verified client certificate', sourceHost });
      socket.destroy();
      return;
    }
    const fingerprint = certificateFingerprint(leaf.raw);
    const refuse = (reason: string, username?: string): void => {
      logger.info?.('Login refused', { method: 'certificate', reason, username, fingerprint, subject: leaf.subject, sourceHost });
      socket.destroy();
    };
    const match = map(chain);
    if (match === undefined) return refuse('no cert-to-name entry maps the certificate');
    const principal = await decide(
      options.authenticate,
      { method: 'certificate', username: match.username, certificate: { fingerprint, subject: leaf.subject, der: new Uint8Array(leaf.raw) }, ...(sourceHost === undefined ? {} : { sourceHost }) },
      authTimeout,
      logger,
    );
    if (principal === undefined) return refuse('the authenticate hook refused it', match.username);
    if (socket.destroyed) return;
    logger.debug?.('Certificate login', { username: principal.username, entryId: match.entryId, fingerprint, sourceHost });
    try {
      serve(duplexConnection(socket, { peer }), { principal, transport: 'tls', ...(sourceHost === undefined ? {} : { sourceHost }) });
    } catch (err) {
      logger.debug?.('Refused a session', { error: (err as Error).message, sourceHost });
      socket.destroy();
    }
  };

  return {
    async start(serve) {
      if (server !== undefined) throw new Error('This listener is already started');
      if (closed) throw new Error('This listener is closed');
      const s = createTlsServer({
        cert: options.cert,
        key: options.key,
        ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
        ca: cas,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: MIN_VERSION,
        handshakeTimeout: options.handshakeTimeout ?? 10_000,
      });
      s.on('secureConnection', (socket: TLSSocket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', (err: Error) => logger.debug?.('TLS connection error', { error: err.message, sourceHost: socket.remoteAddress }));
        // Anything unexpected while deciding refuses the client: it must never become an unhandled rejection.
        onSecure(socket, serve).catch((err: unknown) => {
          logger.error?.('TLS login failed with an error', { error: (err as Error).message, sourceHost: socket.remoteAddress });
          socket.destroy();
        });
      });
      // Reading the address caches it, so a handshake failure can still log it (remoteAddressOf).
      s.on('connection', (raw: Socket) => void raw.remoteAddress);
      // Handshake failures, including a missing or untrusted client certificate.
      s.on('tlsClientError', (err: Error, socket: TLSSocket) => {
        const failure = handshakeFailure(err, socket);
        // A refused certificate is a refused login; anything else is more likely a scanner.
        const context = { reason: failure.reason, code: failure.code, sourceHost: remoteAddressOf(socket) };
        if (failure.certificate) logger.info?.('TLS handshake failed', context);
        else logger.debug?.('TLS handshake failed', context);
      });
      server = s;
      await new Promise<void>((ok, fail) => {
        s.once('error', fail);
        s.listen(options.port ?? NETCONF_TLS_PORT, options.address, () => {
          s.off('error', fail);
          listening = true;
          ok();
        });
      });
      s.on('error', (err: Error) => logger.error?.('TLS listener error', { error: err.message }));
      const where = s.address() as AddressInfo;
      logger.info?.('Listening for NETCONF over TLS', { address: where.address, port: where.port, certificate: serverFingerprint });
    },

    close(closeOptions = {}) {
      closed = true;
      const s = server;
      if (closeOptions.endSessions === true) for (const socket of sockets) socket.destroy();
      if (s === undefined || !listening) return Promise.resolve();
      listening = false;
      // close() stops accepting at once; its callback waits for every connection, so don't.
      s.close();
      return Promise.resolve();
    },

    address() {
      const where = listening ? (server?.address() as AddressInfo | null | undefined) : undefined;
      return where === null || where === undefined ? undefined : { address: where.address, port: where.port };
    },
  };
}

/**
 * The client's address, for logging. Node destroys a socket whose certificate
 * it rejects before reporting it, and the address goes with it; the TCP socket
 * underneath (internal to Node, so best effort) still has it, read on
 * 'connection'.
 */
function remoteAddressOf(socket: TLSSocket): string | undefined {
  return socket.remoteAddress ?? (socket as TLSSocket & { _parent?: { remoteAddress?: string } })._parent?.remoteAddress;
}

/** What OpenSSL's verification codes mean for a client certificate. */
const VERIFY_REASONS: Readonly<Record<string, string>> = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the client certificate is not issued by a trusted CA',
  UNABLE_TO_GET_ISSUER_CERT: 'the client certificate is not issued by a trusted CA',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the client certificate is not issued by a trusted CA',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'the client certificate is self-signed and not a trust anchor',
  SELF_SIGNED_CERT_IN_CHAIN: "the client certificate's chain ends in an untrusted self-signed CA",
  CERT_HAS_EXPIRED: 'the client certificate has expired',
  CERT_NOT_YET_VALID: 'the client certificate is not yet valid',
  CERT_SIGNATURE_FAILURE: "the client certificate's signature is invalid",
  CERT_REVOKED: 'the client certificate is revoked',
  INVALID_PURPOSE: 'the client certificate is not for client authentication',
};

/**
 * Why a handshake failed, in words. Node reports a rejected client
 * certificate only as "socket hang up", with the real cause in the socket's
 * authorizationError; OpenSSL's own errors carry it inside a long string.
 */
function handshakeFailure(err: Error & { code?: string }, socket: Pick<TLSSocket, 'authorizationError'>): { reason: string; code?: string; certificate: boolean } {
  const verify = socket.authorizationError as unknown as string | null | undefined;
  if (typeof verify === 'string' && verify !== '') {
    return { reason: VERIFY_REASONS[verify] ?? `the client certificate failed verification (${verify})`, code: verify, certificate: true };
  }
  const code = err.code;
  if (code === 'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE') return { reason: 'the client sent no certificate', code, certificate: true };
  // "…:error:0A00010B:SSL routines:ssl3_get_record:wrong version number:…" → "wrong version number"
  const openssl = /:SSL routines:[^:]*:([^:]+):/.exec(err.message)?.[1];
  return { reason: openssl ?? err.message, ...(code === undefined ? {} : { code }), certificate: false };
}

/**
 * The client's certificate, then its issuers among the trust anchors, up to a
 * self-signed one. A TLS server in Node can't see the intermediates the
 * client sent, so an intermediate is in the chain (and cert-to-name can match
 * it, or the anchor above it) only when it is one of the configured trust
 * anchors.
 */
function peerChain(socket: TLSSocket, anchors: readonly X509Certificate[]): X509Certificate[] {
  const leaf = socket.getPeerX509Certificate();
  if (leaf === undefined) return [];
  const chain = [leaf];
  let current = leaf;
  while (chain.length < 16 && !selfIssued(current)) {
    const issuer = anchors.find((a) => !chain.includes(a) && current.checkIssued(a) && current.verify(a.publicKey));
    if (issuer === undefined) break;
    chain.push(issuer);
    current = issuer;
  }
  return chain;
}

function selfIssued(cert: X509Certificate): boolean {
  return cert.checkIssued(cert) && cert.verify(cert.publicKey);
}

/** Every certificate in a PEM bundle. */
function certificatesIn(pem: Pem, what: string): X509Certificate[] {
  const blocks = pem.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new TypeError(`tlsListener: ${what} has no PEM certificate`);
  return blocks.map((b) => {
    try {
      return new X509Certificate(b);
    } catch (err) {
      throw new TypeError(`tlsListener: ${what} is not a PEM certificate: ${(err as Error).message}`, { cause: err });
    }
  });
}
