// CONTROL-05: send a notification on demand.

import { describe, expect, it } from 'vitest';
import { content, createSubscription, CTL, eventTime, notifySession } from './notify-helpers.js';
import { errorTags, isOk, settle } from './writes-helpers.js';

const send = (path: string, json: string, extra = ''): string =>
  `<send-notification xmlns="${CTL}"><path>${path}</path><content>${json}</content>${extra}</send-notification>`;

describe('CONTROL-05 send a notification on demand', () => {
  it('AC1: sends a notification of the device schema with its content to every matching subscription', async () => {
    const { c, open, device } = await notifySession();
    const sub = await open('listener');
    expect(isOk(await sub.call(createSubscription()))).toBe(true);
    expect(isOk(await c.call(send('/notif-test:alarm', '{"severity":"critical","text":"overheat"}')))).toBe(true);
    const [n] = await sub.waitNotifications(1);
    expect(content(device, n!)).toEqual({ 'notif-test:alarm': { severity: 'critical', text: 'overheat' } });
  });

  it('AC2: content is validated as for provider notifications; invalid content gets the violations', async () => {
    const { c, open } = await notifySession();
    const sub = await open('listener');
    expect(isOk(await sub.call(createSubscription()))).toBe(true);
    const reply = await c.call(send('/notif-test:alarm', '{"severity":"none"}'));
    expect(errorTags(reply)).toEqual(['invalid-value']);
    expect(reply.child('rpc-error', 'urn:ietf:params:xml:ns:netconf:base:1.0')!.child('error-path', 'urn:ietf:params:xml:ns:netconf:base:1.0')!.text()).toContain('severity');
    expect(errorTags(await c.call(send("/notif-test:servers/server[name='nope']/restarted", '{"reason":"x"}')))).not.toEqual([]);
    await settle();
    expect(sub.notifications()).toEqual([]);
  });

  it('AC3: an eventTime can be given, otherwise the server clock is used', async () => {
    const { c, open } = await notifySession();
    const sub = await open('listener');
    expect(isOk(await sub.call(createSubscription()))).toBe(true);
    expect(isOk(await c.call(send('/notif-test:heartbeat', '{"seq":1}', '<event-time>2020-02-02T02:02:02Z</event-time>')))).toBe(true);
    expect(isOk(await c.call(send('/notif-test:heartbeat', '{"seq":2}')))).toBe(true);
    const got = await sub.waitNotifications(2);
    expect(got.map(eventTime)).toEqual(['2020-02-02T02:02:02.000Z', '2026-11-13T12:00:00.000Z']);
  });
});
