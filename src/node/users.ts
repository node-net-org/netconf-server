/**
 * The built-in static users (Node only, design §11, SSH-03): usernames with
 * scrypt password hashes and authorized public keys, from the deployment
 * config, and the users TLS certificates map to. It is an Authenticate hook
 * like any other (SSH-04).
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Logger } from '@node-net/netconf/core';
import ssh2 from 'ssh2';
import type { Authenticate } from '../auth.js';
import type { Principal } from '../session/session.js';

const { parseKey } = ssh2.utils;

export interface StaticUser {
  readonly username: string;
  /** A hash made by hashPassword() (`nncd hash-password`). */
  readonly passwordHash?: string;
  /** A plain-text password: accepted only for a lab user. */
  readonly password?: string;
  /** A lab user, such as netconf/netconf on a lab server, may have a plain-text password. */
  readonly lab?: boolean;
  /** Public keys the user may log in with, as authorized_keys lines (`ssh-ed25519 AAAA… comment`). */
  readonly authorizedKeys?: readonly string[];
  readonly groups?: readonly string[];
}

/** scrypt with N = 2^15, r = 8, p = 1, a 16-byte salt and a 32-byte hash. */
const LN = 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const HASH = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((ok, fail) => scryptCb(password, salt, keyLength, options, (err, key) => (err === null ? ok(key) : fail(err))));
}

function params(ln: number, r: number, p: number): ScryptOptions {
  return { N: 2 ** ln, r, p, maxmem: 256 * 2 ** ln * r + 1024 * 1024 };
}

const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');

/** A password hash for the config: `$scrypt$ln=15,r=8,p=1$<salt>$<hash>`, base64 without padding. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, params(LN, R, P));
  return `$scrypt$ln=${LN},r=${R},p=${P}$${b64(salt)}$${b64(hash)}`;
}

interface ParsedHash {
  readonly ln: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parseHash(text: string): ParsedHash | undefined {
  const m = HASH.exec(text);
  if (m === null) return undefined;
  const [ln, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (ln < 1 || ln > 20 || r < 1 || p < 1) return undefined;
  const hash = Buffer.from(m[5]!, 'base64');
  if (hash.length < 16) return undefined;
  return { ln, r, p, salt: Buffer.from(m[4]!, 'base64'), hash };
}

/** Whether a password matches a hash made by hashPassword(). */
export async function verifyPassword(password: string, hashText: string): Promise<boolean> {
  const h = parseHash(hashText);
  if (h === undefined) return false;
  const got = await scrypt(password, h.salt, h.hash.length, params(h.ln, h.r, h.p));
  return timingSafeEqual(got, h.hash);
}

/** Checked once, so an unknown user costs the same scrypt as a known one. */
const DUMMY: ParsedHash = { ln: LN, r: R, p: P, salt: Buffer.alloc(16), hash: Buffer.alloc(KEY_LENGTH) };

interface PreparedUser {
  readonly principal: Principal;
  readonly hash?: ParsedHash;
  readonly password?: Buffer;
  readonly keys: readonly Buffer[];
}

/**
 * An Authenticate hook for static users. Every user is checked first: a
 * malformed hash or key, or a plain-text password on a user not marked as
 * a lab user, throws naming the user. Each lab user with a plain-text
 * password is logged as a warning.
 *
 * A TLS certificate login (already validated and mapped to a username by the
 * TLS listener) is accepted when that username is a listed user, with the
 * user's groups; a name nobody listed is refused.
 *
 * A refusal looks the same whatever was wrong: unknown user, wrong password
 * or unauthorized key. An unknown user's password is still put through
 * scrypt, so the time taken doesn't tell either.
 */
export function staticUsers(users: readonly StaticUser[], options: { readonly logger?: Logger } = {}): Authenticate {
  const byName = new Map<string, PreparedUser>();
  for (const user of users) {
    if (byName.has(user.username)) throw new Error(`User ${user.username} is listed twice`);
    byName.set(user.username, prepare(user, options.logger ?? {}));
  }
  return async (attempt) => {
    const user = byName.get(attempt.username);
    if (attempt.method === 'password') {
      const ok = await checkPassword(user, attempt.password);
      return ok ? user!.principal : undefined;
    }
    if (user === undefined) return undefined;
    // TLS has validated the chain and cert-to-name named the user: a listed user is accepted.
    if (attempt.method === 'certificate') return user.principal;
    const data = Buffer.from(attempt.key.data);
    return user.keys.some((k) => k.length === data.length && timingSafeEqual(k, data)) ? user.principal : undefined;
  };
}

async function checkPassword(user: PreparedUser | undefined, password: string): Promise<boolean> {
  if (user?.password !== undefined) {
    const digest = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();
    return timingSafeEqual(digest(user.password), digest(password));
  }
  const h = user?.hash ?? DUMMY;
  const got = await scrypt(password, h.salt, h.hash.length, params(h.ln, h.r, h.p));
  return user?.hash !== undefined && timingSafeEqual(got, h.hash);
}

function prepare(user: StaticUser, logger: Logger): PreparedUser {
  const who = `User ${user.username}`;
  let hash: ParsedHash | undefined;
  if (user.passwordHash !== undefined) {
    hash = parseHash(user.passwordHash);
    if (hash === undefined) throw new Error(`${who}: passwordHash is not a hash from nncd hash-password`);
  }
  if (user.password !== undefined) {
    if (user.lab !== true) throw new Error(`${who}: a plain-text password is accepted only for a lab user ("lab": true); use passwordHash`);
    logger.warn?.('A lab user has a plain-text password in the config', { username: user.username });
  }
  const keys = (user.authorizedKeys ?? []).map((line, i) => {
    const parsed = parseKey(line);
    const key = Array.isArray(parsed) ? (parsed[0] as ssh2.ParsedKey | undefined) : parsed;
    if (key === undefined || key instanceof Error) {
      throw new Error(`${who}: authorized key ${i + 1} is not a public key ssh2 can read${key instanceof Error ? `: ${key.message}` : ''}`);
    }
    return key.getPublicSSH();
  });
  const principal: Principal = { username: user.username, ...(user.groups === undefined ? {} : { groups: [...user.groups] }) };
  return {
    principal: Object.freeze(principal),
    ...(hash === undefined ? {} : { hash }),
    ...(user.password === undefined ? {} : { password: Buffer.from(user.password) }),
    keys,
  };
}
