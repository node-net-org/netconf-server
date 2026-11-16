// NNCD-03: load provider modules named in the config.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serializeXml } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { readServerConfig } from '../src/index.js';
import { baseConfig, FIXTURES, PKG_DIR, runNncd, sshClient, startNncd, tempDir, writeConfig } from './ssh-helpers.js';

const SYSTEM = join(FIXTURES, 'nncd/system-provider.mjs');

describe('NNCD-03 provider modules', { timeout: 30_000 }, () => {
  it('takes a module, an optional path, an optional start-up mode and options for each provider', async () => {
    const config = await writeConfig(
      baseConfig({
        providers: [
          { module: SYSTEM, path: '/writes-test:system', startup: 'adopt', options: { hostname: 'adopted' } },
          { module: join(FIXTURES, 'nncd/list-provider.mjs'), options: { prefix: '198.51.100.0/24' } },
        ],
      }),
    );
    const loaded = await readServerConfig(config);
    expect(loaded.config.providers).toHaveLength(2);
    const nncd = await startNncd(['--config', config]);
    const client = await sshClient(nncd.port);
    const running = serializeXml(await client.ops.getConfig({ source: 'running' }));
    // startup: adopt took the hostname from the provider's load(); the second registered itself where it said.
    expect(running).toContain('<hostname>adopted</hostname>');
    expect(running).toContain('<prefix>198.51.100.0/24</prefix>');
    await client.close();
    expect((await nncd.stop()).code).toBe(0);
  });

  it('imports each module, calls its default export with the options, and registers the provider it returns', async () => {
    const dir = await tempDir();
    const record = join(dir, 'called.json');
    const options = { record, hostname: 'h1', nested: { list: [1, 2] } };
    const config = await writeConfig(baseConfig({ providers: [{ module: SYSTEM, path: '/writes-test:system', options }] }), dir);
    const nncd = await startNncd(['--config', config]);
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ options, configDir: dir, hasLogger: true });
    // The factory's logger is nncd's.
    expect(nncd.stderr()).toContain('system provider created');
    const client = await sshClient(nncd.port);
    const state = serializeXml(await client.ops.get({ filter: { 'net-netconf-server-monitoring:providers': {} } }));
    await client.close();
    await nncd.stop();
    expect(state).toContain('/writes-test:system');
  });

  it("stops start-up naming the module when it can't be imported, has no default export, or its factory throws", async () => {
    const cases: [string, RegExp][] = [
      ['broken.mjs', /Can't import provider module .*broken\.mjs \(providers\/0\)/],
      ['no-default.mjs', /no-default\.mjs \(providers\/0\) has no default export that is a function/],
      ['throws.mjs', /throws\.mjs \(providers\/0\) failed: backend unreachable/],
      ['missing.mjs', /Can't import provider module .*missing\.mjs/],
    ];
    for (const [file, message] of cases) {
      const r = await runNncd(['--config', await writeConfig(baseConfig({ providers: [{ module: join(FIXTURES, 'nncd', file), path: '/writes-test:system' }] }))]);
      expect(r.code, file).toBe(1);
      expect(r.stderr).toMatch(message);
    }
    // --check imports without calling factories.
    const check = await runNncd(['--config', await writeConfig(baseConfig({ providers: [{ module: join(FIXTURES, 'nncd/throws.mjs'), path: '/writes-test:system' }] })), '--check']);
    expect(check.code).toBe(0);
  });

  it('documents that the config is trusted like code', async () => {
    const readme = await readFile(join(PKG_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/\*\*The config is trusted like code\.\*\* It names modules for nncd to import, so whoever can edit it can run code as the server\./);
    const schema = JSON.parse(await readFile(join(PKG_DIR, 'schemas/server.schema.json'), 'utf8')) as { description: string };
    expect(schema.description).toContain('trusted like code');
    expect((await runNncd(['--help'])).stdout).toContain('trusted like code');
  });
});
