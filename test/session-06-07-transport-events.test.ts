// SESSION-06: connect a client in-process. SESSION-07: observe session start and end.
import { describe, expect, it } from 'vitest';
import { connect, SessionClosedError } from '@node-net/netconf';
import { connectionPair } from '@node-net/netconf/core';
import { rawOpen, server } from './helpers.js';
import type { SessionEndEvent, SessionStartEvent } from '../src/core.js';

describe('SESSION-06 in-process transport', () => {
  it('is a connection factory @node-net/netconf connect() accepts, with no listener', async () => {
    const srv = await server();
    const client = await connect({ transport: srv.transport() });
    expect(client.session.baseVersion).toBe('1.1');
    expect(client.session.serverCapabilities.toArray()).toEqual(srv.device.capabilities);
    await client.close();
  });

  it('gives each connection its own session and session-id', async () => {
    const srv = await server();
    const transport = srv.transport();
    const clients = await Promise.all([1, 2, 3].map(() => connect({ transport })));
    const ids = clients.map((c) => c.session.sessionId);
    expect(new Set(ids).size).toBe(3);
    expect(srv.sessions.map((s) => s.id).sort()).toEqual([...ids].sort());
    await Promise.all(clients.map((c) => c.close()));
  });

  it('authenticates sessions as the principal given to transport()', async () => {
    const srv = await server();
    const starts: SessionStartEvent[] = [];
    srv.on('sessionStart', (e) => starts.push(e));
    const a = await connect({ transport: srv.transport({ principal: { username: 'alice', groups: ['admin'] } }) });
    const b = await connect({ transport: srv.transport() });
    expect(starts.map((s) => s.username)).toEqual(['alice', 'local']);
    expect(srv.sessions.map((s) => s.username)).toEqual(['alice', 'local']);
    await a.close();
    await b.close();
  });

  it('ends every in-process session when the server closes, and refuses new ones', async () => {
    const srv = await server();
    const a = await connect({ transport: srv.transport() });
    await srv.close();
    await expect(a.ops.getConfig()).rejects.toBeInstanceOf(SessionClosedError);
    await expect(connect({ transport: srv.transport() })).rejects.toThrow();
    expect(() => srv.serve(connectionPair()[1], { principal: { username: 'x' }, transport: 'test' })).toThrow('closed');
  });

  it('honours an aborted connect signal', async () => {
    const srv = await server();
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(srv.transport()(ac.signal)).rejects.toThrow('stop');
  });
});

describe('SESSION-07 session events', () => {
  it('emits sessionStart after the hellos, with id, username and transport', async () => {
    const srv = await server();
    const starts: SessionStartEvent[] = [];
    srv.on('sessionStart', (e) => starts.push(e));
    const client = await connect({ transport: srv.transport() });
    expect(starts).toEqual([{ sessionId: client.session.sessionId, username: 'local', transport: 'in-process' }]);
    await client.close();
  });

  it('emits sessionEnd with the reason: closed, killed (with the killer), dropped, protocol error', async () => {
    const srv = await server();
    const ends: SessionEndEvent[] = [];
    srv.on('sessionEnd', (e) => ends.push(e));
    const a = await connect({ transport: srv.transport() });
    const b = await connect({ transport: srv.transport() });
    await a.ops.killSession(b.session.sessionId);
    await a.close();
    const c = await rawOpen(srv);
    c.connection.destroy();
    const d = await rawOpen(srv);
    d.send('\n#zz\n');
    await d.until(() => ends.length === 4, 2000, 'four ends');
    expect(ends.map((e) => e.reason)).toEqual(['killed', 'closed', 'dropped', 'protocol-error']);
    expect(ends[0]!.killedBy).toBe(a.session.sessionId);
    expect(ends[1]!.killedBy).toBeUndefined();
  });

  it('never lets a throwing listener affect a session, and logs it', async () => {
    const warnings: string[] = [];
    const srv = await server({ logger: { warn: (m) => warnings.push(m) } });
    srv.on('sessionStart', () => {
      throw new Error('listener bug');
    });
    const seen: number[] = [];
    srv.on('sessionStart', (e) => seen.push(e.sessionId));
    const client = await connect({ transport: srv.transport() });
    expect(seen).toEqual([client.session.sessionId]);
    expect((await client.ops.killSession(9999).catch((e: { tag?: string }) => e.tag))).toBe('invalid-value');
    expect(warnings).toEqual(['A sessionStart listener threw']);
    await client.close();
  });

  it('supports off() and once()', async () => {
    const srv = await server();
    const once: number[] = [];
    const on: number[] = [];
    const listener = (e: SessionStartEvent): void => void on.push(e.sessionId);
    srv.once('sessionStart', (e) => once.push(e.sessionId));
    srv.on('sessionStart', listener);
    const a = await connect({ transport: srv.transport() });
    srv.off('sessionStart', listener);
    const b = await connect({ transport: srv.transport() });
    expect(once).toEqual([a.session.sessionId]);
    expect(on).toEqual([a.session.sessionId]);
    await a.close();
    await b.close();
  });
});
