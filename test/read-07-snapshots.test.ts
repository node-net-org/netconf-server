// READ-07: a read sees the configuration before a commit or after it, never a mixture (design §8).
import { describe, expect, it } from 'vitest';
import { config, editConfig, heldStore, isOk, send, settle, WT, writesSession, writesVariant } from './writes-helpers.js';
import { deferred, iface, providersSession } from './providers-helpers.js';

const BIG_EDIT = `<system xmlns="${WT}"><hostname>after</hostname></system><routing xmlns="${WT}"><route><prefix>10/8</prefix></route><route><prefix>11/8</prefix></route></routing>`;

/** A session whose writes are held at the store until released. */
async function heldSetup(): Promise<Awaited<ReturnType<typeof writesSession>> & { store: ReturnType<typeof heldStore> }> {
  const store = heldStore();
  const device = await writesVariant((d) => ({ ...d, capabilities: { ...d.capabilities, startup: false } }));
  const s = await writesSession({ device, store });
  return { ...s, store };
}

describe('READ-07 snapshot reads', () => {
  it('returns the whole configuration as it was before a commit that has not completed', async () => {
    const s = await heldSetup();
    const reader = await s.open();
    const before = await config(reader, s.device);
    const write = send(s.c, editConfig('running', BIG_EDIT));
    await s.c.until(() => s.store.waiting === 1, 2000, 'the write to reach its save');
    expect(await config(reader, s.device)).toEqual(before);
    s.store.release();
    expect(isOk(await write)).toBe(true);
  });

  it('returns the new configuration once the commit has completed', async () => {
    const s = await heldSetup();
    const reader = await s.open();
    const write = send(s.c, editConfig('candidate', BIG_EDIT)).then(() => send(s.c, '<commit/>'));
    await s.c.until(() => s.store.waiting === 1, 2000, 'the commit to reach its save');
    s.store.release();
    expect(isOk(await write)).toBe(true);
    expect(await config(reader, s.device)).toMatchObject({ 'writes-test:system': { hostname: 'after' }, 'writes-test:routing': { route: [{ prefix: '10/8' }, { prefix: '11/8' }] } });
  });

  it('answers reads while a write is held part-way', async () => {
    const s = await heldSetup();
    const reader = await s.open();
    void send(s.c, editConfig('running', BIG_EDIT));
    await s.c.until(() => s.store.waiting === 1, 2000, 'the write to reach its save');
    // Several reads, of every kind, all answered while the write waits.
    for (const op of ['<get/>', '<get-config><source><running/></source></get-config>', '<get-config><source><candidate/></source></get-config>']) {
      const reply = await send(reader, op);
      expect(reply.child('data', 'urn:ietf:params:xml:ns:netconf:base:1.0'), op).toBeDefined();
    }
    expect(s.store.waiting).toBe(1);
    s.store.release();
  });

  it('answers reads while a write waits on a slow provider hook', async () => {
    const p = await providersSession();
    const reader = await p.open();
    const gate = deferred();
    await p.srv.provide('/providers-test:interfaces/interface', { prepare: (_, ctx) => (ctx.cause === 'edit' ? gate.promise : undefined) });
    const before = await config(reader, p.device);
    const write = send(p.c, editConfig('running', iface('eth0', '<mtu>1400</mtu>')));
    await settle();
    for (const op of ['<get/>', '<get-config><source><running/></source></get-config>', '<get-config><source><candidate/></source></get-config>']) {
      const reply = await send(reader, op);
      expect(reply.child('data', 'urn:ietf:params:xml:ns:netconf:base:1.0'), op).toBeDefined();
    }
    expect(await config(reader, p.device)).toEqual(before);
    gate.resolve();
    expect(isOk(await write)).toBe(true);
  });
});
