// CONTROL-04: switch quirks on and off at run time.

import { describe, expect, it } from 'vitest';
import { byteSession, CTL, notifySession, waitFor } from './notify-helpers.js';
import { errorTags, isOk } from './writes-helpers.js';

const BAD = '<get-config><source><nowhere/></source></get-config>';
const setQuirk = (body: string): string => `<set-quirk xmlns="${CTL}">${body}</set-quirk>`;

describe('CONTROL-04 switch quirks on and off at run time', () => {
  it('AC1: set-quirk turns a quirk on with its settings, or off, for new sessions or a given session', async () => {
    const { c, open } = await notifySession({ control: { users: ['admin'] } });
    const admin = await open('admin');
    // For one session: its next error reply has no message-id.
    expect(isOk(await admin.call(setQuirk('<name>replyWithoutMessageId</name><session-id>1</session-id>')))).toBe(true);
    c.post(BAD);
    await c.raw.until(() => c.raw.messages.at(-1)?.name === 'rpc-reply', 2000, 'the reply');
    expect(c.raw.messages.at(-1)!.attr('message-id')).toBeUndefined();
    // Off again.
    expect(isOk(await admin.call(setQuirk('<name>replyWithoutMessageId</name><off/><session-id>1</session-id>')))).toBe(true);
    expect(errorTags(await c.call(BAD))).toEqual(['invalid-value']);

    // For new sessions, with settings: existing ones keep what they opened with.
    expect(isOk(await admin.call(setQuirk(`<name>replyWithoutMessageId</name><settings>{"replies":"all"}</settings>`)))).toBe(true);
    expect(isOk(await c.call('<discard-changes/>'))).toBe(true);
    const fresh = await open('fresh');
    fresh.post('<discard-changes/>');
    await fresh.raw.until(() => fresh.raw.messages.at(-1)?.name === 'rpc-reply', 2000, 'the reply');
    expect(fresh.raw.messages.at(-1)!.attr('message-id')).toBeUndefined();
  });

  it('AC2: quirks that act at session start apply to sessions opened afterwards', async () => {
    const { srv, c } = await notifySession({ control: { users: ['admin'] } });
    // For the open session the start-only quirk changes nothing.
    srv.control!.setQuirk('chunkedFramingBroken', true, 1);
    expect(isOk(await c.call('<discard-changes/>'))).toBe(true);
    // A new base:1.1 session gets broken chunk headers: a space after the chunk size.
    srv.control!.setQuirk('chunkedFramingBroken', true);
    const late = await byteSession(srv, 'late');
    late.send('<discard-changes/>');
    await waitFor(() => / \n<\?xml/.test(late.text()));
    expect(late.text()).toMatch(/\n#\d+ \n<\?xml[^]*<ok\/>/);
  });

  it('AC3: an unknown quirk name or invalid settings get invalid-value', async () => {
    const { c } = await notifySession();
    expect(errorTags(await c.call(setQuirk('<name>noSuchQuirk</name>')))).toEqual(['invalid-value']);
    expect(errorTags(await c.call(setQuirk('<name>slowCloseSession</name><settings>{"delay":"soon"}</settings>')))).toEqual(['invalid-value']);
    expect(errorTags(await c.call(setQuirk('<name>slowCloseSession</name><settings>{not json</settings>')))).toEqual(['invalid-value']);
  });
});
