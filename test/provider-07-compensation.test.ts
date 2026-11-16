import { describe, expect, it } from 'vitest';
import type { OutOfSyncEvent } from '../src/core.js';
import { dataJson } from './reads-helpers.js';
import { config, editConfig, isOk, rpcErrors, send } from './writes-helpers.js';
import { getData, iface, NMDA, PT, providersSession, recorder, type Call, type ProvidersData } from './providers-helpers.js';

const IF = '/providers-test:interfaces/interface';
const ROUTES = '/providers-test:routes';
const both = `${iface('eth0', '<mtu>1400</mtu>')}<routes xmlns="${PT}"><route><prefix>0/0</prefix><via>eth1</via></route></routes>`;
const onEdit = (message: string) => (_: unknown, ctx: { cause: string }) => (ctx.cause === 'edit' ? new Error(message) : undefined);
const onCompensation = (message: string) => (_: unknown, ctx: { cause: string }) => (ctx.cause === 'compensation' ? new Error(message) : undefined);

describe('PROVIDER-07 recover when a provider’s commit fails', () => {
  it('gives the providers that committed the inverse changes through prepare and commit, and keeps running', async () => {
    const { srv, c, device } = await providersSession();
    const log: Call[] = [];
    await srv.provide(IF, recorder('interfaces', log));
    await srv.provide(ROUTES, recorder('routes', log, { failCommit: onEdit('the route daemon crashed') }));
    const before = await config(c, device);
    log.length = 0;
    await send(c, editConfig('running', both));
    expect(log.filter((l) => l.cause === 'compensation' && l.name === 'interfaces')).toEqual([
      { hook: 'prepare', name: 'interfaces', cause: 'compensation', changes: [{ operation: 'replace', path: `${IF}[name='eth0']/mtu` }] },
      { hook: 'commit', name: 'interfaces', cause: 'compensation' },
    ]);
    // The provider whose commit failed never committed: it is aborted, not compensated.
    expect(log.filter((l) => l.name === 'routes' && l.cause !== 'edit')).toEqual([]);
    expect(log.filter((l) => l.name === 'routes').map((l) => l.hook)).toEqual(['prepare', 'commit', 'abort']);
    expect(await config(c, device)).toEqual(before);
  });

  it('answers operation-failed naming the provider that failed', async () => {
    const { srv, c } = await providersSession();
    await srv.provide(IF, recorder('interfaces', []));
    await srv.provide(ROUTES, recorder('routes', [], { failCommit: onEdit('the route daemon crashed') }));
    const errors = rpcErrors(await send(c, editConfig('running', both)));
    expect(errors.map((e) => e.tag)).toEqual(['operation-failed']);
    expect(errors[0]!.message).toContain(ROUTES);
    expect(errors[0]!.message).toContain('the route daemon crashed');
  });

  it('marks a subtree out of sync when compensation fails too: event, handle and operational', async () => {
    const { srv, c, device } = await providersSession();
    const events: OutOfSyncEvent[] = [];
    srv.on('outOfSync', (e) => events.push(e));
    const ifs = await srv.provide(IF, recorder('interfaces', [], { failCommit: onCompensation('the NIC won’t go back') }));
    await srv.provide(ROUTES, recorder('routes', [], { failCommit: onEdit('the route daemon crashed') }));
    await send(c, editConfig('running', both));
    expect(ifs.outOfSync).toBe(true);
    expect(events).toEqual([{ path: IF, outOfSync: true, reason: expect.stringContaining('the NIC won’t go back') as string }]);
    const data = dataJson(device, await send(c, getData(`<providers xmlns="urn:node-net:yang:net-netconf-server-monitoring"/>`)), NMDA) as unknown as ProvidersData;
    expect(data['net-netconf-server-monitoring:providers'].provider).toEqual([
      { path: IF, 'out-of-sync': true, reason: expect.stringContaining('the NIC won’t go back') as string },
      { path: ROUTES, 'out-of-sync': false },
    ]);
  });

  it('lets a provider clear the mark after reconciling', async () => {
    const { srv, c, device } = await providersSession();
    const events: OutOfSyncEvent[] = [];
    srv.on('outOfSync', (e) => events.push(e));
    const ifs = await srv.provide(IF, {});
    ifs.markOutOfSync('drifted');
    ifs.clearOutOfSync();
    expect(ifs.outOfSync).toBe(false);
    expect(events.map((e) => e.outOfSync)).toEqual([true, false]);
    const data = dataJson(device, await send(c, getData(`<providers xmlns="urn:node-net:yang:net-netconf-server-monitoring"/>`)), NMDA) as unknown as ProvidersData;
    expect(data['net-netconf-server-monitoring:providers'].provider).toEqual([{ path: IF, 'out-of-sync': false }]);
  });

  it('stays available for reads and other writes while a subtree is out of sync', async () => {
    const { srv, c, device } = await providersSession();
    const ifs = await srv.provide(IF, recorder('interfaces', []));
    ifs.markOutOfSync('drifted');
    expect(isOk(await send(c, editConfig('running', iface('eth1', '<mtu>1600</mtu>'))))).toBe(true);
    expect(isOk(await send(c, editConfig('running', `<system xmlns="${PT}"><contact>noc</contact></system>`)))).toBe(true);
    expect(await config(c, device)).toMatchObject({ 'providers-test:system': { contact: 'noc' } });
    expect(rpcErrors(await send(c, getData('')))).toEqual([]);
  });
});
