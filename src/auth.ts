/**
 * Authentication and listeners (design §11), as types the core can name: a
 * transport such as SSH (Node only, @node-net/netconf-server's root entry)
 * authenticates its clients through an `Authenticate` hook and hands each
 * connection to the server through `server.serve()`.
 */

import type { Connection } from '@node-net/netconf/core';
import type { Principal } from './session/session.js';

/** A login attempt with a password. */
export interface PasswordAttempt {
  readonly method: 'password';
  readonly username: string;
  readonly password: string;
  /** The client's address, when the transport knows it. */
  readonly sourceHost?: string;
}

/**
 * A login attempt with a public key. The transport has already checked that
 * the client holds the private key; the hook decides whether the key is
 * authorized for the user.
 */
export interface PublicKeyAttempt {
  readonly method: 'publickey';
  readonly username: string;
  readonly key: {
    /** The key's SSH algorithm, such as `ssh-ed25519`. */
    readonly algorithm: string;
    /** The public key in SSH wire format, as in an authorized_keys line after base64 decoding. */
    readonly data: Uint8Array;
  };
  readonly sourceHost?: string;
}

/**
 * A TLS login with a client certificate (RFC 7589). The transport has already
 * checked that the certificate chains to a trust anchor and mapped it to
 * `username` with cert-to-name; the hook can still refuse it.
 */
export interface CertificateAttempt {
  readonly method: 'certificate';
  /** The name cert-to-name mapped the certificate to. */
  readonly username: string;
  readonly certificate: {
    /** The client certificate's SHA-256 fingerprint, `SHA256:<base64>`. */
    readonly fingerprint: string;
    /** Its subject, one `KEY=value` per line. */
    readonly subject: string;
    /** The certificate in DER, for hooks that need more of it. */
    readonly der: Uint8Array;
  };
  readonly sourceHost?: string;
}

export type AuthAttempt = PasswordAttempt | PublicKeyAttempt | CertificateAttempt;

/**
 * Decides a login attempt (SSH-04): a principal accepts it, undefined
 * refuses it. A hook that throws or takes too long refuses it too, and the
 * transport logs the error. The built-in static users are one of these.
 */
export type Authenticate = (attempt: AuthAttempt) => Principal | undefined | Promise<Principal | undefined>;

/** How a transport describes an authenticated connection to `server.serve()`. */
export interface ServeOptions {
  /** Who the session is authenticated as. */
  readonly principal: Principal;
  /** The transport's name, for events and logs, such as `ssh`, `tls` or `in-process`. */
  readonly transport: string;
  /** The client's address, for NETCONF monitoring's source-host, when the transport knows it. */
  readonly sourceHost?: string;
}

/** What a listener hands each authenticated connection to. */
export type Serve = (connection: Connection, options: ServeOptions) => void;

/** A source of connections, such as the SSH listener, started by `server.listen()`. */
export interface Listener {
  /** Start accepting connections and pass each to `serve`. Resolves once it is listening. */
  start(serve: Serve): Promise<void>;
  /** Stop accepting connections; with `endSessions`, also drop the ones this listener accepted. Idempotent. */
  close(options?: { readonly endSessions?: boolean }): Promise<void>;
}
