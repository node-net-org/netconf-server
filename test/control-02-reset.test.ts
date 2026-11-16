// CONTROL-02: reset the server between tests.

import { describe, expect, it } from 'vitest';
import { decodeXml, encodeJson } from '@node-net/yang/core';
import { CTL, NC, notifySession } from './notify-helpers.js';
import { config, errorTags, isOk } from './writes-helpers.js';

const EDIT = '<edit-config><target><running/></target><config><servers xmlns="urn:example:notif"><server><name>b</name></server></servers></config></edit-config>';
const RESET = `<reset xmlns="${CTL}"/>`;
const INITIAL = { 'notif-test:servers': { server: [{ name: 'a', port: 8080 }] } };

describe('CONTROL-02 reset the server between tests', () => {
  it('AC1: restores every datastore and clears locks, pending confirmed commits, faults and run-time quirks', async () => {
    const { srv, c, open, device } = await notifySession();
    const w = await open('writer');
    expect(isOk(await w.call(EDIT))).toBe(true);
    expect(isOk(await w.call(EDIT.replace('<running/>', '<candidate/>').replace('<name>b</name>', '<name>c</name>')))).toBe(true);
    expect(isOk(await w.call('<commit><confirmed/></commit>'))).toBe(true);
    expect(isOk(await w.call('<lock><target><running/></target></lock>'))).toBe(true);
    srv.control!.injectFault({ target: { kind: 'user', username: 'nobody' }, action: { kind: 'drop' } });
    srv.control!.setQuirk('noPipelining', true);
    srv.control!.snapshot('before');

    expect(isOk(await c.call(RESET))).toBe(true);
    expect(await config(c.raw, device)).toEqual(INITIAL);
    expect(await config(c.raw, device, 'candidate')).toEqual(INITIAL);
    // The lock is gone and nothing is waiting to be confirmed.
    expect(isOk(await c.call(EDIT))).toBe(true);
    expect(errorTags(await w.call('<cancel-commit/>'))).toEqual(['operation-failed']);
    expect(srv.control!.faults()).toEqual([]);
    expect(srv.control!.quirks()).toEqual([]);
    expect(srv.control!.snapshots()).toEqual([]);
  });

  it('AC2: can end every other session', async () => {
    const { srv, c, open } = await notifySession();
    const other = await open('other');
    expect(srv.sessions).toHaveLength(2);
    expect(isOk(await c.call(`<reset xmlns="${CTL}"><end-other-sessions>true</end-other-sessions></reset>`))).toBe(true);
    await other.raw.waitClosed();
    expect(srv.sessions.map((s) => s.id)).toEqual([1]);
  });

  it('AC3: the same reset is available in process', async () => {
    const { srv, c, device } = await notifySession();
    expect(isOk(await c.call(EDIT))).toBe(true);
    await srv.control!.reset();
    expect(await config(c.raw, device)).toEqual(INITIAL);
  });

  it('AC4: reset completes before its ok, so the next RPC sees the reset state', async () => {
    const { c, device } = await notifySession();
    expect(isOk(await c.call(EDIT))).toBe(true);
    // Sent back to back: the get-config is answered after the reset's ok.
    const [reset, reply] = await Promise.all([c.call(RESET), c.call('<get-config><source><running/></source></get-config>')]);
    expect(isOk(reset)).toBe(true);
    expect(encodeJson(decodeXml(device.schema.forDatastore('running'), reply.child('data', NC)!.elements))).toEqual(INITIAL);
  });
});
