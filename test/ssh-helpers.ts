/**
 * Test support for SSH and nncd: a server with an SSH listener on a free
 * port, @node-net/netconf's real ssh() client, a raw ssh2 client for what
 * @node-net/netconf never sends, client keys, a recording logger, and nncd run as
 * a subprocess from the built package.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, ssh, INSECURE_ACCEPT_ANY, type Logger, type NetconfClient } from '@node-net/netconf';
import ssh2 from 'ssh2';
import {
  createServer,
  generateHostKey,
  sshListener,
  staticUsers,
  type Authenticate,
  type NetconfServer,
  type ServerOptions,
  type SshListener,
  type SshListenerOptions,
  type StaticUser,
} from '../src/index.js';
import { MINIMAL } from './helpers.js';

const { parseKey, generateKeyPairSync } = ssh2.utils;

export const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
export const NNCD = join(PKG_DIR, 'bin/nncd.js');
export const WRITES_DEVICE = fileURLToPath(new URL('./fixtures/writes/device.json', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** One host key for the whole file: generating keys is slow-ish. */
export const HOST_KEY = generateHostKey();

/** An ed25519 client key pair ssh2 can parse (see the keygen flake note in generateHostKey). */
export function clientKey(): { private: string; public: string } {
  for (let i = 0; i < 20; i++) {
    const pair = generateKeyPairSync('ed25519');
    if (!(parseKey(pair.private) instanceof Error) && !(parseKey(pair.public) instanceof Error)) return pair;
  }
  throw new Error('could not generate a client key');
}

export interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly context: Record<string, unknown>;
}

/** A logger that keeps every entry. */
export function recordingLogger(): { logger: Required<Logger>; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at = (level: string) => (message: string, context: Record<string, unknown> = {}): void => void entries.push({ level, message, context });
  return { logger: { trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, entries };
}

export interface SshFixture {
  readonly server: NetconfServer;
  readonly listener: SshListener;
  readonly port: number;
  close(): Promise<void>;
}

/** A server with an SSH listener on 127.0.0.1 and a free port. */
export async function sshServer(
  options: {
    readonly users?: readonly StaticUser[];
    readonly authenticate?: Authenticate;
    readonly server?: Partial<ServerOptions>;
    readonly listener?: Partial<SshListenerOptions>;
  } = {},
): Promise<SshFixture> {
  const server = await createServer({ device: MINIMAL, ...options.server });
  const listener = sshListener({
    address: '127.0.0.1',
    port: 0,
    hostKeys: [HOST_KEY],
    authenticate: options.authenticate ?? staticUsers(options.users ?? [{ username: 'netconf', password: 'netconf', lab: true }]),
    ...(options.server?.logger === undefined ? {} : { logger: options.server.logger }),
    ...options.listener,
  });
  await server.listen(listener);
  return { server, listener, port: listener.address()!.port, close: () => server.close() };
}

/** @node-net/netconf over SSH to a test server. */
export function sshClient(
  port: number,
  auth: { readonly username?: string; readonly password?: string; readonly privateKey?: string } = {},
): Promise<NetconfClient> {
  return connect({
    transport: ssh({
      host: '127.0.0.1',
      port,
      username: auth.username ?? 'netconf',
      ...(auth.privateKey === undefined ? { password: auth.password ?? 'netconf' } : { privateKey: auth.privateKey }),
      hostKey: INSECURE_ACCEPT_ANY,
    }),
  });
}

/** A raw ssh2 client, logged in with a password. */
export function rawSsh(port: number, username = 'netconf', password = 'netconf'): Promise<ssh2.Client> {
  return new Promise((ok, fail) => {
    const c = new ssh2.Client();
    c.once('ready', () => ok(c));
    c.once('error', fail);
    c.connect({ host: '127.0.0.1', port, username, password, hostVerifier: () => true });
  });
}

/** Open a subsystem on a raw client; resolves with the channel or rejects when refused. */
export function subsystem(client: ssh2.Client, name: string): Promise<ssh2.ClientChannel> {
  return new Promise((ok, fail) => client.subsys(name, (err, channel) => (err ? fail(err) : ok(channel))));
}

/** Read from a channel until `pattern` has arrived. */
export function readUntil(channel: NodeJS.ReadableStream, pattern: RegExp, timeout = 5_000): Promise<string> {
  return new Promise((ok, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error(`timed out waiting for ${pattern}; got ${JSON.stringify(text)}`)), timeout);
    const onData = (d: Buffer): void => {
      text += d.toString('utf8');
      if (pattern.test(text)) {
        clearTimeout(timer);
        channel.off('data', onData);
        ok(text);
      }
    };
    channel.on('data', onData);
  });
}

// --- nncd as a subprocess ---------------------------------------------------

/** nncd runs from the built package: fail clearly when the build is missing or stale. */
function requireBuild(): void {
  const built = join(PKG_DIR, 'dist/node/nncd.js');
  if (!existsSync(built)) throw new Error('dist/ is missing: run npm run build before these tests (npm run check does)');
  const src = join(PKG_DIR, 'src/node/nncd.ts');
  if (statSync(src).mtimeMs > statSync(built).mtimeMs) throw new Error('dist/ is older than src/: run npm run build');
}

export async function tempDir(prefix = 'nncd-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Write a config into a new temporary directory; returns its path. */
export async function writeConfig(config: Record<string, unknown>, dir?: string): Promise<string> {
  const d = dir ?? (await tempDir());
  const file = join(d, 'server.json');
  await writeFile(file, JSON.stringify(config, null, 2));
  return file;
}

export interface NncdResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run nncd to completion. */
export function runNncd(args: readonly string[], options: { readonly input?: string; readonly cwd?: string; readonly timeout?: number } = {}): Promise<NncdResult> {
  requireBuild();
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [NNCD, ...args], { cwd: options.cwd ?? PKG_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`nncd ${args.join(' ')} timed out\n${stderr}`));
    }, options.timeout ?? 20_000);
    child.on('error', fail);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      ok({ code, signal, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}

export interface RunningNncd {
  readonly child: ChildProcess;
  readonly port: number;
  /** Everything written to stderr so far. */
  stderr(): string;
  /** Resolves with the exit code once it has exited. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Wait until stderr matches. */
  waitFor(pattern: RegExp, timeout?: number): Promise<void>;
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Start nncd and wait until it is listening. */
export async function startNncd(args: readonly string[], options: { readonly cwd?: string } = {}): Promise<RunningNncd> {
  requireBuild();
  const child = spawn(process.execPath, [NNCD, ...args], { cwd: options.cwd ?? PKG_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  const waiters: (() => void)[] = [];
  child.stderr.on('data', (d: Buffer) => {
    err += d.toString();
    for (const w of [...waiters]) w();
  });
  child.stdout.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((ok) => child.on('close', (code, signal) => ok({ code, signal })));
  const waitFor = (pattern: RegExp, timeout = 15_000): Promise<void> =>
    new Promise((ok, fail) => {
      const check = (): void => {
        if (pattern.test(err)) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          ok();
        }
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        fail(new Error(`nncd never logged ${pattern}:\n${err}`));
      }, timeout);
      waiters.push(check);
      void exited.then(() => check());
      check();
    });
  await Promise.race([
    waitFor(/nncd started/),
    exited.then((e) => {
      throw new Error(`nncd exited (${e.code ?? e.signal}) before it started:\n${err}`);
    }),
  ]);
  const port = Number(/port=(\d+)/.exec(err)?.[1]);
  return {
    child,
    port,
    stderr: () => err,
    exited,
    waitFor,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      return exited;
    },
  };
}

/**
 * A config for nncd on the writes fixture device and the lab user
 * netconf/netconf. Without `listen`, SSH on 127.0.0.1 and a free port; each
 * listener `listen` names gets those defaults under what it gives.
 */
export function baseConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const local = { address: '127.0.0.1', port: 0 };
  const given = extra['listen'] as Record<string, object> | undefined;
  const listen =
    given === undefined ? { ssh: local } : Object.fromEntries(Object.entries(given).map(([k, v]) => [k, { ...local, ...v }]));
  return {
    device: WRITES_DEVICE,
    users: [{ username: 'netconf', password: 'netconf', lab: true }],
    ...extra,
    listen,
  };
}
