/**
 * SSH host keys (Node only, design §11, SSH-02): from files, or generated
 * once into the state directory and reused, so clients' known-hosts checks
 * keep working across restarts.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256Fingerprint } from '@node-net/netconf';
import type { Logger } from '@node-net/netconf/core';
import ssh2 from 'ssh2';

// ssh2 is CommonJS; Node's ESM loader doesn't see `utils` as a named export.
const { parseKey, generateKeyPairSync } = ssh2.utils;

/** The file a generated host key is saved to in the state directory. */
export const GENERATED_HOST_KEY = 'ssh_host_ed25519_key';

export interface HostKey {
  /** Where it came from: its file, or `generated` for a key made for this run. */
  readonly source: string;
  /** The private key, as ssh2 reads it (OpenSSH or PEM). */
  readonly privateKey: string;
  /** The key type, such as `ssh-ed25519`. */
  readonly algorithm: string;
  /** OpenSSH's SHA256 fingerprint of the public key, as `SHA256:…`. */
  readonly fingerprint: string;
}

export interface HostKeyOptions {
  /** Host key files. When given, nothing is generated. */
  readonly files?: readonly string[];
  /** Where a generated key is saved and found again. */
  readonly stateDir?: string;
  /** Only read: fail rather than generate or save a key (nncd --check). */
  readonly readOnly?: boolean;
  readonly logger?: Logger;
}

/**
 * The server's host keys. With `files`, each is read and parsed. Otherwise,
 * with a `stateDir`, its saved key is read, or an ed25519 key is generated
 * and saved there (owner-only) on the first run. With neither, a key is
 * generated for this run only, with a warning that it will change.
 * @throws Error naming the file that can't be read or parsed
 */
export async function loadHostKeys(options: HostKeyOptions = {}): Promise<HostKey[]> {
  const logger = options.logger ?? {};
  if (options.files !== undefined && options.files.length > 0) {
    return Promise.all(options.files.map((f) => readHostKey(resolve(f))));
  }
  if (options.stateDir === undefined) {
    if (options.readOnly === true) return [];
    logger.warn?.('No host key or state directory is configured: using a key made for this run, so clients will see it change on restart');
    return [hostKey(generateHostKey(), 'generated')];
  }
  const file = join(resolve(options.stateDir), GENERATED_HOST_KEY);
  let text: string | undefined;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Can't read host key ${file}: ${(err as Error).message}`, { cause: err });
  }
  if (text !== undefined) return [hostKey(text, file)];
  if (options.readOnly === true) return [];
  const generated = generateHostKey();
  try {
    await mkdir(resolve(options.stateDir), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, generated, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (err) {
    throw new Error(`Can't save host key ${file}: ${(err as Error).message}`, { cause: err });
  }
  logger.info?.('Generated a host key', { file });
  return [hostKey(generated, file)];
}

async function readHostKey(file: string): Promise<HostKey> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`Can't read host key ${file}: ${(err as Error).message}`, { cause: err });
  }
  return hostKey(text, file);
}

function hostKey(text: string, source: string): HostKey {
  const parsed = parseKey(text);
  if (parsed instanceof Error) throw new Error(`Host key ${source} is not a key ssh2 can read: ${parsed.message}`);
  const key = Array.isArray(parsed) ? (parsed[0] as ssh2.ParsedKey) : parsed;
  if (!key.isPrivateKey()) throw new Error(`Host key ${source} is a public key; the server needs the private key`);
  return { source, privateKey: text, algorithm: key.type, fingerprint: fingerprint(key.getPublicSSH()) };
}

/** OpenSSH's SHA256 fingerprint of a public key in SSH wire format. */
export function fingerprint(publicSsh: Uint8Array): string {
  return sha256Fingerprint(publicSsh);
}

/**
 * A new ed25519 private key in OpenSSH format. ssh2's generator now and then
 * returns a key its own parser rejects, so it generates until one parses.
 */
export function generateHostKey(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair = generateKeyPairSync('ed25519');
    if (!(parseKey(pair.private) instanceof Error) && !(parseKey(pair.public) instanceof Error)) return pair.private;
  }
  throw new Error('Could not generate a host key that ssh2 can read');
}
