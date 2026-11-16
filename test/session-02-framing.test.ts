// SESSION-02: exchange messages in end-of-message or chunked framing as negotiated.
import { describe, expect, it } from 'vitest';
import { NC, chunked, eom, rawOpen, rpc, server } from './helpers.js';

const bad = (id: number): string => rpc('<no-such-op xmlns="urn:example:none"/>', `message-id="${id}"`);

describe('SESSION-02 framing', () => {
  it('handles messages split across many reads, and several messages in one read, once each and in order', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    const frames = [1, 2, 3].map((i) => chunked(bad(i), 7));
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
      all.set(f, at);
      at += f.length;
    }
    // One byte at a time for the first two, the rest in one write.
    const split = frames[0]!.length + frames[1]!.length;
    for (let i = 0; i < split; i++) c.send(all.subarray(i, i + 1));
    c.send(all.subarray(split));
    await c.waitFor(4);
    expect(c.messages.slice(1).map((m) => m.attr('message-id'))).toEqual(['1', '2', '3']);
  });

  it('does the same in end-of-message framing', async () => {
    const srv = await server();
    const c = await rawOpen(srv, '1.0');
    const both = new TextEncoder().encode(`${bad(1)}]]>]]>${bad(2)}]]>]]>`);
    c.send(both.subarray(0, 10));
    c.send(both.subarray(10));
    await c.waitFor(3);
    expect(c.messages.slice(1).map((m) => m.attr('message-id'))).toEqual(['1', '2']);
  });

  it('accepts chunks of one byte, and a whole message in one large chunk', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    c.send(chunked(bad(1), 1));
    // Multi-byte characters split across chunks, in an attribute echoed back.
    c.send(chunked(rpc('<close-session/>', 'message-id="2" xmlns:ex="urn:example" ex:note="héllo ☃"'), 1));
    await c.waitFor(3);
    expect(c.messages[1]!.attr('message-id')).toBe('1');
    expect(c.messages[2]!.attr('note', 'urn:example')).toBe('héllo ☃');
    const d = await rawOpen(srv);
    const big = rpc(`<get><filter type="subtree">${'<a/>'.repeat(50_000)}</filter></get>`);
    expect((await d.request(big)).name).toBe('rpc-reply');
  });

  it('ends the session on a bad chunk header without replying', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    c.send('\n#abc\n<rpc/>\n##\n');
    await c.waitClosed();
    expect(c.messages).toHaveLength(1);
  });

  it('ends the session on end-of-message framing inside a chunked session', async () => {
    const srv = await server();
    const c = await rawOpen(srv);
    c.send(eom(bad(1)));
    await c.waitClosed();
    expect(c.messages).toHaveLength(1);
  });

  it('replies in the negotiated framing', async () => {
    const srv = await server();
    const c11 = await rawOpen(srv, '1.1');
    await c11.request(bad(1));
    expect(c11.messages[1]!.name).toBe('rpc-reply');
    const c10 = await rawOpen(srv, '1.0');
    await c10.request(bad(1));
    expect(c10.messages[1]!.name).toBe('rpc-reply');
  });

  it('ends the session when a message is larger than the maximum', async () => {
    const srv = await server({ maxMessageBytes: 4096 });
    const c = await rawOpen(srv);
    c.send(chunked(rpc(`<get><filter>${'x'.repeat(10_000)}</filter></get>`)));
    await c.waitClosed();
    expect(c.messages).toHaveLength(1);
  });

  it('ends the session when an end-of-message hello is followed by an oversized message', async () => {
    const srv = await server({ maxMessageBytes: 4096 });
    const c = await rawOpen(srv, '1.0');
    c.send('<rpc>' + 'x'.repeat(10_000));
    await c.waitClosed();
    expect(c.messages.every((m) => m.ns === NC)).toBe(true);
  });
});
