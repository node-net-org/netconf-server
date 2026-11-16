// STORE-02: the memory store. STORE-03: saved configuration at start-up, pushed to providers.
import { describe, expect, it } from 'vitest';
import { createServer, DeviceError, memoryStore, RpcFailure } from '../src/core.js';
import { config, editConfig, send, WT, writesDevice, writesSession, writesVariant } from './writes-helpers.js';
import { providersDevice, recorder, type Call } from './providers-helpers.js';

const sys = (body: string): string => `<system xmlns="${WT}">${body}</system>`;
const runningSaved = (): ReturnType<typeof writesVariant> => writesVariant((d) => ({ ...d, capabilities: { ...d.capabilities, startup: false } }));

describe('STORE-02 memory store', () => {
  it('is the default when no store is given', async () => {
    const device = await runningSaved();
    const a = await writesSession({ device });
    await send(a.c, editConfig('running', sys('<hostname>changed</hostname>')));
    // A second server with no store doesn't see the first one's changes.
    const b = await writesSession({ device });
    expect(await config(b.c, device)).toMatchObject({ 'writes-test:system': { hostname: 'r1' } });
  });

  it('starts from the device definition’s initial data every time', async () => {
    const device = await writesDevice();
    for (let i = 0; i < 2; i++) {
      const { c } = await writesSession({ device, store: memoryStore() });
      expect(await config(c, device)).toEqual({
        'writes-test:system': { hostname: 'r1', dns: ['8.8.8.8'] },
        'writes-test:interfaces': { interface: [{ name: 'eth0', type: 'ethernet', address: '10.0.0.1' }] },
      });
      await send(c, editConfig('running', sys('<hostname>scratch</hostname>')));
    }
  });

  // AC3 (works in a browser, with no file system) is checked by portable:check, which runs an edit and a commit in the browser bundle.
});

describe('STORE-03 push saved configuration to backends at start-up', () => {
  it('accepts a server-wide start-up mode of push or adopt, and refuses anything else', async () => {
    const device = await writesDevice();
    for (const startup of ['push', 'adopt'] as const) await expect(createServer({ device, startup })).resolves.toBeDefined();
    await expect(createServer({ device, startup: 'pull' as 'push' })).rejects.toThrow(TypeError);
  });

  it('starts unclaimed data from the saved copy, or from the initial data on the first run', async () => {
    const device = await runningSaved();
    const store = memoryStore();
    const first = await writesSession({ device, store });
    expect(await config(first.c, device)).toMatchObject({ 'writes-test:system': { hostname: 'r1' } });
    await send(first.c, editConfig('running', sys('<hostname>saved</hostname>')));
    await first.srv.close();
    const second = await writesSession({ device, store });
    expect(await config(second.c, device)).toMatchObject({ 'writes-test:system': { hostname: 'saved' } });
  });

  it('passes each provider’s saved configuration through prepare and commit before accepting sessions (push, the default)', async () => {
    const device = await providersDevice();
    const log: Call[] = [];
    const srv = await createServer({ device, providers: [{ path: '/providers-test:interfaces/interface', provider: recorder('interfaces', log) }] });
    expect(srv.sessions).toEqual([]);
    expect(log).toEqual([
      {
        hook: 'prepare',
        name: 'interfaces',
        cause: 'startup',
        changes: [
          { operation: 'create', path: "/providers-test:interfaces/interface[name='eth0']" },
          { operation: 'create', path: "/providers-test:interfaces/interface[name='eth1']" },
        ],
      },
      { hook: 'commit', name: 'interfaces', cause: 'startup' },
    ]);
  });

  it('lets each provider override the server’s start-up mode', async () => {
    const device = await providersDevice();
    const log: Call[] = [];
    let loads = 0;
    const load = (): object => (loads++, { 'providers-test:system': { hostname: 'from-backend' } });
    await createServer({
      device,
      startup: 'adopt',
      providers: [
        { path: '/providers-test:interfaces/interface', provider: recorder('interfaces', log, {}, { startup: 'push' }) },
        { path: '/providers-test:system', provider: recorder('system', log, {}, { load: load as never }) },
      ],
    });
    expect(log.map((l) => `${l.hook}:${l.name}`)).toEqual(['prepare:interfaces', 'commit:interfaces']);
    expect(loads).toBe(1);
  });

  it('does not start when a provider refuses its start-up configuration, with the provider’s errors', async () => {
    const device = await providersDevice();
    const refuse = (): Error => new RpcFailure({ type: 'application', tag: 'resource-denied', message: 'eth1 has no driver' });
    const err = await createServer({ device, providers: [{ path: '/providers-test:interfaces/interface', provider: recorder('interfaces', [], { refuse }) }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceError);
    expect((err as DeviceError).message).toContain('/providers-test:interfaces/interface');
    expect((err as DeviceError).issues.map((i) => i.message)).toEqual(['eth1 has no driver']);
  });
});
