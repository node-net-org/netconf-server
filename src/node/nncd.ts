/**
 * nncd (Node only, design §14, NNCD-01 to NNCD-05): a thin main over the
 * library API, driven by a deployment config. It checks everything before
 * it listens, logs structured lines to stderr, and shuts down cleanly on a
 * signal.
 *
 * Exit status: 0 after a clean shutdown or a passing --check; 1 when
 * something the config names can't be used; 2 for a usage error or a
 * config that breaks its schema; 130 for a second signal during shutdown.
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { LOG_LEVELS, type Logger, type LogLevel } from '@node-net/netconf';
import { createServer, type NetconfServer } from '../server.js';
import { ConfigError, prepareServer, readServerConfig, StartError } from './config.js';
import { sshListener, type SshListener } from './ssh.js';
import { tlsListener, type TlsListener } from './tls.js';
import { hashPassword } from './users.js';

/** Where nncd writes; the defaults are the process's streams. */
export interface NncdIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly stdin: NodeJS.ReadStream;
  /** Called once the server is up, for embedding and tests. */
  readonly onStarted?: (server: NetconfServer) => void;
  /** A second signal during shutdown; exits at once. */
  readonly exitNow?: (code: number) => never;
  /** Where signals come from. Default: the process. */
  readonly signals?: Pick<NodeJS.Process, 'on' | 'off'>;
}

const USAGE = `Usage:
  nncd --config <server.json> [--check] [--log-level <level>]
  nncd hash-password
  nncd --help | --version

Runs a NETCONF server (@node-net/netconf-server) from a deployment config.

Options:
  -c, --config <file>     The deployment config (server.json)
      --check             Check the config and everything it names, then exit
                          without listening
  -l, --log-level <level> trace, debug, info, warn, error or silent
                          (default: the config's logLevel, else info)
  -h, --help              Show this help
  -v, --version           Show the version

Commands:
  hash-password           Read a password (typed at a prompt, or piped on
                          stdin) and print a hash for a user's passwordHash

The config names modules to import, so it is trusted like code.
Exit status: 0 clean shutdown or check passed, 1 something the config names
can't be used, 2 usage or schema error, 130 second signal during shutdown.
`;

/** Run nncd with its arguments (without node and the script). Resolves to the exit status. */
export async function main(argv: readonly string[], io: Partial<NncdIo> = {}): Promise<number> {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (e) {
    err.write(`nncd: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = args;
  if (values.help === true) {
    out.write(USAGE);
    return 0;
  }
  if (values.version === true) {
    out.write(`${await version()}\n`);
    return 0;
  }
  if (positionals[0] === 'hash-password') {
    if (positionals.length > 1) {
      err.write(`nncd: hash-password takes no arguments\n`);
      return 2;
    }
    return hashPasswordCommand(io.stdin ?? process.stdin, out, err);
  }
  if (positionals.length > 0) {
    err.write(`nncd: unknown command ${positionals[0]}\n\n${USAGE}`);
    return 2;
  }
  if (values.config === undefined) {
    err.write(`nncd: --config is required\n\n${USAGE}`);
    return 2;
  }
  if (values['log-level'] !== undefined && !(LOG_LEVELS as readonly string[]).includes(values['log-level'])) {
    err.write(`nncd: --log-level is one of ${LOG_LEVELS.join(', ')}\n`);
    return 2;
  }

  // Until the config says otherwise, problems are logged at info.
  const logger = new StderrLogger(err, (values['log-level'] as LogLevel | undefined) ?? 'info');
  let loaded;
  try {
    loaded = await readServerConfig(values.config);
  } catch (e) {
    return fail(e, err);
  }
  if (values['log-level'] === undefined && loaded.config.logLevel !== undefined) logger.level = loaded.config.logLevel;

  const check = values.check === true;
  let server: NetconfServer;
  const listening: { readonly transport: string; readonly listener: SshListener | TlsListener }[] = [];
  try {
    const prepared = await prepareServer(loaded, { logger, check });
    if (check) {
      out.write(`${loaded.file}: OK (device ${prepared.options.device.id})\n`);
      return 0;
    }
    try {
      server = await createServer(prepared.options);
    } catch (e) {
      throw new StartError(prepared.options.device.id, `Can't start the server: ${(e as Error).message}`, { cause: e });
    }
    const { ssh, tls } = prepared.listeners;
    const wanted = [
      ...(ssh === undefined ? [] : [{ transport: 'ssh', config: ssh, listener: sshListener({ ...ssh, authenticate: prepared.authenticate, logger }) }]),
      ...(tls === undefined ? [] : [{ transport: 'tls', config: tls, listener: tlsListener({ ...tls, authenticate: prepared.authenticate, logger }) }]),
    ];
    for (const w of wanted) {
      try {
        await server.listen(w.listener);
      } catch (e) {
        await server.close();
        const where = `${w.config.address ?? '*'}:${w.config.port}`;
        throw new StartError(where, `Can't listen for ${w.transport.toUpperCase()} on ${where}: ${(e as Error).message}`, { cause: e });
      }
      listening.push(w);
    }
  } catch (e) {
    return fail(e, err);
  }

  // Handlers first: a signal right after the started line must still shut down cleanly.
  const stopped = shutdownOnSignal(server, logger, io);
  const where = (transport: string) => listening.find((l) => l.transport === transport)?.listener.address();
  // The first listener's address and port stay as plain fields, as before; each listener's has its own too.
  const first = listening[0]?.listener.address();
  logger.info?.('nncd started', {
    device: server.device.id,
    address: first?.address,
    port: first?.port,
    ssh: format(where('ssh')),
    tls: format(where('tls')),
    config: loaded.file,
  });
  io.onStarted?.(server);
  await stopped;
  return 0;
}

/** `address:port`, bracketing an IPv6 address; undefined stays undefined so the log leaves it out. */
function format(where: { readonly address: string; readonly port: number } | undefined): string | undefined {
  if (where === undefined) return undefined;
  return `${where.address.includes(':') ? `[${where.address}]` : where.address}:${where.port}`;
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string', short: 'c' },
      check: { type: 'boolean' },
      'log-level': { type: 'string', short: 'l' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

function fail(e: unknown, err: NncdIo['stderr']): number {
  if (e instanceof ConfigError) {
    err.write(`nncd: ${e.message}\n`);
    return 2;
  }
  if (e instanceof StartError) {
    err.write(`nncd: ${e.message}\n`);
    return 1;
  }
  err.write(`nncd: ${(e as Error).stack ?? String(e)}\n`);
  return 1;
}

/** Wait for SIGINT or SIGTERM, then close the server. A second signal exits at once with 130. */
function shutdownOnSignal(server: NetconfServer, logger: StderrLogger, io: Partial<NncdIo>): Promise<void> {
  const signals = io.signals ?? process;
  const exitNow = io.exitNow ?? ((code: number): never => process.exit(code));
  return new Promise((done) => {
    let stopping = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (stopping) {
        logger.warn?.('Second signal: exiting now', { signal });
        exitNow(130);
        return;
      }
      stopping = true;
      logger.info?.('Shutting down', { signal });
      server.close().then(
        () => {
          signals.off('SIGINT', onSignal);
          signals.off('SIGTERM', onSignal);
          logger.info?.('nncd stopped');
          done();
        },
        (e: unknown) => {
          logger.error?.('Shutdown failed', { error: (e as Error).message });
          exitNow(1);
        },
      );
    };
    signals.on('SIGINT', onSignal);
    signals.on('SIGTERM', onSignal);
  });
}

async function version(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

// --- hash-password ----------------------------------------------------------

async function hashPasswordCommand(stdin: NodeJS.ReadStream, out: NncdIo['stdout'], err: NncdIo['stderr']): Promise<number> {
  let password: string;
  try {
    if (stdin.isTTY === true) {
      password = await promptHidden(stdin, err, 'Password: ');
      const again = await promptHidden(stdin, err, 'Again: ');
      if (again !== password) {
        err.write('nncd: the passwords differ\n');
        return 1;
      }
    } else {
      password = (await readAll(stdin)).replace(/\r?\n$/, '');
    }
  } catch (e) {
    err.write(`nncd: ${(e as Error).message}\n`);
    return 130;
  }
  if (password.length === 0) {
    err.write('nncd: the password is empty\n');
    return 1;
  }
  out.write(`${await hashPassword(password)}\n`);
  return 0;
}

async function readAll(stdin: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

/** Read a line from a terminal without echoing it. */
function promptHidden(stdin: NodeJS.ReadStream, err: NncdIo['stderr'], prompt: string): Promise<string> {
  return new Promise((ok, fail) => {
    let text = '';
    // Echo off before the prompt shows, so nothing typed after it is echoed.
    stdin.setRawMode(true);
    stdin.resume();
    err.write(prompt);
    const finish = (error?: Error): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      err.write('\n');
      if (error === undefined) ok(text);
      else fail(error);
    };
    const onData = (data: Buffer): void => {
      for (const ch of data.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003' || ch === '\u0004') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// --- logging ----------------------------------------------------------------

const ORDER: readonly LogLevel[] = LOG_LEVELS;

/**
 * @node-net/netconf's Logger, writing one line per entry to stderr (NNCD-04):
 * the time, the level, the message and the context as key=value pairs
 * (session id, username and message-id where the server gives them). Only
 * the enabled levels have a method, so `if (logger.trace)` stays free and
 * nothing is formatted or redacted for a level nobody reads.
 */
export class StderrLogger implements Logger {
  trace?: (message: string, context?: Record<string, unknown>) => void;
  debug?: (message: string, context?: Record<string, unknown>) => void;
  info?: (message: string, context?: Record<string, unknown>) => void;
  warn?: (message: string, context?: Record<string, unknown>) => void;
  error?: (message: string, context?: Record<string, unknown>) => void;
  #level: LogLevel = 'info';

  constructor(
    private readonly stream: NncdIo['stderr'],
    level: LogLevel = 'info',
    private readonly now: () => Date = () => new Date(),
  ) {
    this.level = level;
  }

  get level(): LogLevel {
    return this.#level;
  }

  set level(level: LogLevel) {
    this.#level = level;
    const from = ORDER.indexOf(level);
    for (const name of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
      const self = this as Record<string, unknown>;
      if (ORDER.indexOf(name) >= from) self[name] = (message: string, context?: Record<string, unknown>): void => this.#write(name, message, context);
      else delete self[name];
    }
  }

  #write(level: Exclude<LogLevel, 'silent'>, message: string, context: Record<string, unknown> = {}): void {
    let line = `${this.now().toISOString()} ${level.padEnd(5)} ${quote(message)}`;
    for (const [k, v] of Object.entries(context)) {
      if (v === undefined) continue;
      line += ` ${k}=${quote(typeof v === 'string' ? v : (JSON.stringify(v) ?? typeof v))}`;
    }
    this.stream.write(`${line}\n`);
  }
}

/** A value as one token: bare when it has no spaces, quotes or newlines, else JSON-quoted. */
function quote(text: string): string {
  return /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text);
}
