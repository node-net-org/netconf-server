import { describe, expect, it } from 'vitest';
import { config, editConfig, errorTags, isOk, send } from './writes-helpers.js';
import { PT, providersSession, recorder, type Call } from './providers-helpers.js';

describe('PROVIDER-01 register a provider on a subtree', () => {
  it('registers a provider with any subset of its members', async () => {
    const { srv } = await providersSession();
    const all = await srv.provide('/providers-test:interfaces/interface', {
      onRead: () => undefined,
      maxAge: 100,
      onReadTimeout: 'error',
      prepare: () => undefined,
      startup: 'adopt',
      load: () => ({ 'providers-test:interfaces': { interface: [{ name: 'eth0', mtu: 1500 }] } }),
      after: ['/providers-test:system'],
      actions: { '/providers-test:interfaces/interface/reset': () => ({ result: 'done' }) },
      timeouts: { read: 500 },
    });
    const none = await srv.provide('/providers-test:system', {});
    const rpcOnly = await srv.provide('/providers-test:routes', { rpcs: { 'providers-test:ping': () => undefined } });
    expect(srv.providers.map((p) => p.path)).toEqual([all.path, none.path, rpcOnly.path]);
    expect(all.path).toBe('/providers-test:interfaces/interface');
  });

  it('rejects a path that is not in the schema, naming it', async () => {
    const { srv } = await providersSession();
    await expect(srv.provide('/providers-test:nowhere', {})).rejects.toThrow('/providers-test:nowhere');
    await expect(srv.provide('/providers-test:interfaces/interface/bogus', {})).rejects.toThrow('/providers-test:interfaces/interface/bogus');
    expect(srv.providers).toEqual([]);
  });

  it('rejects two providers at one path; the deepest registration owns its subtree', async () => {
    const { srv, c } = await providersSession();
    const log: Call[] = [];
    await srv.provide('/providers-test:system', recorder('system', log));
    await expect(srv.provide('/providers-test:system', {})).rejects.toThrow('already registered at /providers-test:system');
    await srv.provide('/providers-test:system/hostname', recorder('hostname', log));
    log.length = 0;

    expect(isOk(await send(c, editConfig('running', `<system xmlns="${PT}"><hostname>r2</hostname></system>`)))).toBe(true);
    expect(log.filter((l) => l.hook === 'prepare')).toEqual([
      { hook: 'prepare', name: 'hostname', cause: 'edit', changes: [{ operation: 'replace', path: '/providers-test:system/hostname' }] },
    ]);
    log.length = 0;
    expect(isOk(await send(c, editConfig('running', `<system xmlns="${PT}"><contact>ops</contact></system>`)))).toBe(true);
    expect(log.filter((l) => l.hook === 'prepare').map((l) => [l.name, l.changes])).toEqual([['system', [{ operation: 'create', path: '/providers-test:system/contact' }]]]);
  });

  it('stores, reads and validates data no provider claims', async () => {
    const { srv, c, device } = await providersSession();
    await srv.provide('/providers-test:system', {});
    expect(isOk(await send(c, editConfig('running', `<extra xmlns="${PT}"><kept>yes</kept></extra>`)))).toBe(true);
    expect(await config(c, device)).toMatchObject({ 'providers-test:extra': { kept: 'yes' } });
    // A route via an interface that doesn't exist breaks its leafref: unclaimed data is still validated.
    const reply = await send(c, editConfig('running', `<routes xmlns="${PT}"><route><prefix>0/0</prefix><via>eth9</via></route></routes>`));
    expect(errorTags(reply)).toEqual(['data-missing']);
  });

  it('unregisters a provider, after which its subtree is unclaimed', async () => {
    const { srv, c } = await providersSession();
    const log: Call[] = [];
    const handle = await srv.provide('/providers-test:system', recorder('system', log));
    handle.unregister();
    expect(srv.providers).toEqual([]);
    log.length = 0;
    expect(isOk(await send(c, editConfig('running', `<system xmlns="${PT}"><hostname>r3</hostname></system>`)))).toBe(true);
    expect(log).toEqual([]);
  });
});
