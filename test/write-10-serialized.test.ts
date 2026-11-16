// WRITE-10: writes from every session applied one at a time, in arrival order (design §8).
import { describe, expect, it } from 'vitest';
import { config, editConfig, errorTags, heldStore, isOk, ManualClock, send, settle, WT, writesSession, writesVariant } from './writes-helpers.js';
import { deferred, PT, providersSession } from './providers-helpers.js';

const NC_ATTR = 'xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0"';

describe('WRITE-10 serialized writes', () => {
  it('applies writes from different sessions one at a time, in the order they arrived', async () => {
    const store = heldStore();
    const device = await writesVariant((d) => ({ ...d, capabilities: { ...d.capabilities, startup: false } }));
    const { c, open } = await writesSession({ device, store });
    const other = await open();
    const first = send(c, editConfig('running', `<interfaces xmlns="${WT}" ${NC_ATTR}><interface nc:operation="create"><name>race</name><type>a</type></interface></interfaces>`));
    await c.until(() => store.waiting === 1, 2000, 'the first write to reach its save');
    const second = send(other, editConfig('running', `<interfaces xmlns="${WT}" ${NC_ATTR}><interface nc:operation="create"><name>race</name><type>b</type></interface></interfaces>`));
    // The second waits behind the first: it hasn't reached the store.
    await new Promise((r) => setTimeout(r, 30));
    expect(store.waiting).toBe(1);
    store.release();
    expect(isOk(await first)).toBe(true);
    // Validated against what the first left: the entry now exists.
    expect(errorTags(await second)).toEqual(['data-exists']);
    // Changes from outside NETCONF take the same queue.
    const p = await providersSession();
    const gate = deferred();
    await p.srv.provide('/providers-test:system', { prepare: (_, ctx) => (ctx.cause === 'edit' ? gate.promise : undefined) });
    const edit = send(p.c, editConfig('running', `<system xmlns="${PT}"><contact>edit</contact></system>`));
    await settle();
    const outside = p.srv.running.applyExternal({ 'providers-test:system': { contact: 'outside' } }, { source: 'backend' });
    gate.resolve();
    expect(isOk(await edit)).toBe(true);
    await outside;
    expect(await config(p.c, p.device)).toMatchObject({ 'providers-test:system': { contact: 'outside' } });
  });

  it('applies a write waiting behind a slow provider transaction when it finishes or times out', async () => {
    const clock = new ManualClock();
    const p = await providersSession({ clock });
    const other = await p.open();
    let slow = true;
    await p.srv.provide('/providers-test:system', { prepare: (_, ctx) => (ctx.cause === 'edit' && slow ? new Promise<void>(() => undefined) : undefined) });
    const first = send(p.c, editConfig('running', `<system xmlns="${PT}"><contact>first</contact></system>`));
    await settle();
    slow = false;
    const second = send(other, editConfig('running', `<system xmlns="${PT}"><contact>second</contact></system>`));
    await settle();
    clock.advance(10_000);
    expect(errorTags(await first)).toEqual(['operation-failed']);
    expect(isOk(await second)).toBe(true);
    expect(await config(p.c, p.device)).toMatchObject({ 'providers-test:system': { contact: 'second' } });
  });

  it('validates each write against the configuration the writes before it left', async () => {
    const { c, device, open } = await writesSession();
    const other = await open();
    const [a, b] = await Promise.all([
      send(c, editConfig('running', `<interfaces xmlns="${WT}"><interface><name>e2</name><type>t</type><address>10.9.9.9</address></interface></interfaces>`)),
      send(other, editConfig('running', `<interfaces xmlns="${WT}"><interface><name>e3</name><type>t</type><address>10.9.9.9</address></interface></interfaces>`)),
    ]);
    expect([isOk(a), errorTags(b)]).toEqual([true, ['operation-failed']]);
    const json = (await config(c, device)) as { 'writes-test:interfaces': { interface: { name: string }[] } };
    expect(json['writes-test:interfaces'].interface.map((i) => i.name)).toEqual(['eth0', 'e2']);
  });
});
