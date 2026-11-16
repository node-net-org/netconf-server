// STORE-05: the server refuses to start with configuration that breaks the schema (design §9).
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer, DeviceError, fileStore, type Store } from '../src/index.js';
import { writesDevice, writesVariant } from './writes-helpers.js';
import { providersDevice } from './providers-helpers.js';

/** A store that already holds `json` for `datastore`. */
function seeded(datastore: 'running' | 'startup', json: string): Store {
  return { location: 'seeded', load: (ds) => Promise.resolve(ds === datastore ? json : undefined), save: () => Promise.resolve() };
}

describe('STORE-05 start-up validation', () => {
  it('validates the start-up configuration before accepting sessions', async () => {
    const good = JSON.stringify({ 'writes-test:system': { hostname: 'from-store' } });
    const srv = await createServer({ device: await writesDevice(), store: seeded('startup', good) });
    expect(srv.sessions).toEqual([]);
    const bad = JSON.stringify({ 'writes-test:system': { 'admin-interface': 'eth9' } });
    await expect(createServer({ device: await writesDevice(), store: seeded('startup', bad) })).rejects.toThrow(DeviceError);
  });

  it('does not start with invalid saved data, and reports every violation with its path and source', async () => {
    const device = await writesVariant((d) => ({ ...d, capabilities: { ...d.capabilities, startup: false } }));
    const bad = JSON.stringify({ 'writes-test:system': { mtu: 9, 'admin-interface': 'eth9' } });
    const err = (await createServer({ device, store: seeded('running', bad) }).catch((e: unknown) => e)) as DeviceError;
    expect(err).toBeInstanceOf(DeviceError);
    expect(err.issues.length).toBeGreaterThan(0);
    for (const issue of err.issues) expect(issue.path).toMatch(/^seeded \(running\) \/writes-test:system/);
  });

  it('names the provider whose load() supplied a violation, and the saved file or device definition for the rest', async () => {
    const device = await providersDevice();
    // The adopted routes refer to an interface the device definition's data doesn't have.
    const routes = { 'providers-test:routes': { route: [{ prefix: '0/0', via: 'eth7' }] } };
    const err = (await createServer({
      device,
      providers: [{ path: '/providers-test:routes', provider: { startup: 'adopt', load: () => routes } }],
    }).catch((e: unknown) => e)) as DeviceError;
    expect(err).toBeInstanceOf(DeviceError);
    expect(err.issues.map((i) => i.path)).toEqual(["the provider at /providers-test:routes (load) /providers-test:routes/route[prefix='0/0']/via"]);
    // Removing the interface the saved routes use, through the adopted interfaces, blames the saved data's source.
    const store = seeded('running', JSON.stringify({ 'providers-test:routes': { route: [{ prefix: '0/0', via: 'eth1' }] } }));
    const ifaces = { 'providers-test:interfaces': { interface: [{ name: 'eth0' }] } };
    const err2 = (await createServer({
      device,
      store,
      providers: [{ path: '/providers-test:interfaces/interface', provider: { startup: 'adopt', load: () => ifaces } }],
    }).catch((e: unknown) => e)) as DeviceError;
    expect(err2.issues.map((i) => i.path)).toEqual(["seeded (running) /providers-test:routes/route[prefix='0/0']/via"]);
  });

  it('stops start-up with an error naming a saved file that cannot be parsed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nnc-store-'));
    await writeFile(join(dir, 'startup.json'), '{ not json');
    const failure = createServer({ device: await writesDevice(), store: fileStore(dir) });
    await expect(failure).rejects.toThrow(DeviceError);
    await expect(failure).rejects.toThrow(join(dir, 'startup.json'));
  });
});
