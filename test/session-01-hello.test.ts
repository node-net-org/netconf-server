// SESSION-01: open a session with hello and capability exchange.
import { describe, expect, it } from 'vitest';
import { connect } from '@node-net/netconf';
import { BASE_1_0, BASE_1_1, NC, chunked, eom, hello, raw, rpc, server } from './helpers.js';

describe('SESSION-01 hello and capability exchange', () => {
  it('sends its hello at once, before the client says anything', async () => {
    const srv = await server();
    const c = await raw(srv);
    const h = c.messages[0]!;
    expect(h.name).toBe('hello');
    expect(h.ns).toBe(NC);
  });

  it('lists both base versions and every device capability, with a unique session-id', async () => {
    const srv = await server({ device: { id: 't', yang: { modules: [] }, capabilities: { candidate: true, extra: ['urn:example:extra'] } } });
    const a = await raw(srv);
    const b = await raw(srv);
    const caps = a.messages[0]!.child('capabilities', NC)!.childrenNamed('capability', NC).map((e) => e.text());
    expect(caps).toEqual(srv.device.capabilities);
    expect(caps).toContain(BASE_1_0);
    expect(caps).toContain(BASE_1_1);
    expect(caps).toContain('urn:ietf:params:netconf:capability:candidate:1.0');
    expect(caps).toContain('urn:example:extra');
    const ids = [a, b].map((c) => c.messages[0]!.child('session-id', NC)!.text());
    expect(ids[0]).toMatch(/^[1-9][0-9]*$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('uses chunked framing after the hellos when both advertise base:1.1', async () => {
    const srv = await server();
    const c = await raw(srv);
    c.send(eom(hello([BASE_1_0, BASE_1_1])));
    c.useChunked();
    c.send(chunked(rpc('<close-session/>')));
    const reply = await c.waitFor(2);
    expect(reply.child('ok', NC)).toBeDefined();
    expect(srv.sessions).toEqual([]);
  });

  it('stays on end-of-message framing when the client advertises only base:1.0', async () => {
    const srv = await server();
    const c = await raw(srv);
    c.send(eom(hello([BASE_1_0])));
    await c.until(() => srv.sessions.length === 1, 2000, 'open');
    expect(srv.sessions[0]!.version).toBe('1.0');
    c.send(eom(rpc('<close-session/>')));
    expect((await c.waitFor(2)).child('ok', NC)).toBeDefined();
    expect(c.texts[1]).not.toMatch(/^\n#/);
  });

  it.each([
    ['malformed XML', '<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities>'],
    ['a session-id', hello([BASE_1_0, BASE_1_1], '<session-id>4</session-id>')],
    ['no base capability', hello(['urn:example:not-base'])],
    ['an element that is not a hello', rpc('<get/>')],
  ])('ends the session without a reply for a client hello with %s', async (_what, text) => {
    const srv = await server();
    const ended: string[] = [];
    srv.on('sessionEnd', (e) => ended.push(e.reason));
    const c = await raw(srv);
    c.send(eom(text));
    await c.waitClosed();
    expect(c.messages).toHaveLength(1);
    expect(srv.sessions).toEqual([]);
    expect(ended).toEqual([]); // it never started
  });

  it('ends the session when an rpc arrives before the client hello', async () => {
    const srv = await server();
    const c = await raw(srv);
    c.send(eom(rpc('<get/>')));
    await c.waitClosed();
    expect(c.messages).toHaveLength(1);
  });

  it('ends the session when no hello arrives in time, on the injected clock', async () => {
    const timers: (() => void)[] = [];
    const clock = { now: () => 0, setTimeout: (fn: () => void) => timers.push(fn), clearTimeout: () => undefined };
    const srv = await server({ clock, helloTimeout: 1000 });
    const c = await raw(srv);
    expect(timers).toHaveLength(1);
    timers[0]!();
    await c.waitClosed();
  });

  it('advertises module capabilities matching the YANG modules, features and deviations', async () => {
    const srv = await server({ device: { id: 't', yang: { modules: [] }, capabilities: { candidate: true, startup: true } } });
    const client = await connect({ transport: srv.transport() });
    const nc = client.session.serverCapabilities.helloModule('ietf-netconf')!;
    expect(nc.revision).toBe('2011-06-01');
    expect([...nc.features].sort()).toEqual(['candidate', 'rollback-on-error', 'startup', 'validate', 'xpath']);
    expect(client.session.serverCapabilities.helloModule('ietf-netconf-monitoring')?.revision).toBe('2010-10-04');
    // YANG 1.1 modules are in the YANG library only (RFC 7950 §5.6.4).
    expect(client.session.serverCapabilities.hasHelloModule('ietf-yang-library')).toBe(false);
    expect(client.session.serverCapabilities.get(':yang-library:1.1')?.params.get('content-id')).toMatch(/^[0-9a-f]{8}$/);
    await client.close();
  });
});
