// NOTIF-01: subscribe to notifications with create-subscription (RFC 5277).

import { describe, expect, it } from 'vitest';
import { content, createSubscription, eventTime, kind, NC, notifySession, NOTIF } from './notify-helpers.js';
import { errorTags, isOk, settle } from './writes-helpers.js';

const STREAMS = `<get><filter type="subtree"><netconf xmlns="urn:ietf:params:xml:ns:netmod:notification"><streams/></netconf></filter></get>`;

describe('NOTIF-01 subscribe to notifications with create-subscription', () => {
  it('AC1: advertises :notification:1.0 and the NETCONF stream in netconf/streams', async () => {
    const { c } = await notifySession();
    const caps = c.raw.messages[0]!.child('capabilities', NC)!.childrenNamed('capability', NC).map((e) => e.text());
    expect(caps).toContain('urn:ietf:params:netconf:capability:notification:1.0');
    const reply = await c.call(STREAMS);
    const stream = reply.child('data', NC)!.elements[0]!.elements[0]!.elements[0]!;
    expect(stream.elements.map((e) => [e.name, e.text()])).toEqual([
      ['name', 'NETCONF'],
      ['description', 'Default NETCONF event stream'],
      ['replaySupport', 'false'],
    ]);
  });

  it('AC2: answers ok and then delivers each notification as it happens, with an eventTime from the server clock', async () => {
    const { srv, c, clock, device } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    expect(c.notifications()).toEqual([]);
    srv.notify('/notif-test:alarm', { severity: 'major', text: 'fan' });
    clock.advance(1500);
    srv.notify('/notif-test:heartbeat', { seq: 1 });
    const [first, second] = await c.waitNotifications(2);
    expect(eventTime(first!)).toBe(new Date(Date.UTC(2026, 10, 13, 12, 0, 0)).toISOString());
    expect(eventTime(second!)).toBe(new Date(Date.UTC(2026, 10, 13, 12, 0, 1, 500)).toISOString());
    expect(content(device, first!)).toEqual({ 'notif-test:alarm': { severity: 'major', text: 'fan' } });
    expect(kind(second!)).toBe('heartbeat');
  });

  it('AC3: a subtree or XPath filter delivers only matching notifications', async () => {
    const { srv, c, open } = await notifySession();
    const subtree = `<filter type="subtree"><alarm xmlns="urn:example:notif"><severity>critical</severity></alarm></filter>`;
    expect(isOk(await c.call(createSubscription(subtree)))).toBe(true);
    const x = await open();
    const xpath = `<filter type="xpath" xmlns:nt="urn:example:notif" select="/nt:heartbeat"/>`;
    expect(isOk(await x.call(createSubscription(xpath)))).toBe(true);

    srv.notify('/notif-test:alarm', { severity: 'minor' });
    srv.notify('/notif-test:heartbeat', { seq: 7 });
    srv.notify('/notif-test:alarm', { severity: 'critical' });
    await c.waitNotifications(1);
    await x.waitNotifications(1);
    await settle();
    expect(c.notifications().map((n) => n.elements[1]!.child('severity', 'urn:example:notif')?.text())).toEqual(['critical']);
    expect(x.notifications().map(kind)).toEqual(['heartbeat']);
  });

  it('AC4: a stopTime without startTime gets missing-element, as RFC 5277 allows it only with replay', async () => {
    const { c } = await notifySession();
    const reply = await c.call(createSubscription('<stopTime>2030-01-01T00:00:00Z</stopTime>'));
    expect(errorTags(reply)).toEqual(['missing-element']);
    expect(reply.child('rpc-error', NC)!.child('error-info', NC)!.child('bad-element', NC)!.text()).toBe('startTime');
    // The session has no subscription, so it may subscribe now.
    expect(isOk(await c.call(createSubscription()))).toBe(true);
  });

  it('AC5: startTime gets operation-not-supported, since replay is not implemented', async () => {
    const { c } = await notifySession();
    const reply = await c.call(createSubscription('<startTime>2026-01-01T00:00:00Z</startTime>'));
    expect(errorTags(reply)).toEqual(['operation-not-supported']);
  });

  it('AC6: a second create-subscription on a subscribed session gets in-use', async () => {
    const { c } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    expect(errorTags(await c.call(createSubscription()))).toEqual(['in-use']);
    expect(errorTags(await c.call(`<create-subscription xmlns="${NOTIF}"><stream>OTHER</stream></create-subscription>`))).toEqual(['in-use']);
  });
});
