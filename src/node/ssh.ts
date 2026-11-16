/**
 * The NETCONF SSH listener (Node only, RFC 6242, design §11, SSH-01): the
 * `netconf` subsystem, each channel one session, handed to the server
 * through `server.serve()` with the principal its login produced.
 */

import type { AddressInfo } from 'node:net';
import { duplexConnection, type Logger } from '@node-net/netconf';
import ssh2, { type AuthContext, type Connection as SshClient, type ServerChannel } from 'ssh2';
import type { Authenticate, AuthAttempt, Listener, Serve } from '../auth.js';
import type { Principal } from '../session/session.js';
import { decide as decideWith } from './decide.js';
import type { HostKey } from './host-keys.js';

const { Server } = ssh2;
const { parseKey } = ssh2.utils;

/** RFC 6242 §2: the IANA port for NETCONF over SSH. */
export const NETCONF_SSH_PORT = 830;

const METHODS: AuthContext['method'][] = ['publickey', 'password'];

export interface SshListenerOptions {
  /** The address to listen on. Default: every address. */
  readonly address?: string;
  /** Default 830. 0 picks a free port (see address()). */
  readonly port?: number;
  /** From loadHostKeys(), or private keys as text. */
  readonly hostKeys: readonly (HostKey | string)[];
  /** Decides each login attempt; staticUsers() is one. */
  readonly authenticate: Authenticate;
  /** How long `authenticate` has to decide, in milliseconds. Default 10 000. */
  readonly authTimeout?: number;
  /** Failed attempts before the connection is dropped. Default 6. */
  readonly maxAuthTries?: number;
  readonly logger?: Logger;
}

export interface SshListener extends Listener {
  /** Where it is listening, once started. */
  address(): { readonly address: string; readonly port: number } | undefined;
}

/** A listener for NETCONF over SSH, started with `server.listen(sshListener({ … }))`. */
export function sshListener(options: SshListenerOptions): SshListener {
  if (options.hostKeys.length === 0) throw new TypeError('sshListener needs at least one host key');
  const logger = options.logger ?? {};
  const authTimeout = options.authTimeout ?? 10_000;
  const maxAuthTries = options.maxAuthTries ?? 6;
  const keys = options.hostKeys.map((k) => (typeof k === 'string' ? k : k.privateKey));
  const clients = new Set<SshClient>();
  let server: InstanceType<typeof Server> | undefined;
  let closed = false;
  let listening = false;

  const decide = (attempt: AuthAttempt): Promise<Principal | undefined> => decideWith(options.authenticate, attempt, authTimeout, logger);

  const onClient = (client: SshClient, info: { ip: string; port: number }, serve: Serve): void => {
    clients.add(client);
    const peer = { host: info.ip, port: info.port };
    let principal: Principal | undefined;
    let failures = 0;
    let channels = 0;

    const refuse = (ctx: AuthContext, method: string): void => {
      failures++;
      logger.info?.('Login refused', { username: ctx.username, method, sourceHost: info.ip });
      if (failures >= maxAuthTries) {
        ctx.reject();
        client.end();
      } else ctx.reject(METHODS);
    };

    client.on('authentication', (ctx) => {
      void (async () => {
        if (ctx.method === 'password') {
          const p = await decide({ method: 'password', username: ctx.username, password: ctx.password, sourceHost: info.ip });
          if (p === undefined) return refuse(ctx, 'password');
          principal = p;
          return ctx.accept();
        }
        if (ctx.method === 'publickey') {
          // A query without a signature is accepted whatever the key, so no one can probe which keys are authorized.
          if (ctx.signature === undefined || ctx.blob === undefined) return ctx.accept();
          const key = parseKey(ctx.key.data);
          const parsed = Array.isArray(key) ? (key[0] as ssh2.ParsedKey | undefined) : key;
          if (parsed === undefined || parsed instanceof Error || parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
            return refuse(ctx, 'publickey');
          }
          const p = await decide({ method: 'publickey', username: ctx.username, key: { algorithm: ctx.key.algo, data: new Uint8Array(ctx.key.data) }, sourceHost: info.ip });
          if (p === undefined) return refuse(ctx, 'publickey');
          principal = p;
          return ctx.accept();
        }
        // none, keyboard-interactive and hostbased: say what is on offer.
        ctx.reject(METHODS);
      })();
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('subsystem', (acceptSubsystem, reject, request) => {
          if (request.name !== 'netconf' || principal === undefined) {
            logger.debug?.('Refused a subsystem other than netconf', { subsystem: request.name, sourceHost: info.ip });
            reject();
            return;
          }
          const channel: ServerChannel = acceptSubsystem();
          channels++;
          channel.on('close', () => {
            // The connection goes when its last NETCONF channel does.
            if (--channels === 0) client.end();
          });
          try {
            serve(duplexConnection(channel, { peer }), { principal, transport: 'ssh', sourceHost: info.ip });
          } catch (err) {
            logger.debug?.('Refused a session', { error: (err as Error).message, sourceHost: info.ip });
          }
        });
        // ssh2 refuses requests nobody listens for (pty, env, sftp and the rest); these are logged too.
        session.on('exec', (_accept, reject, request) => {
          logger.debug?.('Refused an exec request', { command: request.command, sourceHost: info.ip });
          reject();
        });
        session.on('shell', (_accept, reject) => {
          logger.debug?.('Refused a shell request', { sourceHost: info.ip });
          reject();
        });
      });
    });
    client.on('error', (err) => logger.debug?.('SSH connection error', { error: err.message, sourceHost: info.ip }));
    client.on('close', () => clients.delete(client));
  };

  return {
    async start(serve) {
      if (server !== undefined) throw new Error('This listener is already started');
      if (closed) throw new Error('This listener is closed');
      const s = new Server({ hostKeys: keys }, (client, info) => onClient(client, info, serve));
      server = s;
      await new Promise<void>((ok, fail) => {
        s.once('error', fail);
        s.listen(options.port ?? NETCONF_SSH_PORT, options.address, () => {
          s.off('error', fail);
          listening = true;
          ok();
        });
      });
      s.on('error', (err: Error) => logger.error?.('SSH listener error', { error: err.message }));
      const where = s.address() as AddressInfo;
      logger.info?.('Listening for NETCONF over SSH', {
        address: where.address,
        port: where.port,
        hostKeys: options.hostKeys.map((k) => (typeof k === 'string' ? 'given' : `${k.algorithm} ${k.fingerprint}`)).join(', '),
      });
    },

    close(closeOptions = {}) {
      closed = true;
      const s = server;
      if (closeOptions.endSessions === true) for (const c of clients) c.end();
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
