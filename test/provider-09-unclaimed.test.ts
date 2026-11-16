import { describe, expect, it } from 'vitest';
import { config, editConfig, errorTags, isOk, rpcErrors, send } from './writes-helpers.js';
import { iface, PT, providersSession, recorder, type Call } from './providers-helpers.js';

const IF = '/providers-test:interfaces/interface';

describe('PROVIDER-09 reject configuration no provider applies', () => {
  it('stores unclaimed configuration like any other under the store policy (the default)', async () => {
    const { srv, c, device } = await providersSession();
    await srv.provide(IF, {});
    expect(isOk(await send(c, editConfig('running', `<system xmlns="${PT}"><contact>noc</contact></system>`)))).toBe(true);
    expect(await config(c, device)).toMatchObject({ 'providers-test:system': { contact: 'noc' } });
  });

  it('answers operation-not-supported naming the path under reject, and applies nothing', async () => {
    const { srv, c, device } = await providersSession({ unclaimed: 'reject' });
    const log: Call[] = [];
    await srv.provide(IF, recorder('interfaces', log));
    const before = await config(c, device);
    log.length = 0;
    const reply = await send(c, editConfig('running', `${iface('eth0', '<mtu>1400</mtu>')}<system xmlns="${PT}"><contact>noc</contact></system>`));
    const errors = rpcErrors(reply);
    expect(errors.map((e) => [e.tag, e.path])).toEqual([['operation-not-supported', '/providers-test:system/providers-test:contact']]);
    expect(log).toEqual([]);
    expect(await config(c, device)).toEqual(before);
    // Claimed configuration alone is fine.
    expect(isOk(await send(c, editConfig('running', iface('eth0', '<mtu>1400</mtu>'))))).toBe(true);
  });

  it('accepts edits to the candidate under reject, and rejects the commit that would apply unclaimed changes', async () => {
    const { srv, c, device } = await providersSession({ unclaimed: 'reject' });
    await srv.provide(IF, {});
    expect(isOk(await send(c, editConfig('candidate', `<system xmlns="${PT}"><contact>noc</contact></system>`)))).toBe(true);
    expect(errorTags(await send(c, '<commit/>'))).toEqual(['operation-not-supported']);
    expect(await config(c, device, 'candidate')).toMatchObject({ 'providers-test:system': { contact: 'noc' } });
    expect(await config(c, device)).not.toMatchObject({ 'providers-test:system': { contact: 'noc' } });
  });

  it('answers unknown-element for a node removed with deviate not-supported, whatever the policy', async () => {
    for (const unclaimed of ['store', 'reject'] as const) {
      const { c } = await providersSession({ unclaimed });
      const reply = await send(c, editConfig('running', `<extra xmlns="${PT}"><unsupported>x</unsupported></extra>`));
      expect(errorTags(reply)).toEqual(['unknown-element']);
    }
  });
});
