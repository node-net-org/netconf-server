import { describe, expect, it } from 'vitest';
import type { XmlElement } from '@node-net/netconf/core';
import { DeviceError } from '../src/core.js';
import { createServer } from '../src/index.js';
import { config, editConfig, ManualClock, rpcErrors, send, settle } from './writes-helpers.js';
import { NC } from './helpers.js';
import { get, iface, PT, providersDevice, providersSession, recorder, type Call } from './providers-helpers.js';

const IF = '/providers-test:interfaces/interface';
const IFACES = `<interfaces xmlns="${PT}"/>`;
const never = (): Promise<never> => new Promise(() => undefined);
const severities = (reply: XmlElement): (string | undefined)[] => reply.childrenNamed('rpc-error', NC).map((e) => e.child('error-severity', NC)?.text());

/** Sends, then advances the clock once the request is waiting on a hook. */
async function sendAndAdvance(c: Parameters<typeof send>[0], body: string, clock: ManualClock, ms: number): Promise<XmlElement> {
  const reply = send(c, body);
  await settle();
  clock.advance(ms);
  return reply;
}

describe('PROVIDER-10 bound slow hooks with timeouts', () => {
  it('gives each hook a configurable timeout, 10 seconds by default for read and prepare', async () => {
    const clock = new ManualClock();
    const { srv, c } = await providersSession({ clock });
    await srv.provide(IF, { onRead: never, prepare: (_, ctx) => (ctx.cause === 'edit' ? never() : undefined) });
    await srv.provide('/providers-test:system/clock', { onRead: never, timeouts: { read: 250 } });

    let done = false;
    const read = send(c, get(IFACES)).then((r) => ((done = true), r));
    await settle();
    clock.advance(9999);
    await settle();
    expect(done).toBe(false);
    clock.advance(1);
    expect(severities(await read)).toEqual(['warning']);

    expect(severities(await sendAndAdvance(c, get(`<system xmlns="${PT}"/>`), clock, 250))).toEqual(['warning']);
    expect(rpcErrors(await sendAndAdvance(c, editConfig('running', iface('eth0', '<mtu>1400</mtu>')), clock, 10_000)).map((e) => e.tag)).toEqual(['operation-failed']);
  });

  it('serves the last data with a warning naming the provider when a read hook times out under stale', async () => {
    const clock = new ManualClock();
    const { srv, c } = await providersSession({ clock });
    let slow = false;
    await srv.provide(IF, {
      onRead: () => (slow ? never() : { 'providers-test:interfaces': { interface: [{ name: 'eth1', state: { 'oper-status': 'up' } }] } }),
    });
    await send(c, get(IFACES));
    slow = true;
    const reply = await sendAndAdvance(c, get(IFACES), clock, 10_000);
    const warning = rpcErrors(reply)[0]!;
    expect(severities(reply)).toEqual(['warning']);
    expect(warning.message).toContain(IF);
    expect(reply.child('data', NC)?.toString()).toContain('<oper-status>up</oper-status>');
  });

  it('fails the read with operation-failed when a read hook times out under error', async () => {
    const clock = new ManualClock();
    const { srv, c } = await providersSession({ clock });
    await srv.provide(IF, { onRead: never, onReadTimeout: 'error' });
    const reply = await sendAndAdvance(c, get(IFACES), clock, 10_000);
    expect(rpcErrors(reply).map((e) => e.tag)).toEqual(['operation-failed']);
    expect(severities(reply)).toEqual(['error']);
    expect(reply.child('data', NC)).toBeUndefined();
  });

  it('aborts the transaction with operation-failed when a prepare times out', async () => {
    const clock = new ManualClock();
    const { srv, c, device } = await providersSession({ clock });
    const log: Call[] = [];
    await srv.provide('/providers-test:routes', recorder('routes', log));
    await srv.provide(IF, { prepare: (_, ctx) => (ctx.cause === 'edit' ? never() : undefined) });
    const before = await config(c, device);
    log.length = 0;
    const edit = `${iface('eth0', '<mtu>1400</mtu>')}<routes xmlns="${PT}"><route><prefix>0/0</prefix><via>eth1</via></route></routes>`;
    const errors = rpcErrors(await sendAndAdvance(c, editConfig('running', edit), clock, 10_000));
    expect(errors.map((e) => e.tag)).toEqual(['operation-failed']);
    expect(errors[0]!.message).toContain(IF);
    expect(log.map((l) => l.hook)).toEqual(['prepare', 'abort']);
    expect(await config(c, device)).toEqual(before);
  });

  it('treats a commit that times out as a failed commit, and compensates', async () => {
    const clock = new ManualClock();
    const { srv, c, device } = await providersSession({ clock, providerTimeouts: { commit: 2000 } });
    const log: Call[] = [];
    await srv.provide('/providers-test:routes', recorder('routes', log));
    await srv.provide(IF, { prepare: (_, ctx) => (ctx.cause === 'edit' ? { commit: never } : undefined) });
    const before = await config(c, device);
    log.length = 0;
    const edit = `${iface('eth0', '<mtu>1400</mtu>')}<routes xmlns="${PT}"><route><prefix>0/0</prefix><via>eth1</via></route></routes>`;
    const errors = rpcErrors(await sendAndAdvance(c, editConfig('running', edit), clock, 2000));
    expect(errors.map((e) => e.tag)).toEqual(['operation-failed']);
    expect(errors[0]!.message).toContain('within 2000 ms');
    expect(log.filter((l) => l.cause === 'compensation').map((l) => l.hook)).toEqual(['prepare', 'commit']);
    expect(await config(c, device)).toEqual(before);
  });

  it('times hooks on the server’s injectable clock, load included', async () => {
    const clock = new ManualClock();
    const device = await providersDevice();
    const starting = createServer({ device, clock, providers: [{ path: IF, provider: { startup: 'adopt', load: never, timeouts: { load: 3000 } } }] });
    await settle();
    clock.advance(3000);
    const err = await starting.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceError);
    expect((err as DeviceError).message).toContain('within 3000 ms');
  });
});
