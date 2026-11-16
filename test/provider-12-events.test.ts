import { describe, expect, it } from 'vitest';
import type { CommitEvent, LockChangedEvent } from '../src/core.js';
import { editConfig, isOk, send } from './writes-helpers.js';
import { PT, providersSession } from './providers-helpers.js';
import { rawOpen } from './helpers.js';

const system = (inner: string): string => `<system xmlns="${PT}">${inner}</system>`;

describe('PROVIDER-12 watch lock state and server events from embedding code', () => {
  it('says which session and user hold the lock on each configuration datastore', async () => {
    const { srv, c } = await providersSession();
    const op = await rawOpen(srv, '1.1', 'operator');
    await send(c, '<lock><target><running/></target></lock>');
    await send(op, '<lock><target><candidate/></target></lock>');
    expect(srv.locks.get('running')).toMatchObject({ datastore: 'running', sessionId: srv.locks.holder('running'), username: 'tester' });
    expect(srv.locks.get('candidate')).toMatchObject({ username: 'operator' });
    expect(srv.locks.get('startup')).toBeUndefined();
    expect(srv.locks.list().map((l) => [l.datastore, l.username])).toEqual([
      ['running', 'tester'],
      ['candidate', 'operator'],
    ]);
  });

  it('emits lockChanged when a lock is taken or released, with the datastore, session and user', async () => {
    const { srv, c } = await providersSession();
    const events: LockChangedEvent[] = [];
    srv.on('lockChanged', (e) => events.push(e));
    await send(c, '<lock><target><running/></target></lock>');
    const id = srv.locks.holder('running');
    await send(c, '<unlock><target><running/></target></unlock>');
    expect(events).toEqual([
      { datastore: 'running', sessionId: id, username: 'tester', previous: undefined, previousUsername: undefined },
      { datastore: 'running', sessionId: undefined, username: undefined, previous: id, previousUsername: 'tester' },
    ]);
  });

  it('emits commit after each change to running, with the changes, the session or outside source, and the user', async () => {
    const { srv, c } = await providersSession();
    const events: CommitEvent[] = [];
    srv.on('commit', (e) => events.push(e));
    await send(c, editConfig('running', system('<contact>noc</contact>')));
    await srv.running.applyExternal({ 'providers-test:system': { contact: 'desk' } }, { source: 'backend' });
    expect(events.map((e) => ({ cause: e.cause, sessionId: e.sessionId, username: e.username, source: e.source, changes: e.changes.map((ch) => `${ch.operation} ${ch.path}`) }))).toEqual([
      { cause: 'edit', sessionId: expect.any(Number) as number, username: 'tester', source: undefined, changes: ['create /providers-test:system/contact'] },
      { cause: 'external', sessionId: undefined, username: undefined, source: 'backend', changes: ['replace /providers-test:system/contact'] },
    ]);
  });

  it('only reports: a listener that throws affects nothing', async () => {
    const { srv, c } = await providersSession();
    const boom = (): void => {
      throw new Error('listener bug');
    };
    srv.on('commit', boom).on('lockChanged', boom).on('stateChanged', boom).on('outOfSync', boom);
    expect(isOk(await send(c, '<lock><target><running/></target></lock>'))).toBe(true);
    expect(isOk(await send(c, editConfig('running', system('<contact>noc</contact>'))))).toBe(true);
    const handle = await srv.provide('/providers-test:system', {});
    handle.markOutOfSync('drift');
    expect(handle.outOfSync).toBe(true);
    expect(isOk(await send(c, '<unlock><target><running/></target></unlock>'))).toBe(true);
  });
});
