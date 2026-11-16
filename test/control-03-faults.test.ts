// CONTROL-03: inject faults into a session.

import { connectionPair } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { RawClient } from './helpers.js';
import { chunk, CTL, notifySession } from './notify-helpers.js';
import { errorTags, isOk, settle } from './writes-helpers.js';

const GET = '<get-config><source><running/></source></get-config>';
const inject = (body: string): string => `<inject-fault xmlns="${CTL}">${body}</inject-fault>`;

describe('CONTROL-03 inject faults into a session', () => {
  it('AC1: targets a session by id, by user or the next new session, on the next RPC, a named operation, or at once', async () => {
    const { srv, c, open } = await notifySession();
    const victim = await open('victim');
    // By id, on the next RPC.
    expect(errorTags(await c.call(inject('<session-id>2</session-id><rpc-error><error-message>by id</error-message></rpc-error>')))).toEqual([]);
    expect(errorTags(await victim.call(GET))).toEqual(['operation-failed']);
    expect(isOk(await victim.call('<discard-changes/>'))).toBe(true);
    // By user, on a named operation only.
    expect(errorTags(await c.call(inject('<username>victim</username><on-operation>get-config</on-operation><rpc-error/>')))).toEqual([]);
    expect(isOk(await victim.call('<discard-changes/>'))).toBe(true);
    expect(errorTags(await victim.call(GET))).toEqual(['operation-failed']);
    // The next new session.
    expect(errorTags(await c.call(inject('<next-session/><rpc-error><error-tag>in-use</error-tag></rpc-error>')))).toEqual([]);
    const fresh = await open('fresh');
    expect(errorTags(await fresh.call(GET))).toEqual(['in-use']);
    expect(errorTags(await victim.call(GET))).toEqual([]);
    // At once.
    expect(errorTags(await c.call(inject('<session-id>2</session-id><immediately/><drop/>')))).toEqual([]);
    await victim.raw.waitClosed();
    expect(srv.sessions.map((s) => s.id)).not.toContain(2);
  });

  it('AC2: actions reply with rpc-errors, send no reply, delay, drop, send no hello, send unsolicited messages or raw bytes', async () => {
    const { srv, clock, open } = await notifySession();
    const v = await open('v');
    const control = srv.control!;
    const mine = { kind: 'session' as const, sessionId: 2 };

    control.injectFault({ target: mine, action: { kind: 'rpc-error', errors: [{ type: 'protocol', tag: 'invalid-value', message: 'injected' }] } });
    expect(errorTags(await v.call(GET))).toEqual(['invalid-value']);

    // No reply: the request is answered but nothing is sent; the next one is answered as usual.
    control.injectFault({ target: mine, action: { kind: 'no-reply' } });
    const unanswered = v.post(GET);
    expect(isOk(await v.call('<discard-changes/>'))).toBe(true);
    expect(v.reply(unanswered)).toBeUndefined();

    // Delay: the reply waits for the server's clock.
    control.injectFault({ target: mine, action: { kind: 'delay', ms: 30_000 } });
    const late = v.post(GET);
    await settle();
    expect(v.reply(late)).toBeUndefined();
    clock.advance(30_000);
    await v.raw.until(() => v.reply(late) !== undefined, 2000, 'the delayed reply');

    // Unsolicited messages go out before the reply.
    control.injectFault({ target: mine, action: { kind: 'unsolicited', messages: ['<surprise xmlns="urn:example:x"/>'] } });
    await v.call(GET);
    expect(v.raw.messages.at(-2)!.name).toBe('surprise');

    // Raw bytes in place of the reply.
    const bytes = chunk('<raw xmlns="urn:example:x"/>');
    control.injectFault({ target: mine, action: { kind: 'raw-bytes', bytes } });
    const replaced = v.post(GET);
    await v.raw.until(() => v.raw.messages.at(-1)?.name === 'raw', 2000, 'the raw bytes');
    expect(v.reply(replaced)).toBeUndefined();

    // Drop: the connection goes, as if the transport failed.
    control.injectFault({ target: mine, action: { kind: 'drop' } });
    v.post(GET);
    await v.raw.waitClosed();

    // No hello: the next session gets no server hello.
    control.injectFault({ target: { kind: 'next-session' }, action: { kind: 'no-hello' } });
    const [client, serverEnd] = connectionPair();
    srv.serve(serverEnd, { principal: { username: 'quiet' }, transport: 'test' });
    const quiet = new RawClient(client);
    await settle();
    expect(quiet.messages).toEqual([]);
  });

  it('AC3: a fault fires once unless given a count, and can be listed and cleared', async () => {
    const { srv, c, open } = await notifySession();
    const v = await open('v');
    expect(errorTags(await c.call(inject('<username>v</username><count>2</count><rpc-error/>')))).toEqual([]);
    const listed = srv.control!.faults();
    expect(listed.map((f) => [f.target, f.remaining, f.action.kind])).toEqual([[{ kind: 'user', username: 'v' }, 2, 'rpc-error']]);
    expect(errorTags(await v.call(GET))).toEqual(['operation-failed']);
    expect(errorTags(await v.call(GET))).toEqual(['operation-failed']);
    expect(errorTags(await v.call(GET))).toEqual([]);

    expect(errorTags(await c.call(inject('<username>v</username><rpc-error/>')))).toEqual([]);
    expect(errorTags(await c.call(inject('<username>v</username><drop/>')))).toEqual([]);
    const state = await c.call(`<get><filter type="subtree"><control xmlns="${CTL}"/></filter></get>`);
    expect(state.child('data', 'urn:ietf:params:xml:ns:netconf:base:1.0')!.elements[0]!.elements[0]!.elements).toHaveLength(2);
    const cleared = await c.call(`<clear-faults xmlns="${CTL}"/>`);
    expect(cleared.elements[0]!.text()).toBe('2');
    expect(errorTags(await v.call(GET))).toEqual([]);
  });

  it('AC4: faults never affect the control session that set them', async () => {
    const { c } = await notifySession();
    // Injected by the tester's own session, for its own user: it became a control session with its first control RPC.
    expect(errorTags(await c.call(inject('<username>tester</username><count>3</count><rpc-error/>')))).toEqual([]);
    expect(errorTags(await c.call(GET))).toEqual([]);
  });
});
