// nncd over SSH with real clients (SSH-01 AC4): netopeer2's client (from the
// netopeer2 image, on the host network, since this host may drop container
// to host TCP), @node-net/netconf, and nnc read, write and subscribe.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeXml } from '@node-net/netconf/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES, PKG_DIR, sshClient, startNncd, tempDir, writeConfig, type RunningNncd } from '../ssh-helpers.js';

const IMAGE = process.env['NETOPEER2_IMAGE'] ?? 'sysrepo/sysrepo-netopeer2@sha256:36cc1d841c97f118d62f775024d60fb1ce210c3bca6b32135c1a9e5a358a1cc9';
const NNC = join(PKG_DIR, '../cli/dist/main.js');
const NT = 'urn:example:notif';

let dir: string;
let nncd: RunningNncd;

beforeAll(async () => {
  dir = await tempDir('nncd-interop-');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'id')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host')]);
  const pub = execFileSync('cat', [join(dir, 'id.pub')], { encoding: 'utf8' }).trim();
  const config = await writeConfig(
    {
      device: join(FIXTURES, 'notifications/device.json'),
      listen: { ssh: { address: '127.0.0.1', port: 0, hostKeys: ['host'] } },
      users: [
        { username: 'admin', authorizedKeys: [pub] },
        { username: 'netconf', password: 'netconf', lab: true },
      ],
    },
    dir,
  );
  nncd = await startNncd(['--config', config]);
});

afterAll(async () => {
  expect((await nncd.stop()).code).toBe(0);
});

describe('nncd with real NETCONF clients', () => {
  it("netopeer2's client connects, exchanges hellos and reads", async () => {
    const ssh = join(dir, 'ssh');
    await mkdir(ssh, { recursive: true });
    const hostPub = execFileSync('cut', ['-d', ' ', '-f1,2', join(dir, 'host.pub')], { encoding: 'utf8' }).trim();
    await writeFile(join(ssh, 'known_hosts'), `[127.0.0.1]:${nncd.port} ${hostPub}\n`);
    await chmod(join(dir, 'id'), 0o644);
    const script = [
      'auth keys add /k/id.pub /k/id',
      'auth pref publickey 10',
      `connect --host 127.0.0.1 --port ${nncd.port} --login admin`,
      'get-config --source running',
      'disconnect',
      '',
    ].join('\n');
    const r = spawnSync('docker', ['run', '--rm', '-i', '--network', 'host', '-v', `${dir}:/k:ro`, '-v', `${ssh}:/root/.ssh:ro`, '--entrypoint', 'netopeer2-cli', IMAGE], {
      input: script,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.stdout + r.stderr).toContain('<servers xmlns="urn:example:notif">');
    expect(r.stdout + r.stderr).not.toContain('failed');
    await expect.poll(() => nncd.stderr()).toMatch(/"Session started" sessionId=\d+ username=admin transport=ssh/);
  });

  it('@node-net/netconf reads, writes and subscribes', async () => {
    const watcher = await sshClient(nncd.port);
    const events: string[] = [];
    watcher.session.onNotification((n) => events.push(serializeXml(n.element)));
    await watcher.session.rpc('<create-subscription xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"/>');
    const writer = await sshClient(nncd.port);
    await writer.session.rpc(
      `<edit-config xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><target><running/></target><config><servers xmlns="${NT}"><server><name>b</name><port>9090</port></server></servers></config></edit-config>`,
    );
    expect(serializeXml(await writer.ops.getConfig({ source: 'running' }))).toContain('<name>b</name>');
    await expect.poll(() => events.some((e) => e.includes('netconf-config-change') && e.includes('<username>netconf</username>'))).toBe(true);
    await writer.close();
    await watcher.close();
  });

  it.skipIf(!existsSync(NNC))('nnc reads, writes and subscribes', async () => {
    const targets = join(dir, 'targets.json');
    await writeFile(targets, JSON.stringify({ nncd: { host: '127.0.0.1', port: nncd.port, username: 'admin', privateKey: join(dir, 'id'), hostKey: 'insecure-accept-any' } }));
    const r = spawnSync(
      process.execPath,
      [NNC, '-t', targets, 'nncd', '-c', 'read /notif-test:servers', '-c', "set /notif-test:servers/server[name='a']/port 8181", '-c', "value /notif-test:servers/server[name='a']/port", '-c', 'create-subscription'],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, HOME: dir } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('<servers xmlns="urn:example:notif">');
    expect(r.stdout).toMatch(/^8181$/m);
  });
});
