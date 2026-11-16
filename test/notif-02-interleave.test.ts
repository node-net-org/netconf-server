// NOTIF-02: keep sending RPCs while subscribed (:interleave, RFC 5277 §6).

import { describe, expect, it } from 'vitest';
import { CTL, createSubscription, kind, NC, notificationsVariant, notifySession } from './notify-helpers.js';
import { errorTags, isOk } from './writes-helpers.js';

describe('NOTIF-02 keep sending RPCs while subscribed', () => {
  it('AC1: advertises :interleave', async () => {
    const { c } = await notifySession();
    const caps = c.raw.messages[0]!.child('capabilities', NC)!.childrenNamed('capability', NC).map((e) => e.text());
    expect(caps).toContain('urn:ietf:params:netconf:capability:interleave:1.0');
  });

  it('AC2: RPCs on a subscribed session are processed and answered normally', async () => {
    const { c } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    const reply = await c.call('<get-config><source><running/></source></get-config>');
    expect(reply.child('data', NC)!.elements.map((e) => e.name)).toEqual(['servers']);
    expect(isOk(await c.call('<edit-config><target><running/></target><config><servers xmlns="urn:example:notif"><server><name>b</name></server></servers></config></edit-config>'))).toBe(true);
  });

  it('AC3: notifications are delivered between replies, never inside one', async () => {
    const { c } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    // The notification is generated while this session's own request is being answered, so it must wait for the reply.
    const reply = await c.call(`<send-notification xmlns="${CTL}"><path>/notif-test:heartbeat</path><content>{"seq":1}</content></send-notification>`);
    expect(isOk(reply)).toBe(true);
    await c.waitNotifications(1);
    const order = c.raw.messages.slice(1).map((m) => (m.name === 'notification' ? kind(m) : `reply ${m.attr('message-id')}`));
    expect(order.slice(-2)).toEqual([`reply ${reply.attr('message-id')}`, 'heartbeat']);
    // Every message is complete XML: none was cut into by another.
    expect(c.raw.texts.every((t) => t.startsWith('<?xml'))).toBe(true);
  });

  it('AC4: with interleave off, RPCs other than close-session on a subscribed session get operation-not-supported', async () => {
    const device = await notificationsVariant((d) => ({ ...d, capabilities: { ...d.capabilities, interleave: false } }));
    const { c } = await notifySession({ device });
    const caps = c.raw.messages[0]!.child('capabilities', NC)!.childrenNamed('capability', NC).map((e) => e.text());
    expect(caps).not.toContain('urn:ietf:params:netconf:capability:interleave:1.0');
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    expect(errorTags(await c.call('<get-config><source><running/></source></get-config>'))).toEqual(['operation-not-supported']);
    expect(isOk(await c.call('<close-session/>'))).toBe(true);
    await c.raw.waitClosed();
  });
});
