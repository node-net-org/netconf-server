// SESSION-04: close-session. SESSION-05: kill-session.
// Lock release, candidate discard and confirmed-commit rollback on session end arrive with locks and candidate (M2).
import { describe, expect, it } from 'vitest';
import { connect, RpcError, SessionClosedError } from '@node-net/netconf';
import { NETCONF_NS, x } from '@node-net/netconf/core';
import { NC, errorTag, rawOpen, rpc, server } from './helpers.js';
import type { SessionEndEvent } from '../src/core.js';

describe('SESSION-04 close-session', () => {
  it('answers ok, then closes the connection', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    const reply = await c.request(rpc('<close-session/>'));
    expect(reply.child('ok', NC)).toBeDefined();
    await c.waitClosed();
    expect(srv.sessions).toEqual([]);
  });

  it('works through @node-net/netconf client.close()', async () => {
    const srv = await server();
    const ends: SessionEndEvent[] = [];
    srv.on('sessionEnd', (e) => ends.push(e));
    const client = await connect({ transport: srv.transport() });
    await client.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(ends.map((e) => e.reason)).toEqual(['closed']);
  });

  it('cleans up a connection dropped without close-session', async () => {
    const srv = await server();
    const ends: SessionEndEvent[] = [];
    srv.on('sessionEnd', (e) => ends.push(e));
    const c = await rawOpen(srv);
    c.connection.destroy();
    await c.until(() => ends.length === 1, 2000, 'session end');
    expect(ends[0]!.reason).toBe('dropped');
    expect(srv.sessions).toEqual([]);
  });
});

describe('SESSION-05 kill-session', () => {
  it('ends another session and answers ok', async () => {
    const srv = await server();
    const ends: SessionEndEvent[] = [];
    srv.on('sessionEnd', (e) => ends.push(e));
    const a = await connect({ transport: srv.transport() });
    const b = await connect({ transport: srv.transport() });
    const reply = await a.ops.killSession(b.session.sessionId);
    expect(reply.ok).toBe(true);
    await expect(b.ops.getConfig()).rejects.toBeInstanceOf(SessionClosedError);
    expect(ends).toEqual([{ sessionId: b.session.sessionId, username: 'local', transport: 'in-process', reason: 'killed', killedBy: a.session.sessionId }]);
    expect(srv.sessions.map((s) => s.id)).toEqual([a.session.sessionId]);
    await a.close();
  });

  it('refuses to kill the caller itself with invalid-value', async () => {
    const srv = await server();
    const a = await connect({ transport: srv.transport() });
    const err = await a.ops.killSession(a.session.sessionId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).tag).toBe('invalid-value');
    await a.close();
  });

  it('answers invalid-value for an unknown session id', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    expect(errorTag(await c.request(rpc('<kill-session><session-id>4242</session-id></kill-session>')))).toBe('invalid-value');
    expect(errorTag(await c.request(rpc('<kill-session><session-id>abc</session-id></kill-session>', 'message-id="2"')))).toBe('invalid-value');
    expect(errorTag(await c.request(rpc('<kill-session/>', 'message-id="3"')))).toBe('missing-element');
  });

  it('aborts operations the killed session had in progress', async () => {
    const srv = await server();
    let aborted = false;
    let entered!: () => void;
    const running = new Promise<void>((r) => (entered = r));
    srv.handle(NETCONF_NS, 'get', ({ signal }) => {
      entered();
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve([x('data', { xmlns: NETCONF_NS })]);
        });
      });
    });
    const a = await connect({ transport: srv.transport() });
    const b = await connect({ transport: srv.transport() });
    const pending = b.ops.get().catch((e: unknown) => e);
    await running;
    await a.ops.killSession(b.session.sessionId);
    expect(aborted).toBe(true);
    expect(await pending).toBeInstanceOf(SessionClosedError);
    await a.close();
  });
});
