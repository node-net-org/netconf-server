// nncd over TLS with netopeer2's client (TLS-01): mutual X.509 and cert-to-name
// with a real RFC 7589 client, run from the netopeer2 image on the host
// network (this host may drop container to host TCP). libnetconf2 checks the
// server certificate's DNS name, not its IP address, so it connects to
// localhost.
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES, startNncd, writeConfig, type RunningNncd } from '../ssh-helpers.js';
import { TLS_DIR, tlsFingerprint } from '../tls-helpers.js';

const IMAGE = process.env['NETOPEER2_IMAGE'] ?? 'sysrepo/sysrepo-netopeer2@sha256:36cc1d841c97f118d62f775024d60fb1ce210c3bca6b32135c1a9e5a358a1cc9';

let nncd: RunningNncd;

beforeAll(async () => {
  const config = await writeConfig({
    device: `${FIXTURES}writes/device.json`,
    listen: {
      tls: {
        address: '127.0.0.1',
        port: 0,
        cert: `${TLS_DIR}server.pem`,
        key: `${TLS_DIR}server.key`,
        ca: [`${TLS_DIR}ca.pem`],
        certToName: [{ id: 1, fingerprint: tlsFingerprint('ca'), mapType: 'common-name' }],
      },
    },
    users: [{ username: 'netconf' }],
  });
  nncd = await startNncd(['--config', config]);
});

afterAll(async () => {
  expect((await nncd.stop()).code).toBe(0);
});

function netopeer2(client: string): string {
  const script = [
    `connect --tls --host localhost --port ${nncd.port} --cert /t/${client}.pem --key /t/${client}.key --trusted /t/ca.pem`,
    'get-config --source running',
    'disconnect',
    '',
  ].join('\n');
  const r = spawnSync('docker', ['run', '--rm', '-i', '--network', 'host', '-v', `${TLS_DIR}:/t:ro`, '--entrypoint', 'netopeer2-cli', IMAGE], {
    input: script,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return r.stdout + r.stderr;
}

describe('nncd over TLS with netopeer2', () => {
  it("netopeer2's client connects with a certificate, exchanges hellos and reads", async () => {
    const out = netopeer2('client');
    expect(out).toContain('<name>eth0</name>');
    expect(out).not.toMatch(/failed/);
    await expect.poll(() => nncd.stderr()).toMatch(/"Session started" sessionId=\d+ username=netconf transport=tls/);
  });

  it('refuses its client with a certificate from an untrusted CA', () => {
    const out = netopeer2('other-client');
    expect(out).not.toContain('<name>eth0</name>');
  });
});
