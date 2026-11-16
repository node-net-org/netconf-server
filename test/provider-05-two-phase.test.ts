import { describe, expect, it } from 'vitest';
import { RpcFailure } from '../src/core.js';
import { config, editConfig, errorTags, isOk, rpcErrors, send, settle } from './writes-helpers.js';
import { deferred, iface, PT, providersSession, recorder, type Call } from './providers-helpers.js';

const IF = '/providers-test:interfaces/interface';
const ROUTES = '/providers-test:routes';
const both = `${iface('eth0', '<mtu>1400</mtu>')}<routes xmlns="${PT}"><route><prefix>0/0</prefix><via>eth1</via></route></routes>`;

describe('PROVIDER-05 apply committed changes to a backend in two phases', () => {
  it('gives each provider whose subtree changed only its own changes, once, after the whole result validated', async () => {
    const { srv, c } = await providersSession();
    const log: Call[] = [];
    await srv.provide(IF, recorder('interfaces', log));
    await srv.provide(ROUTES, recorder('routes', log));
    log.length = 0;
    expect(isOk(await send(c, editConfig('running', both)))).toBe(true);
    expect(log.filter((l) => l.hook === 'prepare')).toEqual([
      { hook: 'prepare', name: 'interfaces', cause: 'edit', changes: [{ operation: 'replace', path: `${IF}[name='eth0']/mtu` }] },
      { hook: 'prepare', name: 'routes', cause: 'edit', changes: [{ operation: 'create', path: `${ROUTES}/route[prefix='0/0']` }] },
    ]);
    // A result that fails validation reaches no provider.
    log.length = 0;
    const bad = `${iface('eth0', '<mtu>1300</mtu>')}<routes xmlns="${PT}"><route><prefix>1/1</prefix><via>eth7</via></route></routes>`;
    expect(errorTags(await send(c, editConfig('running', bad)))).toEqual(['data-missing']);
    expect(log).toEqual([]);
  });

  it('runs the prepare hooks of the providers involved at once', async () => {
    const { srv, c } = await providersSession();
    const gate = deferred();
    const started: string[] = [];
    // Hold only the edit's prepare: provide() pushes the existing configuration through prepare too.
    const holding = (name: string) => ({
      prepare: async (_: unknown, ctx: { cause: string }) => {
        if (ctx.cause !== 'edit') return;
        started.push(name);
        await gate.promise;
      },
    });
    await srv.provide(IF, holding('interfaces'));
    await srv.provide(ROUTES, holding('routes'));
    const reply = send(c, editConfig('running', both));
    await settle();
    expect(started).toEqual(['interfaces', 'routes']);
    gate.resolve();
    expect(isOk(await reply)).toBe(true);
  });

  it('sends a refusal’s errors to the client, aborts every provider that prepared, and leaves running unchanged', async () => {
    const { srv, c, device } = await providersSession();
    const log: Call[] = [];
    await srv.provide(IF, recorder('interfaces', log));
    await srv.provide(ROUTES, recorder('routes', log, { refuse: (_, ctx) => ctx.cause !== 'edit' ? undefined : new RpcFailure({ type: 'application', tag: 'resource-denied', appTag: 'no-route-table', message: 'The route table is full' }) }));
    const before = await config(c, device);
    log.length = 0;
    const errors = rpcErrors(await send(c, editConfig('running', both)));
    expect(errors.map((e) => [e.tag, e.appTag, e.message])).toEqual([['resource-denied', 'no-route-table', 'The route table is full']]);
    expect(log.map((l) => `${l.hook}:${l.name}`)).toEqual(['prepare:interfaces', 'prepare:routes', 'abort:interfaces']);
    expect(await config(c, device)).toEqual(before);
  });

  it('commits every provider when all prepared, then updates running and reports the commit', async () => {
    const { srv, c, device } = await providersSession();
    const log: Call[] = [];
    await srv.provide(IF, recorder('interfaces', log));
    await srv.provide(ROUTES, recorder('routes', log));
    log.length = 0;
    srv.on('commit', () => log.push({ hook: 'commit', name: 'event' }));
    expect(isOk(await send(c, editConfig('running', both)))).toBe(true);
    expect(log.map((l) => `${l.hook}:${l.name}`)).toEqual(['prepare:interfaces', 'prepare:routes', 'commit:interfaces', 'commit:routes', 'commit:event']);
    expect(await config(c, device)).toMatchObject({ 'providers-test:routes': { route: [{ prefix: '10.0.0.0/8' }, { prefix: '0/0' }] } });
  });

  it('does not call providers whose subtree didn’t change', async () => {
    const { srv, c } = await providersSession();
    const log: Call[] = [];
    await srv.provide(IF, recorder('interfaces', log));
    await srv.provide(ROUTES, recorder('routes', log));
    log.length = 0;
    expect(isOk(await send(c, editConfig('running', iface('eth1', '<enabled>true</enabled>'))))).toBe(true);
    expect(log.map((l) => l.name)).toEqual(['interfaces', 'interfaces']);
  });

  it('never calls providers for edits to the candidate, only for its commit', async () => {
    const { srv, c } = await providersSession();
    const log: Call[] = [];
    await srv.provide(IF, recorder('interfaces', log));
    log.length = 0;
    expect(isOk(await send(c, editConfig('candidate', iface('eth0', '<mtu>1400</mtu>'))))).toBe(true);
    expect(isOk(await send(c, editConfig('candidate', iface('eth1', '<mtu>1400</mtu>'))))).toBe(true);
    expect(log).toEqual([]);
    expect(isOk(await send(c, '<commit/>'))).toBe(true);
    expect(log.map((l) => [l.hook, l.cause, l.changes?.length])).toEqual([
      ['prepare', 'commit', 2],
      ['commit', 'commit', undefined],
    ]);
  });
});
