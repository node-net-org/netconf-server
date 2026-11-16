// SSH-01: connect over the NETCONF SSH subsystem (RFC 6242).
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NETCONF_SSH_PORT } from '../src/index.js';
import { clientKey, rawSsh, readUntil, sshClient, sshServer, subsystem, type SshFixture } from './ssh-helpers.js';

const HELLO = `<?xml version="1.0" encoding="UTF-8"?><hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities></hello>]]>]]>`;

let fixture: SshFixture | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const hasSsh = (() => {
  try {
    return spawn('ssh', ['-V']).pid !== undefined;
  } catch {
    return false;
  }
})();

describe('SSH-01 the NETCONF SSH subsystem', { timeout: 30_000 }, () => {
  it('listens on the configured address and port, 830 by default, and serves the netconf subsystem', async () => {
    expect(NETCONF_SSH_PORT).toBe(830);
    fixture = await sshServer();
    expect(fixture.listener.address()).toEqual({ address: '127.0.0.1', port: fixture.port });
    const client = await sshClient(fixture.port);
    expect(client.session.serverCapabilities.toArray()).toContain('urn:ietf:params:netconf:base:1.1');
    await client.close();
  });

  it('refuses shell, exec and other subsystems, and the connection stays usable for netconf', async () => {
    fixture = await sshServer();
    const c = await rawSsh(fixture.port);
    await expect(subsystem(c, 'sftp')).rejects.toThrow();
    await expect(new Promise((ok, fail) => c.exec('id', (err, ch) => (err === undefined ? ch.once('close', (code: number | undefined) => (code === undefined ? fail(new Error('refused')) : ok(code))) : fail(err))))).rejects.toThrow();
    await expect(new Promise((ok, fail) => c.shell((err, ch) => (err === undefined ? ok(ch) : fail(err))))).rejects.toThrow();
    const channel = await subsystem(c, 'netconf');
    expect(await readUntil(channel, /<session-id>\d+<\/session-id>/)).toContain('<hello');
    c.end();
  });

  it('makes each netconf channel one session', async () => {
    fixture = await sshServer();
    const c = await rawSsh(fixture.port);
    const [a, b] = await Promise.all([subsystem(c, 'netconf'), subsystem(c, 'netconf')]);
    const ids = await Promise.all([a, b].map(async (ch) => /<session-id>(\d+)<\/session-id>/.exec(await readUntil(ch, /<\/hello>/))![1]));
    expect(new Set(ids).size).toBe(2);
    for (const ch of [a, b]) ch.write(HELLO);
    await expect.poll(() => fixture!.server.sessions.map((s) => s.transport)).toEqual(['ssh', 'ssh']);
    c.end();
  });

  it('serves @node-net/netconf and the OpenSSH client (ssh -s); netopeer2-cli is covered by test:interop', async () => {
    const key = clientKey();
    fixture = await sshServer({ users: [{ username: 'admin', authorizedKeys: [key.public] }] });
    const client = await sshClient(fixture.port, { username: 'admin', privateKey: key.private });
    expect(client.session.sessionId).toBeGreaterThan(0);
    await client.close();

    if (!hasSsh) return;
    const dir = await mkdtemp(join(tmpdir(), 'ssh-01-'));
    const keyFile = join(dir, 'id_ed25519');
    await writeFile(keyFile, key.private, { mode: 0o600 });
    const child = spawn(
      'ssh',
      ['-s', '-p', String(fixture.port), '-i', keyFile, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'LogLevel=ERROR', 'admin@127.0.0.1', 'netconf'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const hello = await readUntil(child.stdout, /<\/hello>/, 10_000);
    expect(hello).toMatch(/<session-id>\d+<\/session-id>/);
    child.stdin.write(HELLO);
    child.stdin.write('<rpc message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><close-session/></rpc>]]>]]>');
    expect(await readUntil(child.stdout, /<ok\/>/, 10_000)).toContain('message-id="1"');
    child.kill();
  });

  it('stops accepting when the listener closes, and optionally ends the sessions it accepted', async () => {
    fixture = await sshServer();
    const kept = await sshClient(fixture.port);
    await fixture.listener.close();
    await expect(sshClient(fixture.port)).rejects.toThrow();
    // Still open: closing the listener alone leaves sessions be.
    await expect(kept.ops.getConfig({ source: 'running' })).resolves.toBeDefined();

    const second = await sshServer();
    const dropped = await sshClient(second.port);
    const closed = new Promise((r) => dropped.session.onClosed(r));
    await second.listener.close({ endSessions: true });
    await closed;
    await expect(sshClient(second.port)).rejects.toThrow();
    await kept.close();
    await second.close();
  });
});
