// SSH-04: plug in custom authentication.
import { serializeXml } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { hashPassword, sshListener, staticUsers, type AuthAttempt, type Authenticate } from '../src/index.js';
import { clientKey, HOST_KEY, recordingLogger, sshClient, sshServer } from './ssh-helpers.js';
import { cert, tlsClient, tlsFingerprint, tlsServer } from './tls-helpers.js';

describe('SSH-04 custom authentication', () => {
  it('awaits the function with each password or public-key attempt, and accepts it when it returns a principal', async () => {
    const key = clientKey();
    const attempts: AuthAttempt[] = [];
    const authenticate: Authenticate = async (attempt) => {
      attempts.push(attempt);
      await new Promise((r) => setTimeout(r, 10));
      return { username: attempt.username };
    };
    const fixture = await sshServer({ authenticate });
    await (await sshClient(fixture.port, { username: 'pw-user', password: 'any' })).close();
    await (await sshClient(fixture.port, { username: 'key-user', privateKey: key.private })).close();
    expect(attempts[0]).toMatchObject({ method: 'password', username: 'pw-user', password: 'any', sourceHost: '127.0.0.1' });
    const keyAttempt = attempts[1] as Extract<AuthAttempt, { method: 'publickey' }>;
    expect(keyAttempt).toMatchObject({ method: 'publickey', username: 'key-user', key: { algorithm: 'ssh-ed25519' } });
    // The key as an authorized_keys line has it, base64-encoded.
    expect(key.public).toContain(Buffer.from(keyAttempt.key.data).toString('base64'));
    // Only signed attempts reach the hook: once per login.
    expect(attempts).toHaveLength(2);
    await fixture.close();
  });

  it("attaches the principal's username and groups to the session", async () => {
    const { logger, entries } = recordingLogger();
    const fixture = await sshServer({ server: { logger }, authenticate: () => ({ username: 'alice', groups: ['ops', 'lab'] }) });
    const client = await sshClient(fixture.port, { username: 'alice', password: 'x' });
    const monitoring = await client.ops.get({ filter: { 'ietf-netconf-monitoring:netconf-state': { sessions: {} } } });
    const text = serializeXml(monitoring);
    expect(text).toContain('<username>alice</username>');
    expect(text).toContain('<source-host>127.0.0.1</source-host>');
    expect(entries.find((e) => e.message === 'Session started')?.context).toMatchObject({ username: 'alice', transport: 'ssh' });
    expect(entries.find((e) => e.message === 'Request get')?.context).toMatchObject({ username: 'alice', groups: ['ops', 'lab'] });
    await client.close();
    await fixture.close();
  });

  it('refuses when the function returns nothing, throws or times out, logging the error', async () => {
    const { logger, entries } = recordingLogger();
    const nothing = await sshServer({ authenticate: () => undefined });
    await expect(sshClient(nothing.port)).rejects.toThrow();
    await nothing.close();

    const throws = await sshServer({ server: { logger }, authenticate: () => Promise.reject(new Error('directory down')) });
    await expect(sshClient(throws.port)).rejects.toThrow();
    expect(entries.find((e) => e.level === 'error')?.context).toMatchObject({ error: 'directory down', username: 'netconf' });
    await throws.close();

    entries.length = 0;
    const slow = await sshServer({ server: { logger }, listener: { authTimeout: 50 }, authenticate: () => new Promise(() => undefined) });
    await expect(sshClient(slow.port)).rejects.toThrow();
    expect(entries.find((e) => e.level === 'error')?.context['error']).toMatch(/no answer within 50 ms/);
    await slow.close();
  });

  it('uses the built-in static users as an implementation of the same function', async () => {
    const users = staticUsers([{ username: 'admin', passwordHash: await hashPassword('pw') }]);
    // The same type a custom hook has, plugged in the same way.
    const listener = sshListener({ hostKeys: [HOST_KEY], authenticate: users, port: 0, address: '127.0.0.1' });
    expect(typeof listener.start).toBe('function');
    expect(await users({ method: 'password', username: 'admin', password: 'pw' })).toEqual({ username: 'admin' });
    expect(await users({ method: 'password', username: 'admin', password: 'nope' })).toBeUndefined();
    const fixture = await sshServer({ authenticate: users });
    await (await sshClient(fixture.port, { username: 'admin', password: 'pw' })).close();
    await expect(sshClient(fixture.port, { username: 'admin', password: 'nope' })).rejects.toThrow();
    await fixture.close();
  });

  it('awaits the function with a certificate attempt: the mapped name, fingerprint, subject and DER', async () => {
    const attempts: AuthAttempt[] = [];
    const fixture = await tlsServer({
      authenticate: (attempt) => {
        attempts.push(attempt);
        return { username: `${attempt.username}-principal`, groups: ['tls'] };
      },
    });
    const client = await tlsClient(fixture.port, 'client');
    const text = serializeXml(await client.ops.get({ filter: { 'ietf-netconf-monitoring:netconf-state': { sessions: {} } } }));
    expect(text).toContain('<username>netconf-principal</username>');
    await client.close();
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0] as Extract<AuthAttempt, { method: 'certificate' }>;
    expect(attempt).toMatchObject({ method: 'certificate', username: 'netconf', sourceHost: '127.0.0.1', certificate: { subject: 'CN=netconf' } });
    expect(Buffer.from(attempt.certificate.der).equals(cert('client').raw)).toBe(true);
    expect(attempt.certificate.fingerprint).toBe(`SHA256:${Buffer.from(tlsFingerprint('client').slice(3).replace(/:/g, ''), 'hex').toString('base64').replace(/=+$/, '')}`);
    await fixture.close();
  });

  it('sees a certificate only after validation and mapping, and can still refuse it, throw or time out', async () => {
    const { logger, entries } = recordingLogger();
    const seen: string[] = [];
    const refusing = await tlsServer({ server: { logger }, authenticate: (a) => void seen.push(a.username) });
    // Untrusted and unmapped certificates never reach the hook.
    await expect(tlsClient(refusing.port, 'other-client')).rejects.toThrow();
    await expect(tlsClient(refusing.port, 'multi-cn-client')).rejects.toThrow();
    expect(seen).toEqual([]);
    await expect(tlsClient(refusing.port, 'client')).rejects.toThrow();
    expect(seen).toEqual(['netconf']);
    await refusing.close();

    const throws = await tlsServer({ server: { logger }, authenticate: () => Promise.reject(new Error('directory down')) });
    await expect(tlsClient(throws.port)).rejects.toThrow();
    expect(entries.find((e) => e.level === 'error')?.context).toMatchObject({ error: 'directory down', method: 'certificate', username: 'netconf' });
    await throws.close();

    entries.length = 0;
    const slow = await tlsServer({ server: { logger }, listener: { authTimeout: 50 }, authenticate: () => new Promise(() => undefined) });
    await expect(tlsClient(slow.port)).rejects.toThrow();
    expect(entries.find((e) => e.level === 'error')?.context['error']).toMatch(/no answer within 50 ms/);
    await slow.close();
  });
});
