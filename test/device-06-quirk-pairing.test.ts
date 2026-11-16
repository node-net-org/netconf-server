// DEVICE-06: prove every client tolerance has a matching server quirk.

import { connect, defineDeviceProfile, RpcError, type NetconfClient, type Quirks } from '@node-net/netconf';
import { QUIRK_NAMES as CLIENT_QUIRK_NAMES } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { QUIRKS, systemClock } from '../src/core.js';
import { notifySession } from './notify-helpers.js';

const NAMESPACES = { 'notif-test': 'urn:example:notif' };

/** A server whose sessions all have one quirk, and a way to connect @node-net/netconf with or without a tolerance. */
async function paired(quirk: string, settings: unknown = true): Promise<{ client: (quirks?: Quirks, extra?: { rpcTimeout?: number }) => Promise<NetconfClient>; srv: Awaited<ReturnType<typeof notifySession>>['srv'] }> {
  const { srv } = await notifySession({ control: { enabled: true } });
  srv.control!.setQuirk(quirk, settings);
  return {
    srv,
    client: (quirks = {}, extra = {}) =>
      connect({
        transport: srv.transport(),
        profile: defineDeviceProfile({ id: 'paired', quirks }),
        namespaces: NAMESPACES,
        ...(extra.rpcTimeout === undefined ? {} : { timeouts: { rpc: extra.rpcTimeout } }),
      }),
  };
}

const failsOrHangs = async (p: Promise<unknown>, ms: number): Promise<'failed' | 'hung' | 'ok'> =>
  Promise.race([p.then(() => 'ok' as const, () => 'failed' as const), new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);

describe('DEVICE-06 prove every client tolerance has a matching server quirk', () => {
  it('AC1: each server quirk names the @node-net/netconf client quirk it exercises', () => {
    const client = new Set<string>(CLIENT_QUIRK_NAMES);
    for (const q of QUIRKS) for (const name of q.exercises) expect(client, `${q.name} exercises ${name}`).toContain(name);
    // A quirk that exercises no client quirk is kept for interop references only, and says so.
    expect(QUIRKS.filter((q) => q.exercises.length === 0).map((q) => q.name)).toEqual(['candidateUnvalidated']);
  });

  it('AC2: a test fails when a @node-net/netconf client quirk has no server quirk naming it', () => {
    const exercised = new Set(QUIRKS.flatMap((q) => q.exercises));
    const missing = CLIENT_QUIRK_NAMES.filter((name) => !exercised.has(name));
    expect(missing, 'client quirks with no server quirk').toEqual([]);
  });

  describe('AC3: without the tolerance the client fails; with it the session copes', () => {
    it('replyWithoutMessageId', async () => {
      const { client } = await paired('replyWithoutMessageId', { replies: 'all' });
      const strict = await client({}, { rpcTimeout: 300 });
      expect(await failsOrHangs(strict.ops.getConfig(), 1000)).toBe('failed');
      const tolerant = await client({ replyWithoutMessageId: 'oldest' });
      await expect(tolerant.ops.getConfig()).resolves.toBeDefined();
      await tolerant.close();
    });

    it('invalidXmlChars', async () => {
      const { client } = await paired('invalidXmlChars');
      // A lock held elsewhere makes every lock below fail with an rpc-error.
      const holder = await client({ invalidXmlChars: 'strip' });
      await holder.ops.lock('running');
      const strict = await client();
      const err = await strict.ops.lock('running').catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(RpcError);
      const tolerant = await client({ invalidXmlChars: 'strip' });
      const typed = await tolerant.ops.lock('running').catch((e: unknown) => e);
      expect(typed).toBeInstanceOf(RpcError);
      expect((typed as RpcError).errors[0]!.tag).toBe('lock-denied');
      await tolerant.close();
      await holder.close();
    });

    it('paddedEmptyElements', async () => {
      const { srv, client } = await paired('paddedEmptyElements');
      await srv.running.applyExternal({ 'notif-test:servers': { server: [{ name: 'p', description: '' }] } }, { source: 'test' });
      const description = async (c: NetconfClient): Promise<string | undefined> => {
        const data = await c.ops.getConfig();
        const p = data.elements[0]!.elements.find((e) => e.elements.find((k) => k.name === 'name')?.text() === 'p')!;
        return p.elements.find((e) => e.name === 'description')?.text();
      };
      const keep = await client();
      expect(await description(keep)).toMatch(/^\n +$/);
      const strip = await client({ paddedEmptyElements: 'strip' });
      expect(await description(strip)).toBe('');
      await keep.close();
      await strip.close();
    });

    it('forceBaseVersion', async () => {
      const { client } = await paired('chunkedFramingBroken');
      const chunked = await client();
      expect(await failsOrHangs(chunked.ops.getConfig(), 1000)).toBe('failed');
      const eom = await client({ forceBaseVersion: '1.0' });
      await expect(eom.ops.getConfig()).resolves.toBeDefined();
      await eom.close();
    });

    it('maxInFlight', async () => {
      const { srv } = await notifySession({ clock: systemClock, control: { enabled: true } });
      srv.control!.setQuirk('noPipelining', true);
      const connectWith = (quirks: Quirks): Promise<NetconfClient> => connect({ transport: srv.transport(), profile: defineDeviceProfile({ id: 'paired', quirks }), namespaces: NAMESPACES });
      // The first request is answered slowly, so the others arrive while it is in progress.
      const slowFirst = (): void => void srv.control!.injectFault({ target: { kind: 'user', username: 'local' }, action: { kind: 'delay', ms: 50 } });
      const pipelined = await connectWith({});
      slowFirst();
      const results = await Promise.allSettled([pipelined.ops.getConfig(), pipelined.ops.getConfig(), pipelined.ops.getConfig()]);
      expect(results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as unknown)).toEqual([expect.any(RpcError), expect.any(RpcError)]);
      const serial = await connectWith({ maxInFlight: 1 });
      slowFirst();
      const ok = await Promise.allSettled([serial.ops.getConfig(), serial.ops.getConfig(), serial.ops.getConfig()]);
      expect(ok.every((r) => r.status === 'fulfilled')).toBe(true);
      await serial.close();
    });

    it('closeTimeout', async () => {
      const { client } = await paired('slowCloseSession');
      const patient = await client();
      expect(await failsOrHangs(patient.close(), 500)).toBe('hung');
      const brief = await client({ closeTimeout: 50 });
      expect(await failsOrHangs(brief.close(), 500)).toBe('ok');
    });

    it('subtreeFilter and subtreeFilterDepth', async () => {
      const { client } = await paired('subtreeFilterLimit', { depth: 2, message: 'Leaf element specified which is not a key' });
      const path = "/notif-test:servers/server[name='a']/port";
      const full = await client();
      const err = await full.content.readValue(path, { format: 'xml' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).errors[0]!.message).toBe('Leaf element specified which is not a key');
      const cut = await client({ subtreeFilter: 'containers', subtreeFilterDepth: 2 });
      expect(await cut.content.readValue(path, { format: 'xml' })).toBe('8080');
      await full.close();
      await cut.close();
    });
  });
});
