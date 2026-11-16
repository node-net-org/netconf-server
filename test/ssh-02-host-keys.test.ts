// SSH-02: keep a stable host key across restarts.
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, ssh, type HostKeyInfo } from '@node-net/netconf';
import { describe, expect, it } from 'vitest';
import { GENERATED_HOST_KEY, loadHostKeys } from '../src/index.js';
import { clientKey, HOST_KEY, recordingLogger, sshServer, tempDir } from './ssh-helpers.js';

/** The fingerprint a client sees. */
async function seenFingerprint(port: number): Promise<string> {
  let seen = '';
  const client = await connect({
    transport: ssh({
      host: '127.0.0.1',
      port,
      username: 'netconf',
      password: 'netconf',
      hostKey: (info: HostKeyInfo) => {
        seen = info.fingerprint;
        return true;
      },
    }),
  });
  await client.close();
  return seen;
}

describe('SSH-02 host keys', () => {
  it('takes host keys from files', async () => {
    const dir = await tempDir();
    const file = join(dir, 'host_key');
    await writeFile(file, HOST_KEY, { mode: 0o600 });
    const [key] = await loadHostKeys({ files: [file] });
    expect(key!.source).toBe(file);
    expect(key!.algorithm).toBe('ssh-ed25519');
    const fixture = await sshServer({ listener: { hostKeys: [key!] } });
    expect(await seenFingerprint(fixture.port)).toBe(key!.fingerprint);
    await fixture.close();
  });

  it('generates an ed25519 key once in the state directory, owner-only, and reuses it', async () => {
    const dir = await tempDir();
    const [first] = await loadHostKeys({ stateDir: dir });
    const file = join(dir, GENERATED_HOST_KEY);
    expect(first!.source).toBe(file);
    expect(first!.algorithm).toBe('ssh-ed25519');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const [again] = await loadHostKeys({ stateDir: dir });
    expect(again!.fingerprint).toBe(first!.fingerprint);

    // Across a restart, a client sees the same key.
    const a = await sshServer({ listener: { hostKeys: [first!] } });
    const before = await seenFingerprint(a.port);
    await a.close();
    const b = await sshServer({ listener: { hostKeys: await loadHostKeys({ stateDir: dir }) } });
    expect(await seenFingerprint(b.port)).toBe(before);
    await b.close();
  });

  it('with neither, makes a key for the run and warns that it will change', async () => {
    const { logger, entries } = recordingLogger();
    const [key] = await loadHostKeys({ logger });
    expect(key!.source).toBe('generated');
    expect(entries.some((e) => e.level === 'warn' && /change/.test(e.message))).toBe(true);
  });

  it("logs each host key's SHA-256 fingerprint at start-up", async () => {
    const { logger, entries } = recordingLogger();
    const [key] = await loadHostKeys({ stateDir: await tempDir() });
    const fixture = await sshServer({ server: { logger }, listener: { hostKeys: [key!] } });
    const line = entries.find((e) => e.message === 'Listening for NETCONF over SSH');
    expect(String(line?.context['hostKeys'])).toContain(key!.fingerprint);
    expect(key!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    await fixture.close();
  });

  it("stops start-up with an error naming a host key file that can't be read or parsed", async () => {
    const dir = await tempDir();
    const missing = join(dir, 'missing_key');
    await expect(loadHostKeys({ files: [missing] })).rejects.toThrow(missing);
    const garbage = join(dir, 'garbage_key');
    await writeFile(garbage, 'not a key');
    await expect(loadHostKeys({ files: [garbage] })).rejects.toThrow(garbage);
    const publicOnly = join(dir, 'public_key');
    await writeFile(publicOnly, clientKey().public);
    await expect(loadHostKeys({ files: [publicOnly] })).rejects.toThrow(/public_key is a public key/);
  });
});
