import { describe, expect, it } from 'vitest';
import { dataJson } from './reads-helpers.js';
import { rpcErrors, send, settle } from './writes-helpers.js';
import { deferred, get, getData, NMDA, PT, providersSession, type ProvidersData } from './providers-helpers.js';

const IFACES = `<interfaces xmlns="${PT}"/>`;
const SYSTEM = `<system xmlns="${PT}"/>`;

describe('PROVIDER-02 refresh state when it is read', () => {
  it('runs the read hook of each provider the filter selects, and of no other, for get and get-data of operational', async () => {
    const { srv, c } = await providersSession();
    const calls: string[] = [];
    await srv.provide('/providers-test:interfaces/interface', { onRead: () => void calls.push('interfaces') });
    await srv.provide('/providers-test:system/clock', { onRead: () => void calls.push('clock') });

    await send(c, get(SYSTEM));
    expect(calls).toEqual(['clock']);
    calls.length = 0;
    await send(c, getData(IFACES));
    expect(calls).toEqual(['interfaces']);
    calls.length = 0;
    await send(c, get(`<routes xmlns="${PT}"/>`));
    expect(calls).toEqual([]);
    await send(c, getData(''));
    expect(calls.sort()).toEqual(['clock', 'interfaces']);
  });

  it('runs hooks for different providers at once, and replies when all have finished', async () => {
    const { srv, c } = await providersSession();
    const a = deferred();
    const b = deferred();
    const started: string[] = [];
    await srv.provide('/providers-test:interfaces/interface', {
      onRead: async () => {
        started.push('interfaces');
        await a.promise;
      },
    });
    await srv.provide('/providers-test:system/clock', {
      onRead: async () => {
        started.push('clock');
        await b.promise;
      },
    });
    let replied = false;
    const reply = send(c, get('')).then((r) => {
      replied = true;
      return r;
    });
    await settle();
    expect(started.sort()).toEqual(['clock', 'interfaces']);
    a.resolve();
    await settle();
    expect(replied).toBe(false);
    b.resolve();
    expect(rpcErrors(await reply)).toEqual([]);
  });

  it('puts what a hook returns, or pushes, into the reply', async () => {
    const { srv, c, device } = await providersSession();
    await srv.provide('/providers-test:interfaces/interface', {
      onRead: () => ({ 'providers-test:interfaces': { interface: [{ name: 'eth1', state: { 'oper-status': 'down', 'in-octets': 7 } }] } }),
    });
    await srv.provide('/providers-test:system/clock', {
      onRead: () => srv.operational.update({ 'providers-test:system': { clock: { now: '12:00' } } }),
    });
    const data = dataJson(device, await send(c, getData('')), NMDA) as unknown as ProvidersData;
    const byName = new Map(data['providers-test:interfaces'].interface.map((i) => [i.name, i]));
    // The hook's state replaced what it owned (eth0's state from the device file went), and running's configuration is still there.
    expect(byName.get('eth1')).toMatchObject({ mtu: 9000, state: { 'oper-status': 'down', 'in-octets': 7 } });
    expect(byName.get('eth0')?.state).toBeUndefined();
    expect(data['providers-test:system']).toMatchObject({ hostname: 'r1', clock: { now: '12:00' } });
  });

  it('fails the read with operation-failed and the hook’s message when a hook throws', async () => {
    const { srv, c } = await providersSession();
    await srv.provide('/providers-test:system/clock', {
      onRead: () => Promise.reject(new Error('the clock is unplugged')),
    });
    const errors = rpcErrors(await send(c, get(SYSTEM)));
    expect(errors.map((e) => e.tag)).toEqual(['operation-failed']);
    expect(errors[0]!.message).toContain('the clock is unplugged');
  });

  it('validates the state a hook supplies; invalid state fails the read and the tree keeps its value', async () => {
    const { srv, c, device } = await providersSession();
    let status = 'up';
    await srv.provide('/providers-test:interfaces/interface', {
      onRead: () => ({ 'providers-test:interfaces': { interface: [{ name: 'eth0', state: { 'oper-status': status } }] } }),
    });
    expect(rpcErrors(await send(c, get(IFACES)))).toEqual([]);
    const before = srv.operational.state;
    status = 'sideways';
    const errors = rpcErrors(await send(c, get(IFACES)));
    expect(errors.map((e) => e.tag)).toEqual(['invalid-value']);
    expect(errors[0]!.path).toContain('oper-status');
    expect(srv.operational.state).toBe(before);
    status = 'up';
    const data = dataJson(device, await send(c, get(IFACES))) as unknown as ProvidersData;
    expect(data['providers-test:interfaces'].interface[0]!.state).toEqual({ 'oper-status': 'up' });
  });
});
