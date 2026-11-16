// WRITE-05: the validate operation (RFC 6241 §8.6, :validate:1.1).
import { describe, expect, it } from 'vitest';
import { config, editConfig, errorTags, isOk, send, WT, writesSession, writesVariant } from './writes-helpers.js';
import { iface, providersSession, recorder, type Call } from './providers-helpers.js';

const sys = (body: string): string => `<system xmlns="${WT}">${body}</system>`;

describe('WRITE-05 validate', () => {
  it('answers ok for a valid candidate or running, and every violation otherwise', async () => {
    const { c } = await writesSession();
    expect(isOk(await send(c, '<validate><source><running/></source></validate>'))).toBe(true);
    expect(isOk(await send(c, '<validate><source><candidate/></source></validate>'))).toBe(true);
    // Two violations put in the candidate with test-option set, which leaves validation for later.
    const bad = sys('<admin-interface>eth7</admin-interface><mtu>1400</mtu><min-mtu>1500</min-mtu>');
    expect(isOk(await send(c, editConfig('candidate', bad, '<test-option>set</test-option>')))).toBe(true);
    expect(errorTags(await send(c, '<validate><source><candidate/></source></validate>'))).toEqual(['operation-failed', 'data-missing']);
  });

  it('checks inline config without changing any datastore', async () => {
    const { c, device } = await writesSession();
    const before = await config(c, device);
    const ok = await send(c, `<validate><source><config>${sys('<hostname>inline</hostname>')}</config></source></validate>`);
    expect(isOk(ok)).toBe(true);
    const bad = await send(c, `<validate><source><config>${sys('<admin-interface>x</admin-interface>')}</config></source></validate>`);
    expect(errorTags(bad)).toEqual(['data-missing']);
    expect(await config(c, device)).toEqual(before);
    expect(await config(c, device, 'candidate')).toEqual(before);
  });

  it('never calls a provider’s prepare or commit', async () => {
    const p = await providersSession();
    const log: Call[] = [];
    await p.srv.provide('/providers-test:interfaces/interface', recorder('interfaces', log));
    log.length = 0;
    await send(p.c, editConfig('candidate', iface('eth0', '<mtu>1400</mtu>')));
    expect(isOk(await send(p.c, '<validate><source><candidate/></source></validate>'))).toBe(true);
    expect(isOk(await send(p.c, `<validate><source><config>${iface('eth3', '<mtu>1400</mtu>')}</config></source></validate>`))).toBe(true);
    expect(log).toEqual([]);
  });

  it('answers validate with operation-not-supported without :validate', async () => {
    const device = await writesVariant((d) => ({ ...d, capabilities: { ...d.capabilities, validate: false } }));
    const { c } = await writesSession({ device });
    expect(errorTags(await send(c, '<validate><source><running/></source></validate>'))).toEqual(['operation-not-supported']);
  });
});
