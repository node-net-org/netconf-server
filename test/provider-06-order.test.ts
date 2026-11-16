import { describe, expect, it } from 'vitest';
import { editConfig, send } from './writes-helpers.js';
import { iface, PT, providersSession, recorder, type Call } from './providers-helpers.js';

const IF = '/providers-test:interfaces/interface';
const ROUTES = '/providers-test:routes';
const SYSTEM = '/providers-test:system';
const all = `${iface('eth0', '<mtu>1400</mtu>')}<routes xmlns="${PT}"><route><prefix>0/0</prefix><via>eth1</via></route></routes><system xmlns="${PT}"><contact>noc</contact></system>`;
const commits = (log: Call[]): string[] => log.filter((l) => l.hook === 'commit' && l.cause === 'edit').map((l) => l.name);

describe('PROVIDER-06 order commits between providers', () => {
  it('commits in registration order by default', async () => {
    const { srv, c } = await providersSession();
    const log: Call[] = [];
    await srv.provide(ROUTES, recorder('routes', log));
    await srv.provide(SYSTEM, recorder('system', log));
    await srv.provide(IF, recorder('interfaces', log));
    await send(c, editConfig('running', all));
    expect(commits(log)).toEqual(['routes', 'system', 'interfaces']);
  });

  it('commits a provider after every provider it names in after', async () => {
    const { srv, c } = await providersSession();
    const log: Call[] = [];
    await srv.provide(ROUTES, recorder('routes', log, {}, { after: [IF, SYSTEM] }));
    await srv.provide(SYSTEM, recorder('system', log));
    await srv.provide(IF, recorder('interfaces', log));
    await send(c, editConfig('running', all));
    expect(commits(log)).toEqual(['system', 'interfaces', 'routes']);
  });

  it('rejects a cycle in the ordering at registration, naming the providers in it', async () => {
    const { srv } = await providersSession();
    await srv.provide(ROUTES, { after: [IF] });
    await srv.provide(SYSTEM, { after: [ROUTES] });
    await expect(srv.provide(IF, { after: [SYSTEM] })).rejects.toThrow(/cycle/);
    await expect(srv.provide(IF, { after: [SYSTEM] })).rejects.toThrow(new RegExp(`${IF}.*${SYSTEM}.*${ROUTES}|${SYSTEM}.*${ROUTES}.*${IF}|${ROUTES}.*${IF}.*${SYSTEM}`));
    expect(srv.providers.map((p) => p.path)).toEqual([ROUTES, SYSTEM]);
  });

  it('compensates after a failed commit in the reverse order', async () => {
    const { srv, c } = await providersSession();
    const log: Call[] = [];
    await srv.provide(ROUTES, recorder('routes', log));
    await srv.provide(SYSTEM, recorder('system', log));
    await srv.provide(IF, recorder('interfaces', log, { failCommit: (_, ctx) => (ctx.cause === 'edit' ? new Error('the NIC fell out') : undefined) }));
    log.length = 0;
    await send(c, editConfig('running', all));
    expect(log.filter((l) => l.cause === 'compensation' && l.hook === 'commit').map((l) => l.name)).toEqual(['system', 'routes']);
    expect(log.filter((l) => l.hook === 'abort').map((l) => l.name)).toEqual(['interfaces']);
  });
});
