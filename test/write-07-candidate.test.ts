// WRITE-07: the candidate datastore with commit and discard-changes (RFC 6241 §8.3).
import { describe, expect, it } from 'vitest';
import { config, editConfig, errorTags, isOk, rpcErrors, send, WT, writesSession } from './writes-helpers.js';
import type { CommitEvent } from '../src/core.js';
import { iface, providersSession, recorder, type Call } from './providers-helpers.js';

const sys = (body: string): string => `<system xmlns="${WT}">${body}</system>`;

describe('WRITE-07 candidate, commit and discard-changes', () => {
  it('keeps edits to the candidate out of running until commit', async () => {
    const { c, device } = await writesSession();
    await send(c, editConfig('candidate', sys('<hostname>staged</hostname>')));
    expect(await config(c, device)).toMatchObject({ 'writes-test:system': { hostname: 'r1' } });
    expect(await config(c, device, 'candidate')).toMatchObject({ 'writes-test:system': { hostname: 'staged' } });
  });

  it('makes running equal to the candidate on commit, validated as a direct edit is', async () => {
    const { c, device, srv } = await writesSession();
    const commits: CommitEvent[] = [];
    srv.on('commit', (e) => commits.push(e));
    await send(c, editConfig('candidate', sys('<hostname>staged</hostname>')));
    expect(isOk(await send(c, '<commit/>'))).toBe(true);
    expect(await config(c, device)).toEqual(await config(c, device, 'candidate'));
    expect(await config(c, device)).toMatchObject({ 'writes-test:system': { hostname: 'staged' } });
    expect(commits.map((e) => e.cause)).toEqual(['commit']);
    // Through the same provider transaction as a direct edit.
    const p = await providersSession();
    const log: Call[] = [];
    await p.srv.provide('/providers-test:interfaces/interface', recorder('interfaces', log));
    log.length = 0;
    await send(p.c, editConfig('candidate', iface('eth0', '<mtu>1400</mtu>')));
    expect(isOk(await send(p.c, '<commit/>'))).toBe(true);
    expect(log.map((l) => `${l.hook}:${l.cause}`)).toEqual(['prepare:commit', 'commit:commit']);
  });

  it('leaves running and the candidate unchanged when a commit fails validation, and reports the errors', async () => {
    const { c, device } = await writesSession();
    await send(c, editConfig('candidate', sys('<admin-interface>eth7</admin-interface>'), '<test-option>set</test-option>'));
    const running = await config(c, device);
    const candidate = await config(c, device, 'candidate');
    expect(errorTags(await send(c, '<commit/>'))).toEqual(['data-missing']);
    expect(await config(c, device)).toEqual(running);
    expect(await config(c, device, 'candidate')).toEqual(candidate);
    // A provider refusing the commit: M3.
  });

  it('makes the candidate equal to running again on discard-changes', async () => {
    const { c, device } = await writesSession();
    await send(c, editConfig('candidate', sys('<hostname>staged</hostname>')));
    expect(isOk(await send(c, '<discard-changes/>'))).toBe(true);
    expect(await config(c, device, 'candidate')).toEqual(await config(c, device));
  });

  it('commits the candidate’s changes against running as it is at commit time, keeping later changes to running', async () => {
    const { c, device } = await writesSession();
    await send(c, editConfig('candidate', sys('<hostname>from-candidate</hostname>')));
    // Running changes directly after the candidate was edited.
    await send(c, editConfig('running', `<routing xmlns="${WT}"><route><prefix>10/8</prefix></route></routing>`));
    expect(isOk(await send(c, '<commit/>'))).toBe(true);
    expect(await config(c, device)).toMatchObject({
      'writes-test:system': { hostname: 'from-candidate' },
      'writes-test:routing': { route: [{ prefix: '10/8' }] },
    });
  });

  it('leaves running and the candidate unchanged when a provider refuses the commit, and reports its errors', async () => {
    const p = await providersSession();
    const refuse = (_: unknown, ctx: { cause: string }): Error | undefined => (ctx.cause === 'commit' ? new Error('MTU 1400 is not supported by the NIC') : undefined);
    await p.srv.provide('/providers-test:interfaces/interface', recorder('interfaces', [], { refuse }));
    const running = await config(p.c, p.device);
    await send(p.c, editConfig('candidate', iface('eth0', '<mtu>1400</mtu>')));
    const candidate = await config(p.c, p.device, 'candidate');
    const errors = rpcErrors(await send(p.c, '<commit/>'));
    expect(errors.map((e) => e.tag)).toEqual(['operation-failed']);
    expect(errors[0]!.message).toContain('MTU 1400 is not supported by the NIC');
    expect(await config(p.c, p.device)).toEqual(running);
    expect(await config(p.c, p.device, 'candidate')).toEqual(candidate);
  });
});
