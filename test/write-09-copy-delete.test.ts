// WRITE-09: copy-config and delete-config (RFC 6241 §7.3, §7.4).
import { describe, expect, it } from 'vitest';
import { config, editConfig, errorTags, isOk, send, WT, writesSession } from './writes-helpers.js';
import { iface, providersSession, recorder, type Call } from './providers-helpers.js';

const sys = (body: string): string => `<system xmlns="${WT}">${body}</system>`;

describe('WRITE-09 copy-config and delete-config', () => {
  it('saves running as the start-up configuration with copy-config from running to startup', async () => {
    const { c, device } = await writesSession();
    await send(c, editConfig('running', sys('<hostname>saved</hostname>')));
    expect(isOk(await send(c, '<copy-config><target><startup/></target><source><running/></source></copy-config>'))).toBe(true);
    expect(await config(c, device, 'startup')).toEqual(await config(c, device));
  });

  it('replaces running or the candidate with inline config, validated first', async () => {
    const { c, device } = await writesSession();
    for (const target of ['running', 'candidate']) {
      const copy = `<copy-config><target><${target}/></target><source><config>${sys('<hostname>copied</hostname>')}</config></source></copy-config>`;
      expect(isOk(await send(c, copy)), target).toBe(true);
      expect(await config(c, device, target)).toEqual({ 'writes-test:system': { hostname: 'copied' } });
    }
    const bad = `<copy-config><target><running/></target><source><config>${sys('<admin-interface>x</admin-interface>')}</config></source></copy-config>`;
    expect(errorTags(await send(c, bad))).toEqual(['data-missing']);
    expect(await config(c, device)).toEqual({ 'writes-test:system': { hostname: 'copied' } });
  });

  it('runs copy-config to running through the provider transaction', async () => {
    const p = await providersSession();
    const log: Call[] = [];
    await p.srv.provide('/providers-test:interfaces/interface', recorder('interfaces', log));
    log.length = 0;
    const copy = `<copy-config><target><running/></target><source><config>${iface('eth0', '<mtu>1400</mtu>')}</config></source></copy-config>`;
    expect(isOk(await send(p.c, copy))).toBe(true);
    expect(log.map((l) => [l.hook, l.cause, l.changes?.map((ch) => `${ch.operation} ${ch.path}`)])).toEqual([
      ['prepare', 'copy', ["delete /providers-test:interfaces/interface[name='eth1']", "replace /providers-test:interfaces/interface[name='eth0']/mtu", "delete /providers-test:interfaces/interface[name='eth0']/enabled"]],
      ['commit', 'copy', undefined],
    ]);
  });

  it('empties startup with delete-config; delete-config of running gets operation-failed', async () => {
    const { c, device } = await writesSession();
    expect(isOk(await send(c, '<delete-config><target><startup/></target></delete-config>'))).toBe(true);
    expect(await config(c, device, 'startup')).toEqual({});
    expect(errorTags(await send(c, '<delete-config><target><running/></target></delete-config>'))).toEqual(['operation-failed']);
  });

  it('answers copy-config or delete-config of a datastore another session has locked with in-use', async () => {
    const { c, open } = await writesSession();
    const other = await open();
    await send(c, '<lock><target><startup/></target></lock>');
    expect(errorTags(await send(other, '<copy-config><target><startup/></target><source><running/></source></copy-config>'))).toEqual(['in-use']);
    expect(errorTags(await send(other, '<delete-config><target><startup/></target></delete-config>'))).toEqual(['in-use']);
  });

  it('answers a url source or target with operation-not-supported', async () => {
    const { c } = await writesSession();
    const replies = [
      await send(c, '<copy-config><target><url>file:///tmp/x</url></target><source><running/></source></copy-config>'),
      await send(c, '<copy-config><target><running/></target><source><url>file:///tmp/x</url></source></copy-config>'),
      await send(c, '<delete-config><target><url>file:///tmp/x</url></target></delete-config>'),
    ];
    // url is behind the :url feature, which this server doesn't implement, so the schema may refuse it first.
    for (const r of replies) expect(['operation-not-supported', 'unknown-element']).toContain(errorTags(r)[0]);
    expect(errorTags(replies[0]!)).toEqual(['operation-not-supported']);
  });
});
