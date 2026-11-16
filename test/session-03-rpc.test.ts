// SESSION-03: replies matched by message-id, and an rpc-error for malformed or unknown RPCs.
import { describe, expect, it } from 'vitest';
import { NETCONF_NS, x } from '@node-net/netconf/core';
import { memorySource } from '@node-net/yang/core';
import { NC, errorInfo, errorTag, rawOpen, rpc, server } from './helpers.js';

describe('SESSION-03 rpc replies and errors', () => {
  it('echoes the message-id and every other rpc attribute (RFC 6241 §4.2)', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    const reply = await c.request(rpc('<get/>', 'message-id="101" xmlns:ex="urn:example:ex" ex:user-id="fred" plain="x"'));
    expect(reply.attr('message-id')).toBe('101');
    expect(reply.attr('user-id', 'urn:example:ex')).toBe('fred');
    expect(reply.attr('plain')).toBe('x');
  });

  it('answers an rpc without a message-id with missing-attribute', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    const reply = await c.request(rpc('<get/>', ''));
    expect(reply.attr('message-id')).toBeUndefined();
    expect(errorTag(reply)).toBe('missing-attribute');
    expect(errorInfo(reply, 'bad-attribute')).toBe('message-id');
    expect(errorInfo(reply, 'bad-element')).toBe('rpc');
  });

  it('answers an operation the server does not implement with operation-not-supported', async () => {
    // reboot is in the device's schema, but nothing handles it.
    const module = 'module ops { namespace "urn:example:ops"; prefix o; rpc reboot; }';
    const srv = await server({ device: { id: 'ops', yang: { modules: ['ops'] } }, source: memorySource([{ text: module }]) });
    const c = await rawOpen(srv);
    const reply = await c.request(rpc('<reboot xmlns="urn:example:ops"/>'));
    expect(errorTag(reply)).toBe('operation-not-supported');
    // commit is not in this device's schema (no :candidate), but is a standard operation.
    expect(errorTag(await c.request(rpc('<commit/>', 'message-id="2"')))).toBe('operation-not-supported');
  });

  it('answers an unknown namespace with unknown-namespace, naming the element and namespace', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    const reply = await c.request(rpc('<frob xmlns="urn:example:nothing"/>'));
    expect(errorTag(reply)).toBe('unknown-namespace');
    expect(errorInfo(reply, 'bad-element')).toBe('frob');
    expect(errorInfo(reply, 'bad-namespace')).toBe('urn:example:nothing');
  });

  it('answers an unknown operation, or an unknown parameter, with unknown-element naming it', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    let reply = await c.request(rpc('<frobnicate/>'));
    expect(errorTag(reply)).toBe('unknown-element');
    expect(errorInfo(reply, 'bad-element')).toBe('frobnicate');
    reply = await c.request(rpc('<kill-session><session-id>9</session-id><colour>red</colour></kill-session>', 'message-id="2"'));
    expect(errorTag(reply)).toBe('unknown-element');
    expect(errorInfo(reply, 'bad-element')).toBe('colour');
  });

  it('answers an rpc with no operation with missing-element', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    expect(errorTag(await c.request(rpc('')))).toBe('missing-element');
  });

  it('sends replies in the order the requests arrived', async () => {
    const srv = await server();
    // A slow handler for the first request must not let the second overtake it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    srv.handle(NETCONF_NS, 'get', async () => {
      await gate;
      return [x('data', { xmlns: NETCONF_NS })];
    });
    const c = await rawOpen(srv);
    const { chunked } = await import('./helpers.js');
    c.send(chunked(rpc('<get/>', 'message-id="a"')));
    c.send(chunked(rpc('<frob/>', 'message-id="b"')));
    await new Promise((r) => setTimeout(r, 30));
    expect(c.messages).toHaveLength(1);
    release();
    await c.waitFor(3);
    expect(c.messages.slice(1).map((m) => m.attr('message-id'))).toEqual(['a', 'b']);
    expect(c.messages[1]!.child('data', NC)).toBeDefined();
  });

  it.each([
    ['XML that is not well formed', '<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="1"><get>'],
    ['a DOCTYPE', '<!DOCTYPE rpc [<!ENTITY a "b">]><rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="1"><get/></rpc>'],
    ['an element that is not an rpc', '<notrpc/>'],
  ])('answers %s with malformed-message, and the session continues', async (_what, text) => {
    const srv = await server();
    const c = await rawOpen(srv);
    const reply = await c.request(text);
    expect(errorTag(reply)).toBe('malformed-message');
    expect((await c.request(rpc('<close-session/>', 'message-id="2"'))).child('ok', NC)).toBeDefined();
  });

  it('answers operation-failed when a handler throws, and logs it', async () => {
    const errors: string[] = [];
    const srv = await server({ logger: { error: (m) => errors.push(m) } });
    srv.handle(NETCONF_NS, 'get', () => {
      throw new Error('boom');
    });
    const c = await rawOpen(srv);
    const reply = await c.request(rpc('<get/>'));
    expect(errorTag(reply)).toBe('operation-failed');
    expect(reply.child('rpc-error', NC)!.child('error-type', NC)!.text()).toBe('application');
    expect(errors).toEqual(['get failed']);
  });
});
