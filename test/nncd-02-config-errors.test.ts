// NNCD-02: get clear errors for an invalid deployment config.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/node/config-validate.js';
import { baseConfig, PKG_DIR, runNncd, tempDir, writeConfig } from './ssh-helpers.js';

const SCHEMA = join(PKG_DIR, 'schemas/server.schema.json');

/** A valid TLS listener, and a valid RFC 7407 SHA-256 fingerprint. */
const SHA256 = '04' + ':ab'.repeat(32);
const TLS = { cert: 'c.pem', key: 'k.pem', ca: ['ca.pem'], certToName: [{ id: 1, fingerprint: SHA256, mapType: 'san-rfc822-name' }] };

/** Configs the schema and the validator must agree on. */
const SAMPLES: Record<string, unknown>[] = [
  { device: 'd.json' },
  { device: 'd.json', store: 'file', stateDir: 's' },
  { device: 'd.json', store: 'file' },
  { device: 'd.json', store: 'disk' },
  { device: 3 },
  {},
  { device: 'd.json', extra: true },
  { device: 'd.json', listen: { ssh: { port: 70000 } } },
  { device: 'd.json', listen: { ssh: { port: 830, address: '::', hostKeys: ['k'] } } },
  { device: 'd.json', listen: { ssh: { host: 'x' } } },
  { device: 'd.json', listen: { port: 830 } },
  { device: 'd.json', listen: {} },
  { device: 'd.json', listen: { ssh: {}, tls: TLS } },
  { device: 'd.json', listen: { tls: { ...TLS, port: 6513, address: '::' } } },
  { device: 'd.json', listen: { tls: { ...TLS, port: -1 } } },
  { device: 'd.json', listen: { tls: { cert: 'c.pem', key: 'k.pem', ca: ['ca.pem'] } } },
  { device: 'd.json', listen: { tls: { ...TLS, ca: [] } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [] } } },
  { device: 'd.json', listen: { tls: { ...TLS, cert: undefined } } },
  { device: 'd.json', listen: { tls: { ...TLS, extra: 1 } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [{ id: 1, fingerprint: SHA256, mapType: 'specified', name: 'admin' }] } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [{ id: 1, fingerprint: SHA256, mapType: 'specified' }] } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [{ id: 1, fingerprint: SHA256, mapType: 'common-name', name: 'x' }] } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [{ id: 1, fingerprint: SHA256, mapType: 'cn' }] } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [{ id: -1, fingerprint: SHA256, mapType: 'san-any' }] } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [{ id: 1, fingerprint: 'SHA256:' + 'A'.repeat(43), mapType: 'san-dns-name' }] } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [{ id: 1, fingerprint: '02' + ':ab'.repeat(20), mapType: 'san-any' }] } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [{ id: 1, fingerprint: 'ab'.repeat(33), mapType: 'san-any' }] } } },
  { device: 'd.json', listen: { tls: { ...TLS, certToName: [{ fingerprint: SHA256, mapType: 'san-any' }] } } },
  { device: 'd.json', users: [{ username: 'a', password: 'p' }] },
  { device: 'd.json', users: [{ username: 'a', password: 'p', lab: true }] },
  { device: 'd.json', users: [{ username: 'a', password: 'p', lab: false }] },
  { device: 'd.json', users: [{ username: 'a', passwordHash: 'plain' }] },
  { device: 'd.json', users: [{ username: 'a', passwordHash: '$scrypt$x', authorizedKeys: ['ssh-ed25519 A'], groups: ['g'] }] },
  { device: 'd.json', users: [{ password: 'p', lab: true }] },
  { device: 'd.json', providers: [{ module: './p.mjs', path: '/m:x', startup: 'adopt', options: { any: [1] } }] },
  { device: 'd.json', providers: [{ module: './p.mjs', path: 'm:x' }] },
  { device: 'd.json', providers: [{ path: '/m:x' }] },
  { device: 'd.json', providers: [{ module: './p.mjs', startup: 'later' }] },
  { device: 'd.json', control: { enabled: true, users: ['admin'] } },
  { device: 'd.json', control: { enabled: 'yes' } },
  { device: 'd.json', nacm: { recoveryUsers: ['root', 'admin'] } },
  { device: 'd.json', nacm: {} },
  { device: 'd.json', nacm: { recoveryUsers: [''] } },
  { device: 'd.json', nacm: { recoveryUsers: 'root' } },
  { device: 'd.json', nacm: { recoveryUsers: [3] } },
  { device: 'd.json', nacm: { recovery: ['root'] } },
  { device: 'd.json', nacm: true },
  { device: 'd.json', startup: 'adopt', unclaimed: 'reject', logLevel: 'debug' },
  { device: 'd.json', logLevel: 'loud' },
  { device: 'd.json', $schema: './schema.json' },
];

describe('NNCD-02 config errors', { timeout: 30_000 }, () => {
  it('ships a JSON Schema for the config that editors can use, and the checks agree with it', async () => {
    const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./schemas/server.schema.json']).toBe('./schemas/server.schema.json');
    const schema = JSON.parse(await readFile(SCHEMA, 'utf8')) as Record<string, unknown>;
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    for (const sample of SAMPLES) {
      expect(validateConfig(sample).length === 0, JSON.stringify(sample)).toBe(validate(sample));
    }
    // A config pointing $schema at the shipped schema is itself valid.
    expect(validateConfig({ $schema: './node_modules/net-netconf-server/schemas/server.schema.json', device: 'd.json' })).toEqual([]);
  });

  it('stops on a config that breaks the schema, listing every problem by JSON path, with status 2', async () => {
    const config = await writeConfig({ device: 7, store: 'file', listen: { ssh: { port: -1 } }, users: [{ username: 'u', password: 'p' }], providers: [{ path: 'x' }], surprise: 1 });
    const r = await runNncd(['--config', config]);
    expect(r.code).toBe(2);
    for (const path of ['/device', '/stateDir', '/listen/ssh/port', '/users/0/password', '/providers/0/module', '/providers/0/path', '/surprise']) {
      expect(r.stderr).toContain(`  ${path}: `);
    }
    const notJson = join(await tempDir(), 'server.json');
    await writeFile(notJson, '{ device: ');
    const j = await runNncd(['--config', notJson]);
    expect(j.code).toBe(2);
    expect(j.stderr).toContain('/: is not valid JSON');
    // Usage errors are status 2 as well.
    expect((await runNncd([])).code).toBe(2);
    expect((await runNncd(['--frobnicate'])).code).toBe(2);
  });

  it('stops with status 1 and names the item when something the config names fails to load', async () => {
    const dir = await tempDir();
    const missingDevice = await runNncd(['--config', await writeConfig(baseConfig({ device: 'nowhere/device.json' }), dir)]);
    expect(missingDevice.code).toBe(1);
    expect(missingDevice.stderr).toContain(join(dir, 'nowhere/device.json'));

    const badKey = join(dir, 'bad_key');
    await writeFile(badKey, 'not a key');
    const key = await runNncd(['--config', await writeConfig(baseConfig({ listen: { ssh: { hostKeys: [badKey] } } }))]);
    expect(key.code).toBe(1);
    expect(key.stderr).toContain(badKey);

    const state = await tempDir();
    await writeFile(join(state, 'startup.json'), JSON.stringify({ 'writes-test:system': { mtu: 1 } }));
    const startup = await runNncd(['--config', await writeConfig(baseConfig({ stateDir: state, store: 'file' }))]);
    expect(startup.code).toBe(1);
    expect(startup.stderr).toContain(join(state, 'startup.json'));
    expect(startup.stderr).toContain('mtu');

    const badUser = await runNncd(['--config', await writeConfig(baseConfig({ users: [{ username: 'ops', authorizedKeys: ['ssh-ed25519 garbage'] }] }))]);
    expect(badUser.code).toBe(1);
    expect(badUser.stderr).toContain('User ops');
  });

  it('with --check, validates the config and everything it names, then exits without listening', async () => {
    const ok = await runNncd(['--config', await writeConfig(baseConfig({ listen: { ssh: { port: 1 } } })), '--check']);
    // Port 1 can't be bound without privileges: --check never tries.
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('OK (device writes)');
    expect(ok.stderr).not.toContain('Listening');

    const state = await tempDir();
    await writeFile(join(state, 'startup.json'), '{ not json');
    const bad = await runNncd(['--config', await writeConfig(baseConfig({ stateDir: state, store: 'file' })), '--check']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain(join(state, 'startup.json'));
    // No host key is generated by a check.
    const empty = await tempDir();
    await runNncd(['--config', await writeConfig(baseConfig({ stateDir: empty })), '--check']);
    await expect(readFile(join(empty, 'ssh_host_ed25519_key'))).rejects.toThrow();

    const schema = await runNncd(['--config', await writeConfig({ device: 1 }), '--check']);
    expect(schema.code).toBe(2);
  });
});
