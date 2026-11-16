import { describe, expect, it } from 'vitest';
import { ManualClock, rpcErrors, send, settle } from './writes-helpers.js';
import { deferred, get, PT, providersSession } from './providers-helpers.js';

const IFACES = `<interfaces xmlns="${PT}"/>`;

describe('PROVIDER-03 rate-limit and share read hooks', () => {
  it('answers from the operational tree within maxAge of the last successful run', async () => {
    const clock = new ManualClock();
    const { srv, c } = await providersSession({ clock });
    let calls = 0;
    await srv.provide('/providers-test:interfaces/interface', { maxAge: 5000, onRead: () => void calls++ });
    await send(c, get(IFACES));
    await send(c, get(IFACES));
    expect(calls).toBe(1);
    clock.advance(4999);
    await send(c, get(IFACES));
    expect(calls).toBe(1);
    clock.advance(1);
    await send(c, get(IFACES));
    expect(calls).toBe(2);
  });

  it('shares a running hook between reads: ten concurrent reads call it once', async () => {
    const { srv, c, open } = await providersSession();
    const gate = deferred();
    let calls = 0;
    await srv.provide('/providers-test:interfaces/interface', {
      onRead: async () => {
        calls++;
        await gate.promise;
      },
    });
    // A session answers its rpcs in turn, so ten reads at once come from ten sessions.
    const sessions = [c, ...(await Promise.all(Array.from({ length: 9 }, () => open())))];
    const replies = sessions.map((s) => send(s, get(IFACES)));
    await settle();
    gate.resolve();
    for (const r of await Promise.all(replies)) expect(rpcErrors(r)).toEqual([]);
    expect(calls).toBe(1);
  });

  it('calls the hook on every read without maxAge, sharing still applying', async () => {
    const { srv, c } = await providersSession();
    let calls = 0;
    await srv.provide('/providers-test:interfaces/interface', { onRead: () => void calls++ });
    await send(c, get(IFACES));
    await send(c, get(IFACES));
    await send(c, get(''));
    expect(calls).toBe(3);
  });
});
