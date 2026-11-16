// NACM-09: an action needs read access to every instance on its path and
// exec access to itself (RFC 8341 §3.1.3; NACM design §6). NACM-04: refused
// actions counted in denied-operations and reported.
import { describe, expect, it } from 'vitest';
import type { AccessDeniedEvent, NetconfServer } from '../src/core.js';
import { call, counters, denial, ok, open, policy, rule, server, W, type Json } from './nacm-write-helpers.js';
import { recordingLogger } from './ssh-helpers.js';

const BOUNCE = (port: string): string => `<action xmlns="urn:ietf:params:xml:ns:yang:1"><top xmlns="${W}"><port><id>${port}</id><bounce><why>test</why></bounce></port></top></action>`;
const PORT_PATH = (id: string): string => `/acme-w:top/acme-w:port[acme-w:id='${id}']`;

async function withBounce(p: Json | undefined, options = {}): Promise<{ srv: NetconfServer; bounced: string[] }> {
  const srv = await server(p, options);
  const bounced: string[] = [];
  await srv.provide('/acme-w:top', { actions: { '/acme-w:top/port/bounce': (c) => void bounced.push(c.path ?? '') } });
  return { srv, bounced };
}

const NO_P2 = rule('no-p2', "/acme-w:top/port[id='p2']", 'read', 'deny');
const NO_BOUNCE = rule('no-bounce', '/acme-w:top/port/bounce', 'exec', 'deny');

describe('NACM-09 action access control', () => {
  it('AC1: an action runs when every instance on its path is readable and the action may be executed', async () => {
    const { srv, bounced } = await withBounce(policy([NO_P2]));
    expect(ok(await call(await open(srv, 'alice'), BOUNCE('p1')))).toBe(true);
    expect(bounced).toEqual(["/acme-w:top/port[id='p1']"]);
    await srv.close();
  });

  it('AC2: an action on an unreadable instance is refused, naming the deepest readable instance', async () => {
    const { srv, bounced } = await withBounce(policy([NO_P2]));
    const refused = denial(await call(await open(srv, 'alice'), BOUNCE('p2')));
    expect(refused).toMatchObject({ tag: 'access-denied', path: '/acme-w:top' });
    expect(bounced).toEqual([]);
    await srv.close();
  });

  it('AC2: an action the policy denies exec on is refused, naming its instance', async () => {
    const { srv, bounced } = await withBounce(policy([NO_BOUNCE]));
    expect(denial(await call(await open(srv, 'alice'), BOUNCE('p1')))).toMatchObject({ tag: 'access-denied', path: PORT_PATH('p1') });
    expect(bounced).toEqual([]);
    // exec-default deny refuses it too, with no rule.
    const { srv: srv2 } = await withBounce(policy([], { 'exec-default': 'deny' }));
    expect(denial(await call(await open(srv2, 'alice'), BOUNCE('p1'))).tag).toBe('access-denied');
    await srv.close();
    await srv2.close();
  });

  it("AC3: access is checked before validation, so an unreadable instance isn't reported missing", async () => {
    const { srv } = await withBounce(policy([rule('no-p9', "/acme-w:top/port[id='p9']", 'read', 'deny')]));
    const alice = await open(srv, 'alice');
    expect(denial(await call(alice, BOUNCE('p9'))).tag).toBe('access-denied');
    // A readable instance that doesn't exist is data-missing, as before.
    expect(denial(await call(alice, BOUNCE('p8'))).tag).toBe('data-missing');
    await srv.close();
  });

  it('AC4: each refused action counts in denied-operations, raises accessDenied and is logged', async () => {
    const { logger, entries } = recordingLogger();
    const { srv } = await withBounce(policy([NO_BOUNCE]), { logger });
    const events: AccessDeniedEvent[] = [];
    srv.on('accessDenied', (e) => events.push(e));
    await call(await open(srv, 'alice'), BOUNCE('p1'));
    expect(await counters(srv)).toMatchObject({ 'denied-operations': '1', 'denied-data-writes': '0' });
    const sessionId = srv.sessions.find((s) => s.username === 'alice')!.id;
    expect(events).toEqual([{ sessionId, username: 'alice', kind: 'action', operation: 'bounce', path: "/acme-w:top/port[id='p1']/bounce" }]);
    expect(entries.find((l) => l.message === 'Access denied')!.context).toMatchObject({ sessionId, username: 'alice', action: 'bounce', rule: 'ops/no-bounce' });
    await srv.close();
  });

  it('AC5: recovery sessions and enable-nacm false invoke actions as before (devices without the module: provider-11)', async () => {
    const { srv, bounced } = await withBounce(policy([NO_P2, NO_BOUNCE]));
    expect(ok(await call(await open(srv, 'recovery'), BOUNCE('p2')))).toBe(true);
    await srv.close();
    const { srv: off, bounced: offBounced } = await withBounce(policy([NO_P2, NO_BOUNCE], { 'enable-nacm': false }));
    expect(ok(await call(await open(off, 'alice'), BOUNCE('p2')))).toBe(true);
    expect([...bounced, ...offBounced]).toHaveLength(2);
    await off.close();
  });
});
