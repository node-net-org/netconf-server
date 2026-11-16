// PKG-01: import the server through its package exports.
// PKG-02: run the server core in a browser (the clock and the generated module file; portable:check does the browser run).
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../src/core.js';
import * as root from '../src/index.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

describe('PKG-01 package exports', () => {
  it('the root entry is the core plus device files, the file store, the SSH and TLS listeners and the deployment config', () => {
    const nodeOnly = [
      'loadDeviceFile',
      'fileStore',
      'sshListener',
      'NETCONF_SSH_PORT',
      'tlsListener',
      'NETCONF_TLS_PORT',
      'certToName',
      'mapCertificateToName',
      'certificateFingerprint',
      'CERT_TO_NAME_MAP_TYPES',
      'loadHostKeys',
      'generateHostKey',
      'GENERATED_HOST_KEY',
      'staticUsers',
      'hashPassword',
      'verifyPassword',
      'readServerConfig',
      'prepareServer',
      'ConfigError',
      'StartError',
    ];
    expect(Object.keys(root).sort()).toEqual([...Object.keys(core), ...nodeOnly].sort());
    // The Node-free entry has none of them.
    for (const name of nodeOnly) expect(core).not.toHaveProperty(name);
    for (const name of ['createServer', 'NetconfServer', 'loadDevice', 'validateDefinition', 'DeviceError', 'RpcFailure', 'systemClock']) {
      expect(core).toHaveProperty(name);
    }
  });

  it('declares ESM-only exports for the root, the core and the schema, on Node 22.12 or later', async () => {
    const pkg = JSON.parse(await readFile(`${pkgDir}/package.json`, 'utf8')) as {
      type: string;
      engines: { node: string };
      exports: Record<string, unknown>;
      dependencies: Record<string, string>;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.engines.node).toBe('>=22.12');
    expect(Object.keys(pkg.exports)).toEqual(['.', './core', './schemas/device.schema.json', './schemas/server.schema.json', './devices/*', './package.json']);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@node-net/netconf', '@node-net/yang', 'ssh2']);
  });

  it('neither @node-net/netconf nor @node-net/yang depends on the server', async () => {
    for (const dep of ['@node-net/netconf', '@node-net/yang']) {
      const text = await readFile(createRequire(import.meta.url).resolve(`${dep}/package.json`), 'utf8');
      expect(text).not.toContain('@node-net/netconf-server');
    }
  });
});

describe('PKG-02 browser-safe core', () => {
  it('runs every server timer through the injected clock', async () => {
    let scheduled = 0;
    const clock = { now: () => 0, setTimeout: () => ++scheduled, clearTimeout: () => undefined };
    const srv = await core.createServer({ device: { id: 'c', yang: { modules: [] } }, clock });
    const client = await (await import('@node-net/netconf')).connect({ transport: srv.transport() });
    expect(scheduled).toBe(1); // the hello timeout
    expect(srv.clock).toBe(clock);
    await client.close();
  });

  it('the embedded base modules are up to date with modules/', () => {
    execFileSync(process.execPath, ['scripts/gen-base-modules.mjs', '--check'], { cwd: pkgDir });
  });
});
