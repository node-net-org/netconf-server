// TLS-01: connect over NETCONF over TLS with a client certificate.
import { serializeXml } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { NETCONF_TLS_PORT, tlsListener, staticUsers } from '../src/index.js';
import { recordingLogger } from './ssh-helpers.js';
import { BY_CN, pem, rawTls, tlsClient, tlsFingerprint, tlsServer } from './tls-helpers.js';

describe('TLS-01 NETCONF over TLS', { timeout: 30_000 }, () => {
  it('listens on a configured address and port, 6513 by default', async () => {
    expect(NETCONF_TLS_PORT).toBe(6513);
    const fixture = await tlsServer();
    expect(fixture.listener.address()).toEqual({ address: '127.0.0.1', port: fixture.port });
    await (await tlsClient(fixture.port)).close();
    await fixture.close();
    expect(fixture.listener.address()).toBeUndefined();
  });

  it('accepts only TLS 1.2 or later', async () => {
    const { logger, entries } = recordingLogger();
    const fixture = await tlsServer({ server: { logger } });
    const old = await rawTls(fixture.port, {
      cert: pem('client.pem'),
      key: pem('client.key'),
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1.1',
      ciphers: 'DEFAULT@SECLEVEL=0',
    });
    expect(old.data).not.toContain('hello');
    expect(old.error).toBeDefined();
    const v12 = await rawTls(fixture.port, { cert: pem('client.pem'), key: pem('client.key'), maxVersion: 'TLSv1.2' });
    expect(v12.data).toContain('<hello');
    await fixture.close();
    // OpenSSL's reason, not its whole error string; at debug, since no certificate was refused.
    const failed = entries.find((e) => e.message === 'TLS handshake failed');
    expect(failed?.level).toBe('debug');
    expect(failed?.context['reason']).toMatch(/^[a-z ]+$/);
  });

  it('refuses a client with no certificate, or one from an untrusted CA, before any NETCONF message', async () => {
    const { logger, entries } = recordingLogger();
    const fixture = await tlsServer({ server: { logger } });
    const failures = (): unknown[] => entries.filter((e) => e.message === 'TLS handshake failed').map((e) => ({ level: e.level, ...e.context }));
    const none = await rawTls(fixture.port);
    expect(none.data).toBe('');
    const untrusted = await rawTls(fixture.port, { cert: pem('other-client.pem'), key: pem('other-client.key') });
    expect(untrusted.data).toBe('');
    await expect(tlsClient(fixture.port, 'other-client')).rejects.toThrow();
    // A self-signed certificate isn't trusted unless it is itself a trust anchor.
    await expect(tlsClient(fixture.port, 'self-client')).rejects.toThrow();
    await fixture.close();
    // Each refusal says why, at info, as a refused login does.
    const untrustedCa = { level: 'info', reason: 'the client certificate is not issued by a trusted CA', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', sourceHost: '127.0.0.1' };
    expect(failures()).toEqual([
      { level: 'info', reason: 'the client sent no certificate', code: 'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE', sourceHost: '127.0.0.1' },
      untrustedCa,
      untrustedCa,
      { level: 'info', reason: 'the client certificate is self-signed and not a trust anchor', code: 'DEPTH_ZERO_SELF_SIGNED_CERT', sourceHost: '127.0.0.1' },
    ]);
  });

  it('never trusts the public root store: only the configured anchors', async () => {
    // A server trusting only other-ca refuses the test CA's clients.
    const fixture = await tlsServer({ listener: { ca: pem('other-ca.pem') } });
    await expect(tlsClient(fixture.port, 'client')).rejects.toThrow();
    await fixture.close();
  });

  it('accepts a self-signed client certificate that is itself a trust anchor', async () => {
    const fixture = await tlsServer({
      users: [{ username: 'self' }],
      listener: { ca: [pem('ca.pem'), pem('self-client.pem')], certToName: [{ id: 1, fingerprint: tlsFingerprint('self-client'), mapType: 'common-name' }] },
    });
    await (await tlsClient(fixture.port, 'self-client')).close();
    await fixture.close();
  });

  it('makes each connection one session that works as over SSH, reported as netconf-tls with the mapped user', async () => {
    const { logger, entries } = recordingLogger();
    const fixture = await tlsServer({ server: { logger }, users: [{ username: 'netconf', groups: ['ops'] }] });
    const a = await tlsClient(fixture.port);
    const b = await tlsClient(fixture.port);
    expect(a.session.sessionId).not.toBe(b.session.sessionId);
    const text = serializeXml(await a.ops.get({ filter: { 'ietf-netconf-monitoring:netconf-state': { sessions: {} } } }));
    expect(text.match(/ncm:netconf-tls/g)).toHaveLength(2);
    expect(text).toContain('<username>netconf</username>');
    expect(text).toContain('<source-host>127.0.0.1</source-host>');
    expect(entries.find((e) => e.message === 'Session started')?.context).toMatchObject({ username: 'netconf', transport: 'tls' });
    expect(entries.find((e) => e.message === 'Request get')?.context).toMatchObject({ username: 'netconf', groups: ['ops'] });
    await a.close();
    await b.close();
    await fixture.close();
  });

  it('closes a refused connection without a NETCONF reply and logs the fingerprint, subject and address', async () => {
    const { logger, entries } = recordingLogger();
    // plain-client maps to "plain", whom nobody listed.
    const fixture = await tlsServer({ server: { logger } });
    const refused = await rawTls(fixture.port, { cert: pem('plain-client.pem'), key: pem('plain-client.key') });
    expect(refused.data).toBe('');
    const entry = entries.find((e) => e.message === 'Login refused');
    expect(entry?.level).toBe('info');
    expect(entry?.context).toMatchObject({ method: 'certificate', username: 'plain', subject: 'CN=plain', sourceHost: '127.0.0.1' });
    expect(entry?.context['fingerprint']).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    // An unmapped certificate is refused the same way.
    entries.length = 0;
    const unmapped = await tlsServer({ server: { logger }, listener: { certToName: [{ id: 1, fingerprint: tlsFingerprint('ca'), mapType: 'san-ip-address' }] } });
    await expect(tlsClient(unmapped.port, 'plain-client')).rejects.toThrow();
    expect(entries.find((e) => e.message === 'Login refused')?.context['reason']).toMatch(/no cert-to-name entry/);
    await unmapped.close();
    await fixture.close();
  });

  it('refuses the client and logs it when deciding fails unexpectedly, without an unhandled rejection', async () => {
    const { logger, entries } = recordingLogger();
    // A logger that throws while refusing: onSecure fails after the handshake.
    const info = (message: string, context?: Record<string, unknown>): void => {
      if (message === 'Login refused') throw new Error('log sink down');
      logger.info(message, context);
    };
    const throwing = { ...logger, info };
    const fixture = await tlsServer({ listener: { logger: throwing } });
    const refused = await rawTls(fixture.port, { cert: pem('plain-client.pem'), key: pem('plain-client.key') });
    expect(refused.data).toBe('');
    await expect.poll(() => entries.find((e) => e.message === 'TLS login failed with an error')?.context['error']).toBe('log sink down');
    // The listener still serves.
    await (await tlsClient(fixture.port)).close();
    await fixture.close();
  });

  it('stops new connections on close and, optionally, ends the sessions it accepted', async () => {
    const fixture = await tlsServer();
    const client = await tlsClient(fixture.port);
    const ended = new Promise((ok) => client.session.onClosed(ok));
    await fixture.listener.close({ endSessions: true });
    await ended;
    await expect(tlsClient(fixture.port)).rejects.toThrow();
    await fixture.close();

    // Without endSessions, existing sessions carry on.
    const second = await tlsServer();
    const kept = await tlsClient(second.port);
    await second.listener.close();
    await expect(tlsClient(second.port)).rejects.toThrow();
    expect((await kept.ops.get({ filter: { 'ietf-netconf-monitoring:netconf-state': { sessions: {} } } })) !== undefined).toBe(true);
    await kept.close();
    await second.close();
  });

  it('rejects a listener with no trust anchor, no mapping or a certificate that is not PEM', () => {
    const base = { cert: pem('server.pem'), key: pem('server.key'), ca: pem('ca.pem'), certToName: BY_CN, authenticate: staticUsers([]) };
    expect(() => tlsListener({ ...base, ca: [] })).toThrow(/at least one trust anchor/);
    expect(() => tlsListener({ ...base, ca: 'not a certificate' })).toThrow(/ca 1 has no PEM certificate/);
    expect(() => tlsListener({ ...base, certToName: [] })).toThrow(/at least one entry/);
    expect(() => tlsListener({ ...base, cert: 'nope' })).toThrow(/cert is not a PEM certificate/);
  });
});
