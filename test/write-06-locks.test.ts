// WRITE-06: lock and unlock with RFC 6241 §7.5–7.6 rules, published to embedding code.
import { describe, expect, it } from 'vitest';
import { errorInfo } from './helpers.js';
import { config, editConfig, errorTags, isOk, send, settle, WT, writesSession } from './writes-helpers.js';
import type { LockChangedEvent } from '../src/core.js';
import { providersSession } from './providers-helpers.js';

const lock = (ds: string): string => `<lock><target><${ds}/></target></lock>`;
const unlock = (ds: string): string => `<unlock><target><${ds}/></target></unlock>`;
const sys = (body: string): string => `<system xmlns="${WT}">${body}</system>`;

describe('WRITE-06 locks', () => {
  it('locks running, candidate and startup, and stops other sessions changing them', async () => {
    const { c, open, srv } = await writesSession();
    const other = await open();
    for (const ds of ['running', 'candidate', 'startup']) expect(isOk(await send(c, lock(ds))), ds).toBe(true);
    expect(srv.locks.list().map((l) => l.datastore).sort()).toEqual(['candidate', 'running', 'startup']);
    expect(errorTags(await send(other, editConfig('running', sys('<hostname>x</hostname>'))))).toEqual(['in-use']);
    expect(errorTags(await send(other, editConfig('candidate', sys('<hostname>x</hostname>'))))).toEqual(['in-use']);
    expect(errorTags(await send(other, '<copy-config><target><startup/></target><source><running/></source></copy-config>'))).toEqual(['in-use']);
    // The holder can still write.
    expect(isOk(await send(c, editConfig('running', sys('<hostname>mine</hostname>'))))).toBe(true);
  });

  it('answers a lock held by another session with lock-denied and the holder in error-info', async () => {
    const { c, open } = await writesSession();
    const other = await open();
    await send(c, lock('running'));
    const reply = await send(other, lock('running'));
    expect(errorTags(reply)).toEqual(['lock-denied']);
    const holder = c.messages[0]!.child('session-id', 'urn:ietf:params:xml:ns:netconf:base:1.0')!.text();
    expect(errorInfo(reply, 'session-id')).toBe(holder);
  });

  it('denies a lock of the candidate while it has uncommitted changes from another session', async () => {
    const { c, open } = await writesSession();
    const other = await open();
    await send(other, editConfig('candidate', sys('<hostname>pending</hostname>')));
    expect(errorTags(await send(c, lock('candidate')))).toEqual(['lock-denied']);
    // The session that made them may lock it; once discarded, anyone may.
    expect(isOk(await send(other, lock('candidate')))).toBe(true);
    await send(other, unlock('candidate'));
    expect(isOk(await send(c, lock('candidate')))).toBe(true);
  });

  it('answers writes by other sessions to a locked datastore with in-use', async () => {
    const { c, open } = await writesSession();
    const other = await open();
    await send(c, lock('candidate'));
    expect(errorTags(await send(other, '<discard-changes/>'))).toEqual(['in-use']);
    expect(errorTags(await send(other, '<copy-config><target><candidate/></target><source><running/></source></copy-config>'))).toEqual(['in-use']);
    // commit writes running, so a lock on running stops it.
    await send(c, lock('running'));
    expect(errorTags(await send(other, '<commit/>'))).toEqual(['in-use']);
  });

  it('unlocks for the holder; another session, or an unlocked datastore, gets operation-failed', async () => {
    const { c, open } = await writesSession();
    const other = await open();
    await send(c, lock('running'));
    expect(errorTags(await send(other, unlock('running')))).toEqual(['operation-failed']);
    expect(isOk(await send(c, unlock('running')))).toBe(true);
    expect(errorTags(await send(c, unlock('running')))).toEqual(['operation-failed']);
  });

  it('releases a session’s locks when it ends, discarding its uncommitted candidate, and publishes each change', async () => {
    const { c, open, srv, device } = await writesSession();
    const events: LockChangedEvent[] = [];
    srv.on('lockChanged', (e) => events.push(e));
    const holder = await open();
    await send(holder, lock('running'));
    await send(holder, lock('candidate'));
    await send(holder, editConfig('candidate', sys('<hostname>abandoned</hostname>')));
    const id = srv.locks.holder('running');
    expect(id).toBeDefined();
    holder.connection.destroy();
    await c.until(() => srv.locks.list().length === 0, 2000, 'the locks to go');
    await settle();
    expect(events.filter((e) => e.sessionId === undefined).map((e) => [e.datastore, e.previous])).toEqual([
      ['running', id],
      ['candidate', id],
    ]);
    expect(await config(c, device, 'candidate')).toMatchObject({ 'writes-test:system': { hostname: 'r1' } });
    expect(isOk(await send(c, lock('running')))).toBe(true);
  });

  it('applies changes providers report from outside NETCONF whether or not the datastore is locked', async () => {
    const p = await providersSession();
    expect(isOk(await send(p.c, lock('running')))).toBe(true);
    await p.srv.running.applyExternal({ 'providers-test:system': { hostname: 'outside' } }, { source: 'backend' });
    expect(await config(p.c, p.device)).toMatchObject({ 'providers-test:system': { hostname: 'outside' } });
    expect(p.srv.locks.holder('running')).toBeDefined();
  });
});
