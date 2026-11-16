import { describe, expect, it } from 'vitest';
import { YangDataError } from '@node-net/yang/core';
import type { CommitEvent } from '../src/core.js';
import { dataJson } from './reads-helpers.js';
import { config, editConfig, heldStore, isOk, send, settle } from './writes-helpers.js';
import { getData, iface, NMDA, PT, providersSession, providersVariant, recorder, type Call, type ProvidersData } from './providers-helpers.js';
import { client, content, createSubscription } from './notify-helpers.js';

const IF = '/providers-test:interfaces/interface';

describe('PROVIDER-08 report configuration changed outside NETCONF', () => {
  it('applies an outside change with a named source, validated and whole', async () => {
    const { srv, c, device } = await providersSession();
    const changes = await srv.running.applyExternal(
      { 'providers-test:interfaces': { interface: [{ name: 'eth2', mtu: 1500 }] }, 'providers-test:system': { contact: 'hand-edited' } },
      { source: 'ifupdown' },
    );
    expect(changes.map((ch) => [ch.operation, ch.path])).toEqual([
      ['create', "/providers-test:interfaces/interface[name='eth2']"],
      ['create', '/providers-test:system/contact'],
    ]);
    expect(await config(c, device)).toMatchObject({ 'providers-test:system': { hostname: 'r1', contact: 'hand-edited' } });
    await expect(srv.running.applyExternal({ 'providers-test:system': { contact: 'x' } }, { source: '' })).rejects.toThrow(/source/);
  });

  it('rejects an outside change that breaks the schema with every violation, leaving running unchanged', async () => {
    const { srv, c, device } = await providersSession();
    const before = await config(c, device);
    const edit = {
      'providers-test:routes': { route: [{ prefix: '0/0', via: 'eth9' }, { prefix: '1/1', via: 'eth8' }] },
    };
    const err = await srv.running.applyExternal(edit, { source: 'ifupdown' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YangDataError);
    expect((err as YangDataError).issues.filter((i) => i.severity === 'error').map((i) => i.path)).toEqual([
      "/providers-test:routes/route[prefix='0/0']/via",
      "/providers-test:routes/route[prefix='1/1']/via",
    ]);
    expect(await config(c, device)).toEqual(before);
  });

  it('updates running and the configuration in operational, and reports the commit with the source', async () => {
    const { srv, c, device } = await providersSession();
    const events: CommitEvent[] = [];
    srv.on('commit', (e) => events.push(e));
    await srv.running.applyExternal({ 'providers-test:system': { hostname: 'renamed' } }, { source: 'hostnamectl' });
    const data = dataJson(device, await send(c, getData(`<system xmlns="${PT}"/>`)), NMDA) as unknown as ProvidersData;
    expect(data['providers-test:system']).toEqual({ hostname: 'renamed' });
    expect(events.map((e) => [e.cause, e.source, e.sessionId, e.changes.map((ch) => ch.path)])).toEqual([['external', 'hostnamectl', undefined, ['/providers-test:system/hostname']]]);

    // Subscribers get netconf-config-change attributed to the server, not a session (RFC 6470 changed-by).
    const notifying = await providersVariant((d) => ({ ...d, capabilities: { ...d.capabilities, notification: true, interleave: true } }));
    const n = await providersSession({ device: notifying });
    const sub = client(n.c);
    expect(isOk(await sub.call(createSubscription()))).toBe(true);
    await n.srv.running.applyExternal({ 'providers-test:system': { hostname: 'again' } }, { source: 'hostnamectl' });
    const [change] = await sub.waitNotifications(1);
    expect(content(n.srv.device, change!)).toMatchObject({
      'ietf-netconf-notifications:netconf-config-change': {
        'changed-by': { server: [null] },
        datastore: 'running',
        edit: [{ target: '/providers-test:system/hostname' }],
      },
    });
  });

  it('calls no provider’s prepare or commit', async () => {
    const { srv } = await providersSession();
    const log: Call[] = [];
    await srv.provide(IF, recorder('interfaces', log));
    log.length = 0;
    await srv.running.applyExternal({ 'providers-test:interfaces': { interface: [{ name: 'eth0', mtu: 1280 }] } }, { source: 'ip-link' });
    expect(log).toEqual([]);
  });

  it('is applied whatever the locks, after any write in progress', async () => {
    const store = heldStore();
    const { srv, c, device } = await providersSession({ store });
    expect(isOk(await send(c, '<lock><target><running/></target></lock>'))).toBe(true);
    // A write by the lock holder, held part-way at its save.
    const write = send(c, editConfig('running', `<system xmlns="${PT}"><contact>first</contact></system>`));
    await settle();
    expect(store.waiting).toBe(1);
    let applied = false;
    const outside = srv.running.applyExternal({ 'providers-test:system': { contact: 'second' } }, { source: 'outside' }).then(() => (applied = true));
    await settle();
    expect(applied).toBe(false);
    store.release();
    expect(isOk(await write)).toBe(true);
    await settle();
    store.release();
    await outside;
    expect(await config(c, device)).toMatchObject({ 'providers-test:system': { contact: 'second' } });
  });

  it('commits a candidate edited before the outside change against the new running', async () => {
    const { srv, c, device } = await providersSession();
    expect(isOk(await send(c, editConfig('candidate', iface('eth1', '<mtu>1600</mtu>'))))).toBe(true);
    await srv.running.applyExternal({ 'providers-test:system': { contact: 'outside' } }, { source: 'outside' });
    expect(isOk(await send(c, '<commit/>'))).toBe(true);
    expect(await config(c, device)).toMatchObject({
      'providers-test:system': { contact: 'outside' },
      'providers-test:interfaces': { interface: [{ name: 'eth0' }, { name: 'eth1', mtu: 1600 }] },
    });
  });
});
