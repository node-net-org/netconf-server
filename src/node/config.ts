/**
 * The deployment config (Node only, design §14, NNCD-01 to NNCD-03): read
 * and checked against its schema, then everything it names is loaded and
 * mapped onto createServer()'s options and an SSH listener.
 *
 * The config names modules to import, so it is trusted like code: whoever
 * can edit it can run code as the server.
 */

import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createSecureContext } from 'node:tls';
import { pathToFileURL } from 'node:url';
import type { Logger } from '@node-net/netconf';
import type { Authenticate } from '../auth.js';
import type { ControlOptions } from '../control/control.js';
import { loadDeviceFile } from '../device/file.js';
import type { Device } from '../device/load.js';
import type { Provider } from '../provider/provider.js';
import type { ServerOptions } from '../server.js';
import { fileStore } from '../store/file.js';
import { startTrees, type StartupMode } from '../store/startup.js';
import { memoryStore, type Store } from '../store/store.js';
import { certToName, type CertToNameEntry } from './cert-to-name.js';
import { validateConfig, type ConfigIssue } from './config-validate.js';
import { loadHostKeys, type HostKey } from './host-keys.js';
import { NETCONF_SSH_PORT } from './ssh.js';
import { NETCONF_TLS_PORT } from './tls.js';
import { staticUsers, type StaticUser } from './users.js';

export type { ConfigIssue } from './config-validate.js';

export type ConfigLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** server.json, as schemas/server.schema.json describes it. */
export interface ServerConfig {
  readonly device: string;
  readonly stateDir?: string;
  readonly store?: 'memory' | 'file';
  readonly startup?: StartupMode;
  readonly unclaimed?: 'store' | 'reject';
  readonly control?: ControlOptions;
  readonly nacm?: NacmConfig;
  /** The listeners to run. Without it, SSH on port 830. */
  readonly listen?: ListenConfig;
  readonly users?: readonly StaticUser[];
  readonly providers?: readonly ProviderEntry[];
  readonly logLevel?: ConfigLogLevel;
}

/** NACM (RFC 8341) settings: the policy itself is the device's ietf-netconf-acm configuration. */
export interface NacmConfig {
  /** Users whose sessions are recovery sessions, which NACM doesn't restrict, whichever authenticator produced them. */
  readonly recoveryUsers?: readonly string[];
}

export interface ListenConfig {
  readonly ssh?: SshListenConfig;
  readonly tls?: TlsListenConfig;
}

export interface SshListenConfig {
  readonly address?: string;
  readonly port?: number;
  /** Private host key files. Without them, a key is generated (kept in stateDir). */
  readonly hostKeys?: readonly string[];
}

export interface TlsListenConfig {
  readonly address?: string;
  readonly port?: number;
  /** The server certificate file (PEM), optionally followed by its intermediates. */
  readonly cert: string;
  /** Its private key file (PEM, unencrypted). */
  readonly key: string;
  /** Trust anchor files for client certificates. */
  readonly ca: readonly string[];
  readonly certToName: readonly CertToNameEntry[];
}

export interface ProviderEntry {
  readonly module: string;
  readonly path?: string;
  readonly startup?: StartupMode;
  readonly options?: unknown;
}

/** What a provider module's default export is called with. */
export interface ProviderFactoryContext {
  readonly logger: Logger;
  /** The directory of the config file, for options that name files. */
  readonly configDir: string;
}

/**
 * A provider module's default export. Given the entry's options, it returns
 * the provider, or, when the entry has no `path`, `{ path, provider }` or a
 * list of them.
 */
export type ProviderFactory = (
  options: unknown,
  context: ProviderFactoryContext,
) => ProviderResult | Promise<ProviderResult>;

export type ProviderResult = Provider | { readonly path: string; readonly provider: Provider } | readonly { readonly path: string; readonly provider: Provider }[];

/** The config breaks its schema (nncd exits 2). */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(
    readonly file: string,
    readonly issues: readonly ConfigIssue[],
  ) {
    super(`${file} is not a valid deployment config:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
  }
}

/** Something the config names can't be used (nncd exits 1). The message names it. */
export class StartError extends Error {
  override readonly name = 'StartError';
  constructor(
    /** What failed: a file, a module, a user. */
    readonly item: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface LoadedConfig {
  /** The config file, absolute. */
  readonly file: string;
  /** Its directory: paths in the config are relative to it. */
  readonly dir: string;
  readonly config: ServerConfig;
}

/**
 * Read a deployment config and check it against its schema.
 * @throws ConfigError listing every problem by JSON path
 * @throws StartError when the file can't be read
 */
export async function readServerConfig(path: string): Promise<LoadedConfig> {
  const file = resolve(path);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new StartError(file, `Can't read config ${file}: ${(err as Error).message}`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(file, [{ path: '/', message: `is not valid JSON: ${(err as Error).message}` }]);
  }
  const issues = validateConfig(json);
  if (issues.length > 0) throw new ConfigError(file, issues);
  return { file, dir: dirname(file), config: json as ServerConfig };
}

/** Everything a config names, loaded: createServer()'s options and the listeners'. */
export interface PreparedServer {
  readonly options: ServerOptions & { readonly device: Device; readonly store: Store };
  /** The listeners to start: at least one of them. */
  readonly listeners: { readonly ssh?: PreparedSsh; readonly tls?: PreparedTls };
  readonly authenticate: Authenticate;
}

/** sshListener()'s options, less authenticate and logger. */
export interface PreparedSsh {
  readonly address?: string;
  readonly port: number;
  readonly hostKeys: readonly HostKey[];
}

/** tlsListener()'s options, less authenticate and logger. */
export interface PreparedTls {
  readonly address?: string;
  readonly port: number;
  readonly cert: Buffer;
  readonly key: Buffer;
  readonly ca: readonly Buffer[];
  readonly certToName: readonly CertToNameEntry[];
}

export interface PrepareOptions {
  readonly logger?: Logger;
  /**
   * nncd --check: load and check everything without side effects that
   * matter. No host key is generated, provider factories are not called
   * (they may open backends), and the saved start-up data is validated here.
   */
  readonly check?: boolean;
}

/**
 * Load what a config names. Each failure names its item.
 * @throws StartError
 */
export async function prepareServer(loaded: LoadedConfig, options: PrepareOptions = {}): Promise<PreparedServer> {
  const { config, dir } = loaded;
  const logger = options.logger ?? {};
  const at = (p: string): string => resolve(dir, p);
  const entries = config.providers ?? [];
  const controlEnabled = config.control?.enabled ?? entries.length === 0;

  const deviceFile = at(config.device);
  let device: Device;
  try {
    device = await loadDeviceFile(deviceFile, { control: controlEnabled });
  } catch (err) {
    throw new StartError(deviceFile, describe(err), { cause: err });
  }

  const stateDir = config.stateDir === undefined ? undefined : at(config.stateDir);
  const store = config.store === 'file' ? fileStore(stateDir!) : memoryStore();

  // No listen: SSH on its default port, as before there were listeners to choose.
  const listen: ListenConfig = config.listen ?? { ssh: {} };
  let ssh: PreparedSsh | undefined;
  if (listen.ssh !== undefined) {
    let hostKeys: HostKey[];
    try {
      hostKeys = await loadHostKeys({
        ...(listen.ssh.hostKeys === undefined ? {} : { files: listen.ssh.hostKeys.map(at) }),
        ...(stateDir === undefined ? {} : { stateDir }),
        readOnly: options.check === true,
        logger,
      });
    } catch (err) {
      throw new StartError('host key', (err as Error).message, { cause: err });
    }
    ssh = { ...(listen.ssh.address === undefined ? {} : { address: listen.ssh.address }), port: listen.ssh.port ?? NETCONF_SSH_PORT, hostKeys };
  }
  const tls = listen.tls === undefined ? undefined : await prepareTls(listen.tls, at);

  let authenticate: Authenticate;
  try {
    authenticate = staticUsers(config.users ?? [], { logger });
  } catch (err) {
    throw new StartError('users', (err as Error).message, { cause: err });
  }

  const providers: { path: string; provider: Provider }[] = [];
  for (const [i, entry] of entries.entries()) {
    const factory = await importFactory(entry.module, dir, i);
    if (options.check === true) continue;
    providers.push(...(await callFactory(factory, entry, i, { logger, configDir: dir })));
  }

  const recoveryUsers = new Set(config.nacm?.recoveryUsers ?? []);
  if (options.check === true && recoveryUsers.size === 0 && device.schema.module('ietf-netconf-acm')?.implemented === true) {
    logger.warn?.('The device implements ietf-netconf-acm and nacm.recoveryUsers names no one, so nobody can repair its access control policy over NETCONF');
  }

  if (options.check === true) {
    try {
      await startTrees(device, store);
    } catch (err) {
      throw new StartError(store.location, describe(err), { cause: err });
    }
  }

  return {
    options: {
      device,
      store,
      logger,
      ...(config.startup === undefined ? {} : { startup: config.startup }),
      ...(config.unclaimed === undefined ? {} : { unclaimed: config.unclaimed }),
      control: { ...config.control, enabled: controlEnabled },
      ...(recoveryUsers.size === 0 ? {} : { nacm: { recovery: (p) => recoveryUsers.has(p.username) } }),
      providers,
    },
    listeners: { ...(ssh === undefined ? {} : { ssh }), ...(tls === undefined ? {} : { tls }) },
    authenticate,
  };
}

/** Read and check the TLS listener's files: each failure names its file. */
async function prepareTls(config: TlsListenConfig, at: (p: string) => string): Promise<PreparedTls> {
  const read = async (path: string, what: string): Promise<Buffer> => {
    const file = at(path);
    try {
      return await readFile(file);
    } catch (err) {
      throw new StartError(file, `Can't read the TLS ${what} ${file}: ${(err as Error).message}`, { cause: err });
    }
  };
  const certFile = at(config.cert);
  const keyFile = at(config.key);
  const cert = await read(config.cert, 'certificate');
  const key = await read(config.key, 'key');
  const ca = await Promise.all(config.ca.map((p) => read(p, 'trust anchor')));
  try {
    new X509Certificate(cert);
  } catch (err) {
    throw new StartError(certFile, `The TLS certificate ${certFile} is not a PEM certificate: ${(err as Error).message}`, { cause: err });
  }
  config.ca.forEach((p, i) => {
    try {
      new X509Certificate(ca[i]!);
    } catch (err) {
      throw new StartError(at(p), `The TLS trust anchor ${at(p)} is not a PEM certificate: ${(err as Error).message}`, { cause: err });
    }
  });
  try {
    createSecureContext({ cert, key });
  } catch (err) {
    throw new StartError(keyFile, `The TLS key ${keyFile} can't be used with the certificate ${certFile}: ${(err as Error).message}`, { cause: err });
  }
  try {
    certToName(config.certToName);
  } catch (err) {
    throw new StartError('listen/tls/certToName', (err as Error).message, { cause: err });
  }
  return {
    ...(config.address === undefined ? {} : { address: config.address }),
    port: config.port ?? NETCONF_TLS_PORT,
    cert,
    key,
    ca,
    certToName: config.certToName,
  };
}

async function importFactory(spec: string, dir: string, index: number): Promise<ProviderFactory> {
  const what = `provider module ${spec} (providers/${index})`;
  let mod: { default?: unknown };
  try {
    mod = (await import(moduleUrl(spec, dir))) as { default?: unknown };
  } catch (err) {
    throw new StartError(spec, `Can't import ${what}: ${(err as Error).message}`, { cause: err });
  }
  if (typeof mod.default !== 'function') throw new StartError(spec, `The ${what} has no default export that is a function`);
  return mod.default as ProviderFactory;
}

/** A file module (starting . or /) relative to the config, else a package found from the config's directory. */
function moduleUrl(spec: string, dir: string): string {
  if (spec.startsWith('.') || isAbsolute(spec)) return pathToFileURL(resolve(dir, spec)).href;
  try {
    return pathToFileURL(createRequire(join(dir, 'server.json')).resolve(spec)).href;
  } catch {
    // An ESM-only package without a require condition: let import() resolve it.
    return spec;
  }
}

async function callFactory(factory: ProviderFactory, entry: ProviderEntry, index: number, context: ProviderFactoryContext): Promise<{ path: string; provider: Provider }[]> {
  const what = `provider module ${entry.module} (providers/${index})`;
  let result: ProviderResult;
  try {
    result = await factory(entry.options, context);
  } catch (err) {
    throw new StartError(entry.module, `The ${what} failed: ${(err as Error).message}`, { cause: err });
  }
  const bad = (why: string): StartError => new StartError(entry.module, `The ${what} returned ${why}`);
  let list: { path: string; provider: Provider }[];
  if (entry.path !== undefined) {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw bad('no provider');
    list = [{ path: entry.path, provider: result as Provider }];
  } else {
    const items = Array.isArray(result) ? (result as unknown[]) : [result];
    list = items.map((r) => {
      const item = r as { path?: unknown; provider?: unknown } | null;
      if (typeof item?.path !== 'string' || typeof item.provider !== 'object' || item.provider === null) {
        throw bad('neither { path, provider } nor a list of them; give the entry a path, or return where to register');
      }
      return { path: item.path, provider: item.provider };
    });
  }
  const startup = entry.startup;
  return startup === undefined ? list : list.map((p) => ({ path: p.path, provider: withStartup(p.provider, startup) }));
}

/** The provider with the entry's start-up mode. Methods stay bound to the provider itself, so private fields work. */
function withStartup(provider: Provider, startup: StartupMode): Provider {
  return new Proxy(provider, {
    get(target, key) {
      if (key === 'startup') return startup;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** DeviceError's message already lists its issues. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
