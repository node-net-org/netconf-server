// NNCD-01: start a server from a deployment config.
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeXml } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { baseConfig, FIXTURES, PKG_DIR, runNncd, sshClient, startNncd, tempDir, writeConfig } from './ssh-helpers.js';

describe('NNCD-01 start from a deployment config', { timeout: 30_000 }, () => {
  it('starts a server from the device, store, policies, listener, users and providers the file names', async () => {
    const dir = await tempDir();
    const config = await writeConfig(
      baseConfig({
        stateDir: 'state',
        store: 'file',
        unclaimed: 'store',
        control: { enabled: false },
        users: [{ username: 'admin', password: 'admin-pw', lab: true }],
        providers: [{ module: join(FIXTURES, 'nncd/system-provider.mjs'), path: '/writes-test:system', startup: 'adopt', options: { hostname: 'from-config' } }],
      }),
      dir,
    );
    const nncd = await startNncd(['--config', config]);
    const client = await sshClient(nncd.port, { username: 'admin', password: 'admin-pw' });
    const running = serializeXml(await client.ops.getConfig({ source: 'running' }));
    expect(running).toContain('<hostname>from-config</hostname>');
    // The control module is off, as the config says.
    expect(client.session.serverCapabilities.toArray().join(' ')).not.toContain('net-netconf-server-control');
    await client.close();
    expect((await nncd.stop()).code).toBe(0);
    // The file store saved what the device boots from, in the state directory.
    expect(JSON.parse(await readFile(join(dir, 'state/startup.json'), 'utf8'))).toBeTypeOf('object');
  });

  it('resolves paths in the config relative to the config file', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'providers'));
    await copyFile(join(FIXTURES, 'nncd/system-provider.mjs'), join(dir, 'providers/system.mjs'));
    const record = join(dir, 'record.json');
    const config = await writeConfig(
      baseConfig({
        device: join(FIXTURES, 'writes/device.json'),
        stateDir: 'state',
        listen: { ssh: { hostKeys: ['keys/host'] } },
        providers: [{ module: './providers/system.mjs', path: '/writes-test:system', options: { record } }],
      }),
      dir,
    );
    // A host key file relative to the config, missing: the error names it where the config said.
    const missing = await runNncd(['--config', config], { cwd: PKG_DIR });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(join(dir, 'keys/host'));

    const fixed = await writeConfig(
      baseConfig({ device: join(FIXTURES, 'writes/device.json'), stateDir: 'state', providers: [{ module: './providers/system.mjs', path: '/writes-test:system', options: { record } }] }),
      dir,
    );
    // Run from another directory: the module, the state directory and the generated key are all found next to the config.
    const nncd = await startNncd(['--config', fixed], { cwd: await tempDir() });
    expect(JSON.parse(await readFile(record, 'utf8'))).toMatchObject({ configDir: dir });
    expect(nncd.stderr()).toContain(join(dir, 'state/ssh_host_ed25519_key'));
    expect((await nncd.stop()).code).toBe(0);
  });

  it('logs the address, port, device id and host key fingerprints once listening, and exits 0 only after a clean shutdown', async () => {
    const nncd = await startNncd(['--config', await writeConfig(baseConfig())]);
    const log = nncd.stderr();
    expect(log).toMatch(/Listening for NETCONF over SSH" address=127\.0\.0\.1 port=\d+ hostKeys="ssh-ed25519 SHA256:[A-Za-z0-9+/]{43}"/);
    expect(log).toMatch(/nncd started" device=writes /);
    expect(nncd.port).toBeGreaterThan(0);
    const { code } = await nncd.stop();
    expect(code).toBe(0);
    expect(nncd.stderr()).toContain('nncd stopped');
  });

  it('lists the options with --help and prints the package version with --version', async () => {
    const help = await runNncd(['--help']);
    expect(help.code).toBe(0);
    for (const option of ['--config', '--check', '--log-level', '--help', '--version', 'hash-password']) expect(help.stdout).toContain(option);
    const version = await runNncd(['--version']);
    const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8')) as { version: string };
    expect(version.stdout.trim()).toBe(pkg.version);
    expect(version.code).toBe(0);
  });
});
