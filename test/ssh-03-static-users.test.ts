// SSH-03: log in as a configured user with a password or key.
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { hashPassword, staticUsers, verifyPassword } from '../src/index.js';
import { baseConfig, clientKey, NNCD, PKG_DIR, recordingLogger, runNncd, sshClient, sshServer, writeConfig } from './ssh-helpers.js';
import { tlsClient, tlsServer } from './tls-helpers.js';

const SECRET = 'Corr3ct-horse';

describe('SSH-03 static users', { timeout: 30_000 }, () => {
  it('lists users with a username, an optional scrypt hash, optional authorized keys and optional groups', async () => {
    const key = clientKey();
    const hash = await hashPassword(SECRET);
    expect(hash).toMatch(/^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    const auth = staticUsers([
      { username: 'admin', passwordHash: hash, groups: ['admins'] },
      { username: 'ops', authorizedKeys: [key.public] },
      { username: 'nobody' },
    ]);
    expect(await auth({ method: 'password', username: 'admin', password: SECRET })).toEqual({ username: 'admin', groups: ['admins'] });
    expect(await auth({ method: 'password', username: 'nobody', password: '' })).toBeUndefined();
    expect(() => staticUsers([{ username: 'x', passwordHash: '$scrypt$nonsense' }])).toThrow(/User x: passwordHash/);
    expect(() => staticUsers([{ username: 'y', authorizedKeys: ['ssh-ed25519 not-base64'] }])).toThrow(/User y: authorized key 1/);
  });

  it('logs a user in with a matching password or a key matching one of theirs', async () => {
    const key = clientKey();
    const fixture = await sshServer({
      users: [
        { username: 'admin', passwordHash: await hashPassword(SECRET) },
        { username: 'ops', authorizedKeys: [clientKey().public, key.public] },
      ],
    });
    const byPassword = await sshClient(fixture.port, { username: 'admin', password: SECRET });
    const byKey = await sshClient(fixture.port, { username: 'ops', privateKey: key.private });
    await expect.poll(() => fixture.server.sessions.map((s) => s.username).sort()).toEqual(['admin', 'ops']);
    await byPassword.close();
    await byKey.close();
    await fixture.close();
  });

  it('refuses a wrong password, unknown user or unauthorized key alike, logged at info without the password', async () => {
    const { logger, entries } = recordingLogger();
    const fixture = await sshServer({
      server: { logger },
      users: [{ username: 'admin', passwordHash: await hashPassword(SECRET), authorizedKeys: [clientKey().public] }],
    });
    const failures: unknown[] = await Promise.all([
      sshClient(fixture.port, { username: 'admin', password: 'wrong-pass-1' }).catch((e: Error) => e),
      sshClient(fixture.port, { username: 'ghost', password: SECRET }).catch((e: Error) => e),
      sshClient(fixture.port, { username: 'admin', privateKey: clientKey().private }).catch((e: Error) => e),
    ]);
    for (const f of failures) expect(f).toBeInstanceOf(Error);
    // The same error whatever was wrong.
    expect(new Set((failures as Error[]).map((f) => `${f.constructor.name}: ${f.message.replace(/ghost|admin/g, 'USER')}`)).size).toBe(1);
    const refusals = entries.filter((e) => e.message === 'Login refused');
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    for (const r of refusals) expect(r.level).toBe('info');
    expect(refusals.map((r) => r.context['username'])).toEqual(expect.arrayContaining(['admin', 'ghost']));
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain('wrong-pass-1');
    expect(logged).not.toContain(SECRET);
    await fixture.close();
  });

  it('makes a password hash from a password typed at a prompt, or piped in', async () => {
    const piped = await runNncd(['hash-password'], { input: `${SECRET}\n` });
    expect(piped.code).toBe(0);
    expect(await verifyPassword(SECRET, piped.stdout.trim())).toBe(true);

    // At a terminal (through script(1) for a pty): asked twice, never echoed.
    const out = await new Promise<string>((ok) => {
      const child = spawn('script', ['-qec', `${JSON.stringify(process.execPath)} ${JSON.stringify(NNCD)} hash-password`, '/dev/null'], { cwd: PKG_DIR });
      let text = '';
      child.stdout.on('data', (d: Buffer) => {
        text += d.toString();
        if (/Password: $/.test(text)) child.stdin.write(`${SECRET}\r`);
        if (/Again: $/.test(text)) child.stdin.write(`${SECRET}\r`);
      });
      child.on('close', () => ok(text));
    });
    expect(out).toContain('Password:');
    expect(out).toContain('Again:');
    expect(out).not.toContain(SECRET);
    const hash = /\$scrypt\$\S+/.exec(out)![0];
    expect(await verifyPassword(SECRET, hash)).toBe(true);
  });

  it('rejects a plain-text password at start-up unless the user is a lab user, which logs a warning', async () => {
    expect(() => staticUsers([{ username: 'admin', password: 'admin' }])).toThrow(/lab user/);
    const bad = await runNncd(['--config', await writeConfig(baseConfig({ users: [{ username: 'admin', password: 'admin' }] })), '--check']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('/users/0/password');

    const { logger, entries } = recordingLogger();
    staticUsers([{ username: 'netconf', password: 'netconf', lab: true }], { logger });
    expect(entries).toEqual([expect.objectContaining({ level: 'warn', context: { username: 'netconf' } })]);
    const lab = await runNncd(['--config', await writeConfig(baseConfig()), '--check']);
    expect(lab.code).toBe(0);
    expect(lab.stderr).toMatch(/warn .*plain-text password.* username=netconf/);
  });

  it("accepts a TLS certificate login whose mapped name is a listed user, with that user's groups, and refuses an unlisted name", async () => {
    const users = staticUsers([{ username: 'netconf', groups: ['ops'] }]);
    const certificate = { fingerprint: 'SHA256:x', subject: 'CN=netconf', der: new Uint8Array() };
    expect(await users({ method: 'certificate', username: 'netconf', certificate })).toEqual({ username: 'netconf', groups: ['ops'] });
    expect(await users({ method: 'certificate', username: 'nobody', certificate })).toBeUndefined();

    const fixture = await tlsServer({ authenticate: users });
    await (await tlsClient(fixture.port, 'client')).close();
    // plain-client maps (by CN) to "plain", whom nobody listed.
    await expect(tlsClient(fixture.port, 'plain-client')).rejects.toThrow();
    await fixture.close();
  });
});
