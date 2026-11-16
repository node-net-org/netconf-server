// CONTROL-07: snapshot and restore datastores.

import { encodeJson } from '@node-net/yang/core';
import { describe, expect, it } from 'vitest';
import { content, createSubscription, CTL, kind, notifySession } from './notify-helpers.js';
import { config, errorTags, isOk } from './writes-helpers.js';

const EDIT = (name: string): string => `<edit-config><target><running/></target><config><servers xmlns="urn:example:notif"><server><name>${name}</name></server></servers></config></edit-config>`;

describe('CONTROL-07 snapshot and restore datastores', () => {
  it('AC1: snapshot saves every datastore under a name, in memory', async () => {
    const { srv, c } = await notifySession();
    expect(isOk(await c.call(`<snapshot xmlns="${CTL}"><name>start</name></snapshot>`))).toBe(true);
    expect(srv.control!.snapshots()).toEqual(['start']);
  });

  it('AC2: restore puts every datastore back to the named snapshot; an unknown name gets invalid-value', async () => {
    const { srv, c, device } = await notifySession();
    expect(isOk(await c.call(EDIT('b')))).toBe(true);
    srv.control!.setState({ 'notif-test:servers': { server: [{ name: 'a', status: 'down' }] } });
    srv.control!.snapshot('prepared');
    const prepared = await config(c.raw, device);
    expect(isOk(await c.call(EDIT('c')))).toBe(true);
    srv.control!.setState({ 'notif-test:servers': { server: [{ name: 'a', status: 'up' }] } });

    expect(isOk(await c.call(`<restore xmlns="${CTL}"><name>prepared</name></restore>`))).toBe(true);
    expect(await config(c.raw, device)).toEqual(prepared);
    expect(encodeJson(srv.operational.state)).toEqual({ 'notif-test:servers': { server: [{ name: 'a', status: 'down' }] } });
    expect(errorTags(await c.call(`<restore xmlns="${CTL}"><name>missing</name></restore>`))).toEqual(['invalid-value']);
  });

  it('AC3: restoring running calls no providers, and sends netconf-config-change for the differences', async () => {
    const calls: string[] = [];
    const { srv, c, device } = await notifySession({ control: { enabled: true }, providers: [{ path: '/notif-test:servers', provider: { prepare: () => void calls.push('prepare') } }] });
    srv.control!.snapshot('empty');
    calls.length = 0;
    expect(isOk(await c.call(EDIT('b')))).toBe(true);
    expect(calls).toEqual(['prepare']);
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    await srv.control!.restore('empty');
    expect(calls).toEqual(['prepare']);
    const [change] = await c.waitNotifications(1);
    expect(kind(change!)).toBe('netconf-config-change');
    expect(content(device, change!)).toEqual({
      'ietf-netconf-notifications:netconf-config-change': {
        'changed-by': { server: [null] },
        datastore: 'running',
        edit: [{ target: "/notif-test:servers/server[name='b']", operation: 'delete' }],
      },
    });
  });
});
