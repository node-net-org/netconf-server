// SCHEMA-03: inspect sessions, datastores, schemas and statistics (RFC 6022). Notification counts arrive with notifications (M4).
import { connectionPair, NETCONF_NS } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/index.js';
import { createSubscription, notifySession } from './notify-helpers.js';
import { BASE_1_0, chunked, eom, hello, RawClient, rawOpen } from './helpers.js';
import { dataJson, readsDevice, readsSession, send } from './reads-helpers.js';
import { isOk } from './writes-helpers.js';

const STATE = (part: string): string => `<get><filter><netconf-state xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"><${part}/></netconf-state></filter></get>`;

type State = { 'ietf-netconf-monitoring:netconf-state': Record<string, Record<string, unknown>> };

describe('SCHEMA-03 NETCONF monitoring', () => {
  it('AC1: capabilities lists exactly the capabilities in the hello', async () => {
    const { c, device } = await readsSession();
    const state = dataJson(device, await send(c, STATE('capabilities'))) as State;
    const hello = c.messages[0]!.child('capabilities', NETCONF_NS)!.childrenNamed('capability', NETCONF_NS).map((e) => e.text());
    expect(state['ietf-netconf-monitoring:netconf-state']['capabilities']!['capability']).toEqual(hello);
  });

  it('AC2: datastores lists each configuration datastore with its current lock holder and lock time', async () => {
    const clock = { now: () => Date.UTC(2026, 10, 13, 9, 30, 0), setTimeout: () => 0, clearTimeout: () => undefined };
    const srv = await createServer({ device: await readsDevice(), clock, control: { enabled: false } });
    const c = await rawOpen(srv);
    const device = await readsDevice();
    const datastores = async (): Promise<unknown> =>
      (dataJson(device, await send(c, STATE('datastores'))) as State)['ietf-netconf-monitoring:netconf-state']['datastores']!['datastore'];
    expect(await datastores()).toEqual([{ name: 'running' }, { name: 'candidate' }, { name: 'startup' }]);
    await send(c, '<lock><target><candidate/></target></lock>');
    const id = Number(c.messages[0]!.child('session-id', NETCONF_NS)!.text());
    expect(await datastores()).toEqual([
      { name: 'running' },
      { name: 'candidate', locks: { 'global-lock': { 'locked-by-session': id, 'locked-time': '2026-11-13T09:30:00Z' } } },
      { name: 'startup' },
    ]);
    await send(c, '<unlock><target><candidate/></target></unlock>');
    expect(await datastores()).toEqual([{ name: 'running' }, { name: 'candidate' }, { name: 'startup' }]);
  });

  it('AC3: schemas lists every module and submodule with location NETCONF', async () => {
    const { c, device } = await readsSession();
    const state = dataJson(device, await send(c, STATE('schemas'))) as State;
    const schemas = state['ietf-netconf-monitoring:netconf-state']['schemas']!['schema'] as { identifier: string; version: string; format: string; location: string[] }[];
    const yang = schemas.filter((s) => s.format === 'ietf-netconf-monitoring:yang');
    expect(yang.map((s) => `${s.identifier}@${s.version}`).sort()).toEqual(device.schema.allModules.map((m) => `${m.name}@${m.revision ?? ''}`).sort());
    expect(schemas.filter((s) => s.format === 'ietf-netconf-monitoring:yin')).toHaveLength(yang.length);
    expect(schemas.every((s) => s.location.length === 1 && s.location[0] === 'NETCONF')).toBe(true);
  });

  it('AC4: sessions lists each open session with its id, transport, username, source host and login time', async () => {
    const device = await readsDevice();
    let now = Date.UTC(2026, 10, 13, 8, 0, 0);
    const clock = { now: () => now, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as never) };
    const srv = await createServer({ device, clock, control: { enabled: false } });
    const a = await rawOpen(srv);
    now += 60_000;
    const [client, serverEnd] = connectionPair();
    srv.serve(serverEnd, { principal: { username: 'operator' }, transport: 'ssh', sourceHost: '192.0.2.7' });
    const b = new RawClient(client);
    await b.waitFor(1);
    b.send(eom(hello([BASE_1_0])));
    await b.until(() => srv.sessions.length === 2, 2000, 'two sessions');
    const state = dataJson(device, await send(a, STATE('sessions'))) as State;
    expect(state['ietf-netconf-monitoring:netconf-state']['sessions']!['session']).toEqual([
      { 'session-id': 1, transport: 'net-netconf-server-monitoring:in-process', username: 'tester', 'login-time': '2026-11-13T08:00:00Z', 'in-rpcs': 1, 'in-bad-rpcs': 0, 'out-rpc-errors': 0, 'out-notifications': 0, 'net-netconf-server-monitoring:recovery': false },
      { 'session-id': 2, transport: 'ietf-netconf-monitoring:netconf-ssh', username: 'operator', 'source-host': '192.0.2.7', 'login-time': '2026-11-13T08:01:00Z', 'in-rpcs': 0, 'in-bad-rpcs': 0, 'out-rpc-errors': 0, 'out-notifications': 0, 'net-netconf-server-monitoring:recovery': false },
    ]);
  });

  it('AC5: statistics count sessions, bad hellos, rpcs and rpc-errors, and change as traffic happens', async () => {
    const device = await readsDevice();
    const srv = await createServer({ device, control: { enabled: false } });
    const stats = async (c: Awaited<ReturnType<typeof rawOpen>>): Promise<Record<string, unknown>> =>
      (dataJson(device, await send(c, STATE('statistics'))) as State)['ietf-netconf-monitoring:netconf-state']['statistics']!;
    const a = await rawOpen(srv);
    const first = await stats(a);
    expect(first).toMatchObject({ 'in-bad-hellos': 0, 'in-sessions': 1, 'dropped-sessions': 0, 'in-rpcs': 1, 'in-bad-rpcs': 0, 'out-rpc-errors': 0, 'out-notifications': 0 });
    expect(first['netconf-start-time']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    // A bad hello, a dropped session, a bad rpc and an rpc-error.
    const [client, serverEnd] = connectionPair();
    srv.serve(serverEnd, { principal: { username: 'x' }, transport: 'test' });
    const bad = new RawClient(client);
    await bad.waitFor(1);
    bad.send(eom('<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities/></hello>'));
    await bad.waitClosed();
    const b = await rawOpen(srv);
    b.connection.destroy();
    await b.until(() => srv.sessions.length === 1, 2000, 'the dropped session to go');
    a.send(chunked('<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><get/></rpc>'));
    await a.waitFor(a.messages.length + 1);
    await send(a, '<get-config><source><nowhere/></source></get-config>');

    expect(await stats(a)).toMatchObject({ 'in-bad-hellos': 1, 'in-sessions': 2, 'dropped-sessions': 1, 'in-rpcs': 3, 'in-bad-rpcs': 1, 'out-rpc-errors': 2 });
    const mine = (dataJson(device, await send(a, STATE('sessions'))) as State)['ietf-netconf-monitoring:netconf-state']['sessions']!['session'] as Record<string, unknown>[];
    expect(mine).toEqual([expect.objectContaining({ 'session-id': 1, 'in-rpcs': 4, 'in-bad-rpcs': 1, 'out-rpc-errors': 2 })]);
  });

  it('AC5: out-notifications counts the notifications sent, per session and in total', async () => {
    const { srv, c, open } = await notifySession();
    const other = await open();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    expect(isOk(await other.call(createSubscription()))).toBe(true);
    srv.notify('/notif-test:heartbeat', { seq: 1 });
    srv.notify('/notif-test:heartbeat', { seq: 2 });
    await c.waitNotifications(2);
    await other.waitNotifications(2);
    const counters = await c.call(`<get><filter type="subtree"><netconf-state xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"><sessions/><statistics/></netconf-state></filter></get>`);
    const state = dataJson(srv.device, counters) as State;
    const sessions = state['ietf-netconf-monitoring:netconf-state']['sessions']!['session'] as Record<string, unknown>[];
    expect(sessions.map((s) => s['out-notifications'])).toEqual([2, 2]);
    expect(state['ietf-netconf-monitoring:netconf-state']['statistics']!['out-notifications']).toBe(4);
  });
});
