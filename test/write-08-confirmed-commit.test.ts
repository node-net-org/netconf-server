// WRITE-08: confirmed-commit 1.1 (RFC 6241 §8.4), timed on the server's injectable clock.
import { describe, expect, it } from 'vitest';
import { config, editConfig, errorTags, isOk, ManualClock, send, settle, WT, writesSession } from './writes-helpers.js';
import { iface, providersSession, recorder, type Call } from './providers-helpers.js';

const sys = (body: string): string => `<system xmlns="${WT}">${body}</system>`;
const hostname = async (s: Awaited<ReturnType<typeof writesSession>>, c = s.c): Promise<unknown> =>
  ((await config(c, s.device)) as { 'writes-test:system': { hostname?: string } })['writes-test:system'].hostname;

async function confirmedSetup(): Promise<Awaited<ReturnType<typeof writesSession>> & { clock: ManualClock }> {
  const clock = new ManualClock();
  const s = await writesSession({ clock });
  return { ...s, clock };
}

describe('WRITE-08 confirmed commit', () => {
  it('applies the candidate and starts a timer of confirm-timeout seconds, 600 by default', async () => {
    const s = await confirmedSetup();
    await send(s.c, editConfig('candidate', sys('<hostname>trial</hostname>')));
    const timers = s.clock.pending;
    expect(isOk(await send(s.c, '<commit><confirmed/></commit>'))).toBe(true);
    expect(await hostname(s)).toBe('trial');
    expect(s.clock.pending).toBe(timers + 1);
    s.clock.advance(599_000);
    await settle();
    expect(await hostname(s)).toBe('trial');
    s.clock.advance(1_000);
    await settle();
    expect(await hostname(s)).toBe('r1');

    await send(s.c, editConfig('candidate', sys('<hostname>short</hostname>')));
    await send(s.c, '<commit><confirmed/><confirm-timeout>5</confirm-timeout></commit>');
    s.clock.advance(5_000);
    await settle();
    expect(await hostname(s)).toBe('r1');
  });

  it('makes the change permanent on a plain commit, and restarts the timer on a further confirmed commit', async () => {
    const s = await confirmedSetup();
    await send(s.c, editConfig('candidate', sys('<hostname>one</hostname>')));
    await send(s.c, '<commit><confirmed/><confirm-timeout>10</confirm-timeout></commit>');
    s.clock.advance(8_000);
    await send(s.c, editConfig('candidate', sys('<hostname>two</hostname>')));
    await send(s.c, '<commit><confirmed/><confirm-timeout>10</confirm-timeout></commit>');
    s.clock.advance(8_000);
    await settle();
    expect(await hostname(s)).toBe('two');
    expect(isOk(await send(s.c, '<commit/>'))).toBe(true);
    s.clock.advance(60_000);
    await settle();
    expect(await hostname(s)).toBe('two');
  });

  it('restores running to its configuration before the confirmed commit when the timer expires', async () => {
    const s = await confirmedSetup();
    await send(s.c, editConfig('candidate', sys('<hostname>one</hostname>')));
    await send(s.c, '<commit><confirmed/><confirm-timeout>10</confirm-timeout></commit>');
    // A follow-up confirmed commit inside the window rolls back too, to before the first.
    await send(s.c, editConfig('candidate', sys('<hostname>two</hostname>')));
    await send(s.c, '<commit><confirmed/><confirm-timeout>10</confirm-timeout></commit>');
    const events: string[] = [];
    s.srv.on('commit', (e) => events.push(e.cause));
    s.clock.advance(10_000);
    await settle();
    expect(await hostname(s)).toBe('r1');
    expect(events).toEqual(['rollback']);
  });

  it('rolls back through the providers when the timer expires', async () => {
    const clock = new ManualClock();
    const p = await providersSession({ clock });
    const log: Call[] = [];
    await p.srv.provide('/providers-test:interfaces/interface', recorder('interfaces', log));
    log.length = 0;
    await send(p.c, editConfig('candidate', iface('eth0', '<mtu>1400</mtu>')));
    await send(p.c, '<commit><confirmed/><confirm-timeout>10</confirm-timeout></commit>');
    clock.advance(10_000);
    await settle();
    expect(log.map((l) => [l.hook, l.cause, l.changes?.map((ch) => ch.path)])).toEqual([
      ['prepare', 'commit', ["/providers-test:interfaces/interface[name='eth0']/mtu"]],
      ['commit', 'commit', undefined],
      ['prepare', 'rollback', ["/providers-test:interfaces/interface[name='eth0']/mtu"]],
      ['commit', 'rollback', undefined],
    ]);
    expect(await config(p.c, p.device)).toMatchObject({ 'providers-test:interfaces': { interface: [{ name: 'eth0', mtu: 1500 }, { name: 'eth1' }] } });
  });

  it('rolls back at once on cancel-commit; with persist, only the matching persist-id confirms or cancels', async () => {
    const s = await confirmedSetup();
    await send(s.c, editConfig('candidate', sys('<hostname>one</hostname>')));
    await send(s.c, '<commit><confirmed/></commit>');
    expect(isOk(await send(s.c, '<cancel-commit/>'))).toBe(true);
    expect(await hostname(s)).toBe('r1');
    expect(errorTags(await send(s.c, '<cancel-commit/>'))).toEqual(['operation-failed']);

    await send(s.c, editConfig('candidate', sys('<hostname>kept</hostname>')));
    await send(s.c, '<commit><confirmed/><persist>tok</persist></commit>');
    const other = await s.open();
    expect(errorTags(await send(other, '<commit><persist-id>wrong</persist-id></commit>'))).toEqual(['invalid-value']);
    expect(errorTags(await send(other, '<cancel-commit><persist-id>wrong</persist-id></cancel-commit>'))).toEqual(['invalid-value']);
    expect(errorTags(await send(other, '<commit/>'))).toEqual(['invalid-value']);
    expect(isOk(await send(other, '<commit><persist-id>tok</persist-id></commit>'))).toBe(true);
    s.clock.advance(3_600_000);
    await settle();
    expect(await hostname(s)).toBe('kept');
  });

  it('rolls back a confirmed commit without persist when its session ends, but not one with persist', async () => {
    const s = await confirmedSetup();
    const committer = await s.open();
    await send(committer, editConfig('candidate', sys('<hostname>gone</hostname>')));
    await send(committer, '<commit><confirmed/></commit>');
    // Another session can't confirm it.
    expect(errorTags(await send(s.c, '<commit/>'))).toEqual(['operation-failed']);
    committer.connection.destroy();
    await s.c.until(() => s.srv.sessions.length === 1, 2000, 'the session to end');
    await settle();
    expect(await hostname(s)).toBe('r1');

    const persister = await s.open();
    await send(persister, editConfig('candidate', sys('<hostname>stays</hostname>')));
    await send(persister, '<commit><confirmed/><persist>p1</persist></commit>');
    persister.connection.destroy();
    await s.c.until(() => s.srv.sessions.length === 1, 2000, 'the session to end');
    await settle();
    expect(await hostname(s)).toBe('stays');
    expect(isOk(await send(s.c, '<commit><persist-id>p1</persist-id></commit>'))).toBe(true);
  });

  it('times the confirm on the injected clock, so tests advance time without waiting', async () => {
    const s = await confirmedSetup();
    await send(s.c, editConfig('candidate', sys('<hostname>quick</hostname>')));
    await send(s.c, '<commit><confirmed/><confirm-timeout>86400</confirm-timeout></commit>');
    const started = Date.now();
    s.clock.advance(86_400_000);
    await settle();
    expect(await hostname(s)).toBe('r1');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
