// NNCD-06: choose SSH, TLS or both listeners in the deployment config.
import { createServer as createNetServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { prepareServer, readServerConfig } from '../src/index.js';
import { baseConfig, runNncd, sshClient, startNncd, writeConfig, type NncdResult } from './ssh-helpers.js';
import { TLS_DIR, tlsClient, tlsFingerprint } from './tls-helpers.js';

/** A TLS listener config on the fixture certificates, mapping test-CA clients by CN. */
function tls(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cert: `${TLS_DIR}server.pem`,
    key: `${TLS_DIR}server.key`,
    ca: [`${TLS_DIR}ca.pem`],
    certToName: [{ id: 1, fingerprint: tlsFingerprint('ca'), mapType: 'common-name' }],
    ...extra,
  };
}

const portOf = (stderr: string, transport: string): number => Number(new RegExp(`nncd started.* ${transport}=127\\.0\\.0\\.1:(\\d+)`).exec(stderr)?.[1]);

describe('NNCD-06 listeners', { timeout: 60_000 }, () => {
  it('listens for SSH on port 830 when the config names no listeners', async () => {
    const { listen: _, ...noListen } = baseConfig();
    const prepared = await prepareServer(await readServerConfig(await writeConfig(noListen)), { check: true });
    expect(prepared.listeners.ssh?.port).toBe(830);
    expect(prepared.listeners.tls).toBeUndefined();
  });

  it('starts exactly the listeners the config names: TLS only, or both', async () => {
    const tlsOnly = await startNncd(['--config', await writeConfig(baseConfig({ listen: { tls: tls() } }))]);
    const port = portOf(tlsOnly.stderr(), 'tls');
    expect(tlsOnly.stderr()).not.toMatch(/Listening for NETCONF over SSH/);
    expect(tlsOnly.stderr()).not.toMatch(/nncd started.* ssh=/);
    await (await tlsClient(port)).close();
    await tlsOnly.stop();

    const both = await startNncd(['--config', await writeConfig(baseConfig({ listen: { ssh: {}, tls: tls() } }))]);
    const sshPort = portOf(both.stderr(), 'ssh');
    const tlsPort = portOf(both.stderr(), 'tls');
    expect(sshPort).not.toBe(tlsPort);
    await (await sshClient(sshPort)).close();
    await (await tlsClient(tlsPort)).close();
    // The server certificate's fingerprint is logged alongside the host keys'.
    expect(both.stderr()).toMatch(/Listening for NETCONF over TLS" .*certificate=SHA256:/);
    expect(both.stderr()).toMatch(/Listening for NETCONF over SSH" .*hostKeys=/);
    expect((await both.stop()).code).toBe(0);
  });

  it('rejects a config that names no listener, or a TLS listener missing an item, with status 2', async () => {
    const empty = await runNncd(['--config', await writeConfig({ ...baseConfig(), listen: {} })]);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('/listen: must name at least one listener');
    const { key: _, ...noKey } = tls();
    const missing = await runNncd([
      '--config',
      await writeConfig(
        baseConfig({
          listen: {
            tls: { ...noKey, certToName: [{ id: 1, fingerprint: 'nope', mapType: 'specified' }, { id: 1, fingerprint: tlsFingerprint('ca'), mapType: 'san-any', name: 'x' }] },
          },
        }),
      ),
    ]);
    expect(missing.code).toBe(2);
    for (const path of ['/listen/tls/key', '/listen/tls/certToName/0/fingerprint', '/listen/tls/certToName/0/name', '/listen/tls/certToName/1/id', '/listen/tls/certToName/1/name']) {
      expect(missing.stderr).toContain(`  ${path}: `);
    }
  });

  it('stops with status 1, naming the file, for a certificate, key or trust anchor it can\'t use; --check finds them all', async () => {
    const run = async (listenTls: Record<string, unknown>, check: boolean): Promise<NncdResult> =>
      runNncd(['--config', await writeConfig(baseConfig({ listen: { tls: listenTls } })), ...(check ? ['--check'] : [])]);

    const missing = await run(tls({ cert: `${TLS_DIR}absent.pem` }), true);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(`${TLS_DIR}absent.pem`);

    const mismatch = await run(tls({ key: `${TLS_DIR}client.key` }), true);
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toMatch(new RegExp(`TLS key ${TLS_DIR}client\\.key can't be used with the certificate`));

    const notPem = await run(tls({ ca: [`${TLS_DIR}README.md`] }), true);
    expect(notPem.code).toBe(1);
    expect(notPem.stderr).toContain(`trust anchor ${TLS_DIR}README.md is not a PEM certificate`);

    const badCert = await run(tls({ cert: `${TLS_DIR}server.key` }), false);
    expect(badCert.code).toBe(1);
    expect(badCert.stderr).toContain(`certificate ${TLS_DIR}server.key is not a PEM certificate`);

    // The schema refuses an MD5 or SHA-1 fingerprint (status 2); a SHA-256 one of the wrong length is caught when loading.
    const sha1 = await run(tls({ certToName: [{ id: 1, fingerprint: '02' + ':ab'.repeat(32), mapType: 'common-name' }] }), true);
    expect(sha1.code).toBe(2);
    expect(sha1.stderr).toContain('/listen/tls/certToName/0/fingerprint: ');
    const short = await run(tls({ certToName: [{ id: 1, fingerprint: '04' + ':ab'.repeat(30), mapType: 'common-name' }] }), true);
    expect(short.code).toBe(1);
    expect(short.stderr).toMatch(/id 1: a sha256 fingerprint has 32 octets after the algorithm octet, not 30/);

    const ok = await run(tls(), true);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/OK/);
  });

  it('stops with status 1, naming the address, when a listener can\'t bind', async () => {
    const busy = createNetServer();
    await new Promise<void>((ok) => busy.listen(0, '127.0.0.1', ok));
    const port = (busy.address() as { port: number }).port;
    const r = await runNncd(['--config', await writeConfig(baseConfig({ listen: { ssh: {}, tls: tls({ port }) } }))]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Can't listen for TLS on 127.0.0.1:${port}`);
    busy.close();
  });
});
