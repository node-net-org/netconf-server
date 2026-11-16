/**
 * Validation of an nncd deployment config: the rules of
 * schemas/server.schema.json, every problem with its JSON path (NNCD-02).
 * A test keeps this and the schema in agreement.
 */

export interface ConfigIssue {
  /** A JSON Pointer to the problem, `/` for the whole config. */
  readonly path: string;
  readonly message: string;
}

/** A JSON object, with the properties this reads named so they can be read with a dot. */
type Known =
  | '$schema' | 'device' | 'stateDir' | 'store' | 'startup' | 'unclaimed' | 'control' | 'nacm' | 'recoveryUsers' | 'listen' | 'users' | 'providers' | 'logLevel'
  | 'enabled' | 'address' | 'port' | 'hostKeys' | 'ssh' | 'tls' | 'cert' | 'key' | 'ca' | 'certToName'
  | 'id' | 'fingerprint' | 'mapType' | 'name'
  | 'username' | 'passwordHash' | 'password' | 'lab' | 'authorizedKeys' | 'groups' | 'module' | 'path';
type Obj = { [key: string]: unknown } & { [K in Known]?: unknown };

const TOP = ['$schema', 'device', 'stateDir', 'store', 'startup', 'unclaimed', 'control', 'nacm', 'listen', 'users', 'providers', 'logLevel'];
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'];
const USER = ['username', 'passwordHash', 'password', 'lab', 'authorizedKeys', 'groups'];
const PROVIDER = ['module', 'path', 'startup', 'options'];
const MAP_TYPES = ['specified', 'san-rfc822-name', 'san-dns-name', 'san-ip-address', 'san-any', 'common-name'];
/** RFC 7407 tls-fingerprint with a SHA-224 to SHA-512 algorithm octet, or SHA256:<base64>. */
export const FINGERPRINT = /^(0[3-6](:[0-9a-fA-F]{2}){28,64}|SHA256:[A-Za-z0-9+/]{43}=?)$/;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateConfig(config: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ path: path === '' ? '/' : path, message });

  const unknown = (o: Obj, allowed: readonly string[], at: string): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) add(`${at}/${escape(k)}`, 'is not a known property');
  };
  const str = (v: unknown, at: string, nonEmpty = true): boolean => {
    if (typeof v !== 'string') add(at, 'must be a string');
    else if (nonEmpty && v.length === 0) add(at, 'must not be empty');
    else return true;
    return false;
  };
  const oneOf = (v: unknown, values: readonly string[], at: string): void => {
    if (typeof v !== 'string' || !values.includes(v)) add(at, `must be one of ${values.join(', ')}`);
  };
  const bool = (v: unknown, at: string): void => {
    if (typeof v !== 'boolean') add(at, 'must be true or false');
  };
  const strings = (v: unknown, at: string): void => {
    if (!Array.isArray(v)) return add(at, 'must be a list of strings');
    v.forEach((s, i) => str(s, `${at}/${i}`));
  };

  if (!isObj(config)) {
    add('', 'must be a JSON object');
    return issues;
  }
  unknown(config, TOP, '');
  if (config.$schema !== undefined) str(config.$schema, '/$schema', false);
  if (config.device === undefined) add('/device', 'is required: the path to a device definition');
  else str(config.device, '/device');
  if (config.stateDir !== undefined) str(config.stateDir, '/stateDir');
  if (config.store !== undefined) {
    oneOf(config.store, ['memory', 'file'], '/store');
    if (config.store === 'file' && config.stateDir === undefined) add('/stateDir', 'is required with store: file');
  }
  if (config.startup !== undefined) oneOf(config.startup, ['push', 'adopt'], '/startup');
  if (config.unclaimed !== undefined) oneOf(config.unclaimed, ['store', 'reject'], '/unclaimed');
  if (config.logLevel !== undefined) oneOf(config.logLevel, LOG_LEVELS, '/logLevel');

  if (config.control !== undefined) {
    if (!isObj(config.control)) add('/control', 'must be an object');
    else {
      unknown(config.control, ['enabled', 'users'], '/control');
      if (config.control.enabled !== undefined) bool(config.control.enabled, '/control/enabled');
      if (config.control.users !== undefined) strings(config.control.users, '/control/users');
    }
  }

  if (config.nacm !== undefined) {
    if (!isObj(config.nacm)) add('/nacm', 'must be an object');
    else {
      unknown(config.nacm, ['recoveryUsers'], '/nacm');
      if (config.nacm.recoveryUsers !== undefined) strings(config.nacm.recoveryUsers, '/nacm/recoveryUsers');
    }
  }

  const port = (v: unknown, at: string): void => {
    if (!(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 65535)) add(at, 'must be a whole number from 0 to 65535');
  };

  if (config.listen !== undefined) {
    const l = config.listen;
    if (!isObj(l)) add('/listen', 'must be an object');
    else {
      unknown(l, ['ssh', 'tls'], '/listen');
      if (l.ssh === undefined && l.tls === undefined) add('/listen', 'must name at least one listener: ssh or tls');
      if (l.ssh !== undefined) {
        const s = l.ssh;
        if (!isObj(s)) add('/listen/ssh', 'must be an object');
        else {
          unknown(s, ['address', 'port', 'hostKeys'], '/listen/ssh');
          if (s.address !== undefined) str(s.address, '/listen/ssh/address');
          if (s.port !== undefined) port(s.port, '/listen/ssh/port');
          if (s.hostKeys !== undefined) strings(s.hostKeys, '/listen/ssh/hostKeys');
        }
      }
      if (l.tls !== undefined) {
        const t = l.tls;
        if (!isObj(t)) add('/listen/tls', 'must be an object');
        else {
          unknown(t, ['address', 'port', 'cert', 'key', 'ca', 'certToName'], '/listen/tls');
          if (t.address !== undefined) str(t.address, '/listen/tls/address');
          if (t.port !== undefined) port(t.port, '/listen/tls/port');
          for (const k of ['cert', 'key'] as const) {
            if (t[k] === undefined) add(`/listen/tls/${k}`, `is required: the ${k === 'cert' ? 'server certificate' : 'private key'} file`);
            else str(t[k], `/listen/tls/${k}`);
          }
          if (t.ca === undefined) add('/listen/tls/ca', 'is required: trust anchor files for client certificates');
          else if (Array.isArray(t.ca) && t.ca.length === 0) add('/listen/tls/ca', 'must list at least one trust anchor file');
          else strings(t.ca, '/listen/tls/ca');
          if (t.certToName === undefined) add('/listen/tls/certToName', 'is required: how client certificates map to usernames');
          else certToName(t.certToName, '/listen/tls/certToName');
        }
      }
    }
  }

  if (config.users !== undefined) {
    if (!Array.isArray(config.users)) add('/users', 'must be a list of users');
    else
      config.users.forEach((u, i) => {
        const at = `/users/${i}`;
        if (!isObj(u)) return add(at, 'must be an object');
        unknown(u, USER, at);
        if (u.username === undefined) add(`${at}/username`, 'is required');
        else str(u.username, `${at}/username`);
        if (u.passwordHash !== undefined && str(u.passwordHash, `${at}/passwordHash`) && !(u.passwordHash as string).startsWith('$scrypt$')) {
          add(`${at}/passwordHash`, 'must be a hash from nncd hash-password ($scrypt$…)');
        }
        if (u.password !== undefined) {
          str(u.password, `${at}/password`, false);
          if (u.lab !== true) add(`${at}/password`, 'a plain-text password is allowed only with "lab": true; use passwordHash');
        }
        if (u.lab !== undefined) bool(u.lab, `${at}/lab`);
        if (u.authorizedKeys !== undefined) strings(u.authorizedKeys, `${at}/authorizedKeys`);
        if (u.groups !== undefined) strings(u.groups, `${at}/groups`);
      });
  }

  if (config.providers !== undefined) {
    if (!Array.isArray(config.providers)) add('/providers', 'must be a list of providers');
    else
      config.providers.forEach((p, i) => {
        const at = `/providers/${i}`;
        if (!isObj(p)) return add(at, 'must be an object');
        unknown(p, PROVIDER, at);
        if (p.module === undefined) add(`${at}/module`, 'is required');
        else str(p.module, `${at}/module`);
        if (p.path !== undefined && str(p.path, `${at}/path`) && !(p.path as string).startsWith('/')) add(`${at}/path`, 'must be a path starting with /');
        if (p.startup !== undefined) oneOf(p.startup, ['push', 'adopt'], `${at}/startup`);
      });
  }
  return issues;

  function certToName(v: unknown, at: string): void {
    if (!Array.isArray(v)) return add(at, 'must be a list of entries');
    if (v.length === 0) return add(at, 'must have at least one entry');
    const ids = new Set<unknown>();
    v.forEach((e, i) => {
      const where = `${at}/${i}`;
      if (!isObj(e)) return add(where, 'must be an object');
      unknown(e, ['id', 'fingerprint', 'mapType', 'name'], where);
      if (e.id === undefined) add(`${where}/id`, 'is required');
      else if (!(Number.isInteger(e.id) && (e.id as number) >= 0 && (e.id as number) <= 4294967295)) add(`${where}/id`, 'must be a whole number from 0 to 4294967295');
      else if (ids.has(e.id)) add(`${where}/id`, 'is used by another entry');
      ids.add(e.id);
      if (e.fingerprint === undefined) add(`${where}/fingerprint`, 'is required');
      else if (str(e.fingerprint, `${where}/fingerprint`) && !FINGERPRINT.test(e.fingerprint as string)) {
        add(`${where}/fingerprint`, 'must be a tls-fingerprint (03 to 06 for SHA-224 to SHA-512, then hex octets with colons) or SHA256:<base64>');
      }
      if (e.mapType === undefined) add(`${where}/mapType`, 'is required');
      else oneOf(e.mapType, MAP_TYPES, `${where}/mapType`);
      if (e.mapType === 'specified' && e.name === undefined) add(`${where}/name`, 'is required for a specified entry');
      if (e.name !== undefined) {
        str(e.name, `${where}/name`);
        if (e.mapType !== undefined && e.mapType !== 'specified') add(`${where}/name`, 'is allowed only for a specified entry');
      }
    });
  }
}

/** RFC 6901 escaping of a property name in a JSON Pointer. */
function escape(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
