// NOTIF-04: send notifications from a provider or embedding code (server.notify).

import { YangDataError } from '@node-net/yang/core';
import { describe, expect, it } from 'vitest';
import { content, createSubscription, kind, notifySession } from './notify-helpers.js';
import { isOk, settle } from './writes-helpers.js';

describe('NOTIF-04 send notifications from a provider', () => {
  it('AC1: sends a notification by its schema path with its content, to every matching subscription', async () => {
    const { srv, c, open, device } = await notifySession();
    const other = await open();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    expect(isOk(await other.call(createSubscription()))).toBe(true);
    srv.notify('/notif-test:alarm', { severity: 'minor', text: 'disk' });
    for (const s of [c, other]) {
      const got = await s.waitNotifications(1);
      expect(content(device, got.at(-1)!)).toEqual({ 'notif-test:alarm': { severity: 'minor', text: 'disk' } });
    }
  });

  it('AC2: invalid content is rejected with the violations and not sent', async () => {
    const { srv, c } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    const err = (() => {
      try {
        srv.notify('/notif-test:alarm', { severity: 'apocalyptic' });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(YangDataError);
    expect((err as YangDataError).issues.map((i) => i.path)).toEqual(['/notif-test:alarm/severity']);
    expect(() => srv.notify('/notif-test:alarm', { text: 'no severity' })).toThrow(YangDataError);
    expect(() => srv.notify('/notif-test:nope', {})).toThrow(YangDataError);
    await settle();
    expect(c.notifications()).toEqual([]);
  });

  it('AC3: a notification nested in a data node is sent with the path of its instance, which must exist', async () => {
    const { srv, c, device } = await notifySession();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    srv.notify("/notif-test:servers/server[name='a']/restarted", { reason: 'upgrade' });
    const [n] = await c.waitNotifications(1);
    expect(content(device, n!)).toEqual({ 'notif-test:servers': { server: [{ name: 'a', restarted: { reason: 'upgrade' } }] } });

    let err: unknown;
    try {
      srv.notify("/notif-test:servers/server[name='zz']/restarted", { reason: 'none' });
    } catch (e) {
      err = e;
    }
    expect((err as YangDataError).issues.map((i) => i.code)).toContain('missing-parent');
  });

  it('AC4: notifications from one caller reach each subscriber in the order they were sent', async () => {
    const { srv, c, open } = await notifySession();
    const other = await open();
    expect(isOk(await c.call(createSubscription()))).toBe(true);
    expect(isOk(await other.call(createSubscription()))).toBe(true);
    for (let seq = 1; seq <= 20; seq++) srv.notify('/notif-test:heartbeat', { seq });
    for (const s of [c, other]) {
      const got = (await s.waitNotifications(20)).filter((n) => kind(n) === 'heartbeat');
      expect(got.map((n) => Number(n.elements[1]!.elements[0]!.text()))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    }
  });

  it('throws a TypeError on a device without :notification', async () => {
    const { notificationsVariant } = await import('./notify-helpers.js');
    const device = await notificationsVariant((d) => ({ ...d, capabilities: { ...d.capabilities, notification: false, interleave: false } }));
    const { srv } = await notifySession({ device });
    expect(() => srv.notify('/notif-test:alarm', { severity: 'minor' })).toThrow(TypeError);
  });
});
