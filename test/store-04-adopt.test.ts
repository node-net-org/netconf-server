// STORE-04: adopting a backend's own configuration at start-up (design §9).
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createServer, memoryStore } from '../src/core.js';
import { config, send } from './writes-helpers.js';
import { providersDevice, providersSession, recorder, type Call } from './providers-helpers.js';
import { rawOpen } from './helpers.js';

const SYSTEM = '/providers-test:system';
const fromBackend = { 'providers-test:system': { hostname: 'from-backend' } };

describe('STORE-04 adopt a backend’s own configuration at start-up', () => {
  it('uses the provider’s load() as running for its subtree, replacing the saved copy', async () => {
    const device = await providersDevice();
    const store = memoryStore();
    const srv = await createServer({ device, store, providers: [{ path: SYSTEM, provider: { startup: 'adopt', load: () => fromBackend } }] });
    const c = await rawOpen(srv);
    expect(await config(c, device)).toMatchObject({ 'providers-test:system': { hostname: 'from-backend' }, 'providers-test:routes': { route: [{ via: 'eth0' }] } });
    expect(JSON.parse((await store.load('running'))!)).toMatchObject({ 'providers-test:system': { hostname: 'from-backend' } });
    // Registered later, an adopting provider's load() replaces its subtree of running too.
    await srv.provide('/providers-test:routes', { startup: 'adopt', load: () => ({ 'providers-test:routes': { route: [{ prefix: '1/1', via: 'eth1' }] } }) });
    expect(await config(c, device)).toMatchObject({ 'providers-test:routes': { route: [{ prefix: '1/1', via: 'eth1' }] } });
  });

  it('rejects a provider registered with adopt and no load function', async () => {
    const device = await providersDevice();
    await expect(createServer({ device, providers: [{ path: SYSTEM, provider: { startup: 'adopt' } }] })).rejects.toThrow(/adopt.*no load/);
    const { srv } = await providersSession({ startup: 'adopt' });
    await expect(srv.provide(SYSTEM, {})).rejects.toThrow(/adopt.*no load/);
  });

  it('does not push adopted configuration back through prepare and commit', async () => {
    const device = await providersDevice();
    const log: Call[] = [];
    const srv = await createServer({ device, providers: [{ path: SYSTEM, provider: recorder('system', log, {}, { startup: 'adopt', load: () => fromBackend }) }] });
    expect(log).toEqual([]);
    const c = await rawOpen(srv);
    await send(c, `<edit-config><target><running/></target><config><system xmlns="urn:example:providers"><contact>x</contact></system></config></edit-config>`);
    expect(log.map((l) => l.hook)).toEqual(['prepare', 'commit']);
  });

  it('documents that under adopt a provider’s commit must make changes permanent on the backend', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('Under `adopt`, a provider\'s `commit` must make changes permanent on the backend for them to survive a restart.');
  });
});
