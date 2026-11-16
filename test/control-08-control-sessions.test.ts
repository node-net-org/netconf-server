// CONTROL-08: control a server whose quirks break the protocol.

import { describe, expect, it } from 'vitest';
import { byteSession, CTL, notificationsVariant, notifySession, waitFor } from './notify-helpers.js';
import { config, errorTags, isOk } from './writes-helpers.js';

const GET = '<get-config><source><running/></source></get-config>';

describe('CONTROL-08 control a server whose quirks break the protocol', () => {
  it("AC1: sessions of the deployment's control users are exempt from every quirk and fault", async () => {
    const device = await notificationsVariant((d) => ({ ...d, quirks: { replyWithoutMessageId: { replies: 'all' }, invalidXmlChars: true } }));
    const { srv, open } = await notifySession({ device, control: { users: ['admin'] } });
    const admin = await open('admin');
    srv.control!.injectFault({ target: { kind: 'user', username: 'admin' }, action: { kind: 'drop' } });
    // Every reply carries its message-id (call() waits for it), and errors are plain XML.
    expect(errorTags(await admin.call('<get-config><source><nowhere/></source></get-config>'))).toEqual(['invalid-value']);
    expect(errorTags(await admin.call(GET))).toEqual([]);
    expect(admin.raw.closed).toBe(false);
  });

  it('AC2: a control session can connect, reset and clear faults while other sessions get broken framing', async () => {
    const device = await notificationsVariant((d) => ({ ...d, quirks: { chunkedFramingBroken: true } }));
    const { srv, open } = await notifySession({ device, control: { users: ['admin'] } });
    // A tester's base:1.1 session gets broken chunk headers: a space after the chunk size.
    const tester = await byteSession(srv);
    tester.send(GET);
    await waitFor(() => / \n<\?xml/.test(tester.text()));
    expect(tester.text()).toMatch(/\n#\d+ \n<\?xml/);

    const admin = await open('admin');
    srv.control!.injectFault({ target: { kind: 'user', username: 'tester' }, action: { kind: 'drop' } });
    expect(isOk(await admin.call(`<reset xmlns="${CTL}"/>`))).toBe(true);
    expect(srv.control!.faults()).toEqual([]);
    expect(errorTags(await admin.call(`<clear-faults xmlns="${CTL}"/>`))).toEqual([]);
  });

  it('AC3: control sessions see the same datastores as every other session', async () => {
    const { c, open, device } = await notifySession({ control: { users: ['admin'] } });
    const admin = await open('admin');
    expect(isOk(await c.call('<edit-config><target><running/></target><config><servers xmlns="urn:example:notif"><server><name>z</name></server></servers></config></edit-config>'))).toBe(true);
    expect(await config(admin.raw, device)).toEqual(await config(c.raw, device));
  });
});
