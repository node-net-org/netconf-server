import { describe, expect, it } from 'vitest';
import { YangDataError, type JsonValue } from '@node-net/yang/core';
import type { StateChangedEvent } from '../src/core.js';
import { dataJson } from './reads-helpers.js';
import { send } from './writes-helpers.js';
import { get, PT, providersSession, type ProvidersData } from './providers-helpers.js';

const IFACES = `<interfaces xmlns="${PT}"/>`;
const eth0State = (state: Record<string, JsonValue>): Record<string, JsonValue> => ({ 'providers-test:interfaces': { interface: [{ name: 'eth0', state }] } });

describe('PROVIDER-04 push state updates from the backend', () => {
  it('applies an edit of the state at any time, and the next read returns it', async () => {
    const { srv, c, device } = await providersSession();
    srv.operational.update(eth0State({ 'oper-status': 'down' }));
    let data = dataJson(device, await send(c, get(IFACES))) as unknown as ProvidersData;
    expect(data['providers-test:interfaces'].interface[0]!.state).toEqual({ 'oper-status': 'down', 'in-octets': 100 });
    // A delete, as a NETCONF edit annotation in RFC 7951 JSON.
    srv.operational.update(eth0State({ 'in-octets': null, '@in-octets': { 'ietf-netconf:operation': 'delete' } }));
    data = dataJson(device, await send(c, get(IFACES))) as unknown as ProvidersData;
    expect(data['providers-test:interfaces'].interface[0]!.state).toEqual({ 'oper-status': 'down' });
  });

  it('rejects an update that breaks the schema with its violations, leaving the state unchanged', async () => {
    const { srv } = await providersSession();
    const before = srv.operational.state;
    let error: unknown;
    try {
      srv.operational.update(eth0State({ 'in-octets': -1 }));
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(YangDataError);
    expect((error as YangDataError).issues.map((i) => i.path)).toEqual(["/providers-test:interfaces/interface[name='eth0']/state/in-octets"]);
    expect(srv.operational.state).toBe(before);
  });

  it('refuses to change configuration through a state update', async () => {
    const { srv } = await providersSession();
    const before = srv.operational.state;
    expect(() => srv.operational.update({ 'providers-test:interfaces': { interface: [{ name: 'eth0', mtu: 1400 }] } })).toThrow(/configuration/);
    expect(() => srv.operational.update({ 'providers-test:system': { hostname: 'sneaky' } })).toThrow(/applyExternal/);
    expect(srv.operational.state).toBe(before);
  });

  it('emits stateChanged with the changed paths after each update', async () => {
    const { srv } = await providersSession();
    const events: StateChangedEvent[] = [];
    srv.on('stateChanged', (e) => events.push(e));
    srv.operational.update(eth0State({ 'oper-status': 'down', 'in-octets': 200 }));
    expect(events).toEqual([
      { paths: ["/providers-test:interfaces/interface[name='eth0']/state/oper-status", "/providers-test:interfaces/interface[name='eth0']/state/in-octets"] },
    ]);
  });
});
