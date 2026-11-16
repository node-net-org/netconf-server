// NOTIF-03: base notifications (RFC 6470) for configuration changes, sessions and confirmed commits.

import { describe, expect, it } from 'vitest';
import { connectionPair, type XmlElement } from '@node-net/netconf/core';
import { BASE_1_0, eom, hello, RawClient } from './helpers.js';
import { content, createSubscription, kind, notifySession } from './notify-helpers.js';
import { isOk } from './writes-helpers.js';

const EDIT_B = '<edit-config><target><running/></target><config><servers xmlns="urn:example:notif"><server><name>b</name><description>new</description></server></servers></config></edit-config>';
const CANDIDATE_B = EDIT_B.replace('<running/>', '<candidate/>');

describe('NOTIF-03 receive base notifications', () => {
  it('AC1: every change to running sends netconf-config-change with changed-by, the datastore and an edit per change', async () => {
    const { c, open, device } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    const w = await open('writer');
    expect(isOk(await w.call(EDIT_B))).toBe(true);
    await c.waitNotifications(2);
    const changes = (): XmlElement[] => c.notifications().filter((n) => kind(n) === 'netconf-config-change');
    let all = changes();
    const [change] = all;
    expect(content(device, change!)).toEqual({
      'ietf-netconf-notifications:netconf-config-change': {
        'changed-by': { username: 'writer', 'session-id': 2 },
        datastore: 'running',
        edit: [{ target: "/notif-test:servers/server[name='b']", operation: 'create' }],
      },
    });

    // A commit of the candidate is a change to running by the committing session.
    expect(isOk(await w.call(CANDIDATE_B.replace('new', 'newer')))).toBe(true);
    expect(isOk(await w.call('<commit/>'))).toBe(true);
    await c.raw.until(() => changes().length >= 2, 2000, 'two config changes');
    all = changes();
    expect(content(device, all[1]!)).toMatchObject({
      'ietf-netconf-notifications:netconf-config-change': {
        'changed-by': { username: 'writer' },
        edit: [{ target: "/notif-test:servers/server[name='b']/description", operation: 'replace' }],
      },
    });
  });

  it('AC1: a change from outside NETCONF is attributed to the server', async () => {
    const { srv, c, device } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    await srv.running.applyExternal({ 'notif-test:servers': { server: [{ name: 'c' }] } }, { source: 'backend' });
    const [change] = await c.waitNotifications(1);
    expect(content(device, change!)).toEqual({
      'ietf-netconf-notifications:netconf-config-change': {
        'changed-by': { server: [null] },
        datastore: 'running',
        edit: [{ target: "/notif-test:servers/server[name='c']", operation: 'create' }],
      },
    });
  });

  it('AC2: netconf-session-start and netconf-session-end carry the session id, user, source host and end reason', async () => {
    const { srv, c, open, device } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    const other = await open('alice');
    const third = await open('bob');
    expect(isOk(await other.call('<close-session/>'))).toBe(true);
    expect(isOk(await c.call('<kill-session><session-id>3</session-id></kill-session>'))).toBe(true);
    const got = await c.waitNotifications(4);
    expect(got.map((n) => content(device, n))).toEqual([
      { 'ietf-netconf-notifications:netconf-session-start': { username: 'alice', 'session-id': 2 } },
      { 'ietf-netconf-notifications:netconf-session-start': { username: 'bob', 'session-id': 3 } },
      { 'ietf-netconf-notifications:netconf-session-end': { username: 'alice', 'session-id': 2, 'termination-reason': 'closed' } },
      { 'ietf-netconf-notifications:netconf-session-end': { username: 'bob', 'session-id': 3, 'killed-by': 1, 'termination-reason': 'killed' } },
    ]);
    void third;

    // A transport that knows the client's address reports it as source-host.
    const [clientEnd, serverEnd] = connectionPair();
    srv.serve(serverEnd, { principal: { username: 'carol' }, transport: 'ssh', sourceHost: '192.0.2.7' });
    const carol = new RawClient(clientEnd);
    await carol.waitFor(1);
    carol.send(eom(hello([BASE_1_0])));
    const [, , , , start] = await c.waitNotifications(5);
    expect(content(device, start!)).toEqual({ 'ietf-netconf-notifications:netconf-session-start': { username: 'carol', 'session-id': 4, 'source-host': '192.0.2.7' } });
  });

  it('AC3: netconf-confirmed-commit is sent for start, extend, complete, cancel and timeout', async () => {
    const { c, open, clock, device } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    const w = await open('writer');
    const confirmed = (): unknown[] =>
      c.notifications().filter((n) => kind(n) === 'netconf-confirmed-commit').map((n) => (content(device, n) as Record<string, unknown>)['ietf-netconf-notifications:netconf-confirmed-commit']);

    expect(isOk(await w.call(CANDIDATE_B))).toBe(true);
    expect(isOk(await w.call('<commit><confirmed/><confirm-timeout>60</confirm-timeout></commit>'))).toBe(true);
    expect(isOk(await w.call('<commit><confirmed/><confirm-timeout>90</confirm-timeout></commit>'))).toBe(true);
    expect(isOk(await w.call('<commit/>'))).toBe(true);
    expect(isOk(await w.call(CANDIDATE_B.replace('<name>b</name>', '<name>d</name>')))).toBe(true);
    expect(isOk(await w.call('<commit><confirmed/></commit>'))).toBe(true);
    expect(isOk(await w.call('<cancel-commit/>'))).toBe(true);
    expect(isOk(await w.call(CANDIDATE_B.replace('<name>b</name>', '<name>e</name>')))).toBe(true);
    expect(isOk(await w.call('<commit><confirmed/><confirm-timeout>5</confirm-timeout></commit>'))).toBe(true);
    clock.advance(5000);
    await c.raw.until(() => c.notifications().filter((n) => kind(n) === 'netconf-confirmed-commit').length >= 7, 2000, 'seven confirmed-commit notifications');

    const session = { username: 'writer', 'session-id': 2 };
    expect(confirmed()).toEqual([
      { ...session, 'confirm-event': 'start', timeout: 60 },
      { ...session, 'confirm-event': 'extend', timeout: 90 },
      { ...session, 'confirm-event': 'complete' },
      { ...session, 'confirm-event': 'start', timeout: 600 },
      { ...session, 'confirm-event': 'cancel' },
      { ...session, 'confirm-event': 'start', timeout: 5 },
      { 'confirm-event': 'timeout' },
    ]);
  });
});
