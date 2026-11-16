/**
 * Cert-to-name (Node only, RFC 7407 ietf-x509-cert-to-name, RFC 7589 §7,
 * TLS-02): from a client certificate chain that TLS has already validated to
 * the username the session runs as.
 *
 * Entries are tried in ascending id order. An entry applies when its
 * fingerprint is that of the client's certificate or of any certificate in
 * its chain up to and including the trust anchor; its map type then names the
 * user. A map type that finds no name in the certificate lets the next entry
 * try. No name from any entry refuses the client.
 */

import { createHash, timingSafeEqual, type X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { sha256Fingerprint } from '@node-net/netconf';

/** RFC 7407's map types, by their identity names. */
export type CertToNameMapType = 'specified' | 'san-rfc822-name' | 'san-dns-name' | 'san-ip-address' | 'san-any' | 'common-name';

export const CERT_TO_NAME_MAP_TYPES: readonly CertToNameMapType[] = ['specified', 'san-rfc822-name', 'san-dns-name', 'san-ip-address', 'san-any', 'common-name'];

export interface CertToNameEntry {
  /** Entries are tried in ascending id order; ids are unique. */
  readonly id: number;
  /**
   * The fingerprint of the client's certificate or of a certificate in its
   * chain (an intermediate or the trust anchor): RFC 7407's tls-fingerprint,
   * a hash-algorithm octet then the hash in hex with colons (`04:…` for
   * SHA-256), or `SHA256:` followed by base64. SHA-224, SHA-256, SHA-384 and
   * SHA-512 are accepted; MD5 and SHA-1 are not.
   */
  readonly fingerprint: string;
  readonly mapType: CertToNameMapType;
  /** The username, for `specified` and only for it. */
  readonly name?: string;
}

/** What a mapping found. */
export interface CertToNameMatch {
  readonly username: string;
  /** The id of the entry that named the user. */
  readonly entryId: number;
}

/** RFC 5246's HashAlgorithm octets, as RFC 7407 uses them. */
const HASHES: Readonly<Record<number, { readonly name: string; readonly length: number } | string>> = {
  0: 'none',
  1: 'MD5',
  2: 'SHA-1',
  3: { name: 'sha224', length: 28 },
  4: { name: 'sha256', length: 32 },
  5: { name: 'sha384', length: 48 },
  6: { name: 'sha512', length: 64 },
};

interface PreparedEntry {
  readonly id: number;
  readonly hash: string;
  readonly digest: Buffer;
  readonly mapType: CertToNameMapType;
  readonly name?: string;
}

/**
 * Check entries and return the mapping function. Throws a TypeError naming
 * the entry for a duplicate id, an unknown map type, a missing or misplaced
 * name, or a fingerprint that isn't one of the accepted forms.
 */
export function certToName(entries: readonly CertToNameEntry[]): (chain: readonly X509Certificate[]) => CertToNameMatch | undefined {
  if (entries.length === 0) throw new TypeError('cert-to-name needs at least one entry');
  const seen = new Set<number>();
  const prepared = entries.map((entry, index) => {
    const what = `cert-to-name entry ${Number.isInteger(entry.id) ? `id ${entry.id}` : index}`;
    if (!Number.isInteger(entry.id) || entry.id < 0 || entry.id > 0xffffffff) throw new TypeError(`${what}: id must be a whole number from 0 to 4294967295`);
    if (seen.has(entry.id)) throw new TypeError(`${what}: the id is used twice`);
    seen.add(entry.id);
    if (!CERT_TO_NAME_MAP_TYPES.includes(entry.mapType)) throw new TypeError(`${what}: mapType must be one of ${CERT_TO_NAME_MAP_TYPES.join(', ')}`);
    if (entry.mapType === 'specified' && (typeof entry.name !== 'string' || entry.name.length === 0)) throw new TypeError(`${what}: a specified entry needs a name`);
    if (entry.mapType !== 'specified' && entry.name !== undefined) throw new TypeError(`${what}: only a specified entry has a name`);
    const { hash, digest } = parseFingerprint(entry.fingerprint, what);
    return { id: entry.id, hash, digest, mapType: entry.mapType, ...(entry.name === undefined ? {} : { name: entry.name }) } satisfies PreparedEntry;
  });
  prepared.sort((a, b) => a.id - b.id);

  return (chain) => {
    const leaf = chain[0];
    if (leaf === undefined) return undefined;
    const digests = new Map<string, Buffer[]>();
    const digestsFor = (hash: string): Buffer[] => {
      let list = digests.get(hash);
      if (list === undefined) {
        list = chain.map((c) => createHash(hash).update(c.raw).digest());
        digests.set(hash, list);
      }
      return list;
    };
    for (const entry of prepared) {
      // Compare against every certificate, so the time taken doesn't say which matched.
      let matched = false;
      for (const d of digestsFor(entry.hash)) matched = (d.length === entry.digest.length && timingSafeEqual(d, entry.digest)) || matched;
      if (!matched) continue;
      const username = nameFrom(leaf, entry);
      if (username !== undefined && username.length > 0) return { username, entryId: entry.id };
    }
    return undefined;
  };
}

/** Map one chain (the client's certificate first) with the given entries. */
export function mapCertificateToName(chain: readonly X509Certificate[], entries: readonly CertToNameEntry[]): CertToNameMatch | undefined {
  return certToName(entries)(chain);
}

/** A certificate's SHA-256 fingerprint as `SHA256:<base64>`, as the logs and hooks show it. */
export function certificateFingerprint(der: Uint8Array): string {
  return sha256Fingerprint(der);
}

function parseFingerprint(text: unknown, what: string): { hash: string; digest: Buffer } {
  if (typeof text !== 'string') throw new TypeError(`${what}: fingerprint must be a string`);
  const t = text.trim();
  const b64 = /^SHA256:([A-Za-z0-9+/]{43})=?$/.exec(t);
  if (b64 !== null) return { hash: 'sha256', digest: Buffer.from(b64[1]!, 'base64') };
  if (!/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2})+$/.test(t)) {
    throw new TypeError(`${what}: fingerprint must be a tls-fingerprint (hex octets with colons, the first naming the hash) or SHA256:<base64>`);
  }
  const bytes = Buffer.from(t.replace(/:/g, ''), 'hex');
  const algorithm = HASHES[bytes[0]!];
  if (algorithm === undefined) throw new TypeError(`${what}: fingerprint hash algorithm ${bytes[0]} is unknown`);
  if (typeof algorithm === 'string') throw new TypeError(`${what}: ${algorithm} fingerprints aren't accepted; use SHA-256 or stronger`);
  const digest = bytes.subarray(1);
  if (digest.length !== algorithm.length) throw new TypeError(`${what}: a ${algorithm.name} fingerprint has ${algorithm.length} octets after the algorithm octet, not ${digest.length}`);
  return { hash: algorithm.name, digest };
}

function nameFrom(cert: X509Certificate, entry: PreparedEntry): string | undefined {
  switch (entry.mapType) {
    case 'specified':
      return entry.name;
    case 'common-name': {
      const cns = distinguishedName(cert.subject)?.filter(([k]) => k === 'CN');
      return cns?.length === 1 ? cns[0]![1] : undefined;
    }
    default: {
      const sans = subjectAltNames(cert.subjectAltName);
      if (sans === undefined) return undefined;
      for (const [type, value] of sans) {
        const name = sanName(type, value, entry.mapType);
        if (name !== undefined) return name;
      }
      return undefined;
    }
  }
}

/** The name a SAN gives for a map type, normalised as RFC 7407 says, or undefined. */
function sanName(type: string, value: string, mapType: CertToNameMapType): string | undefined {
  const any = mapType === 'san-any';
  if (type === 'email' && (any || mapType === 'san-rfc822-name')) {
    const at = value.lastIndexOf('@');
    return at < 0 ? value : value.slice(0, at + 1) + value.slice(at + 1).toLowerCase();
  }
  if (type === 'DNS' && (any || mapType === 'san-dns-name')) return value.toLowerCase();
  if (type === 'IP Address' && (any || mapType === 'san-ip-address')) return ipName(value);
  return undefined;
}

/** IPv4 dotted; IPv6 as 32 lowercase hex digits without colons (RFC 7407). */
function ipName(text: string): string | undefined {
  const kind = isIP(text);
  if (kind === 4) return text;
  if (kind !== 6) return undefined;
  const [head, tail] = text.toLowerCase().split('::') as [string, string | undefined];
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const groups = (parts: string[]): string[] =>
    parts.flatMap((g) => {
      if (!g.includes('.')) return [g];
      const o = g.split('.').map(Number);
      return [((o[0]! << 8) | o[1]!).toString(16), ((o[2]! << 8) | o[3]!).toString(16)];
    });
  const l = groups(left);
  const r = groups(right);
  const all = tail === undefined ? l : [...l, ...Array<string>(8 - l.length - r.length).fill('0'), ...r];
  return all.length === 8 ? all.map((g) => g.padStart(4, '0')).join('') : undefined;
}

/**
 * Node's subjectAltName text: `TYPE:value` entries joined by `, `, where a
 * value that needs escaping is a JSON string. Undefined when there are none
 * or the text can't be read, so a malformed SAN never yields a name.
 */
export function subjectAltNames(text: string | undefined): [string, string][] | undefined {
  if (text === undefined || text === '') return undefined;
  const out: [string, string][] = [];
  let i = 0;
  while (i < text.length) {
    const colon = text.indexOf(':', i);
    if (colon < 0) return undefined;
    const type = text.slice(i, colon);
    let value: string;
    let next: number;
    if (text[colon + 1] === '"') {
      const end = jsonStringEnd(text, colon + 1);
      if (end < 0) return undefined;
      try {
        value = JSON.parse(text.slice(colon + 1, end + 1)) as string;
      } catch {
        return undefined;
      }
      next = end + 1;
    } else {
      const comma = text.indexOf(', ', colon + 1);
      next = comma < 0 ? text.length : comma;
      value = text.slice(colon + 1, next);
    }
    out.push([type, value]);
    if (next === text.length) break;
    if (text.slice(next, next + 2) !== ', ') return undefined;
    i = next + 2;
  }
  return out;
}

/**
 * Node's subject text: one `KEY=value` per line, a value that needs escaping
 * being a JSON string.
 */
function distinguishedName(text: string | undefined): [string, string][] | undefined {
  if (text === undefined) return undefined;
  const out: [string, string][] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const eq = line.indexOf('=');
    if (eq < 0) return undefined;
    let value = line.slice(eq + 1);
    if (value.startsWith('"')) {
      if (jsonStringEnd(value, 0) !== value.length - 1) return undefined;
      try {
        value = JSON.parse(value) as string;
      } catch {
        return undefined;
      }
    }
    out.push([line.slice(0, eq), value]);
  }
  return out;
}

/** The index of the quote ending the JSON string starting at `start`, or -1. */
function jsonStringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}
