// NACM-08: writes are checked on the changes they make (RFC 8341 §3.2.5–
// §3.2.8; NACM design §7.2), and a refusal fails the whole operation and
// reaches no provider. NACM-04: refused writes counted and reported.
import { describe, expect, it } from 'vitest';
import { NETCONF_NS } from '@node-net/netconf/core';
import { createServer, type AccessDeniedEvent } from '../src/core.js';
import { call, counters, denial, edit, errors, ok, open, policy, rule, server, top, W, WRITE_DEVICE, WRITE_SOURCE } from './nacm-write-helpers.js';
import { recordingLogger } from './ssh-helpers.js';

const ITEM = '/acme-w:top/item';
const ITEM_PATH = (name: string): string => `/acme-w:top/acme-w:item[acme-w:name='${name}']`;

describe('NACM-08 write access control', () => {
  it('AC1: a created node needs create access, a deleted one delete, a changed value update', async () => {
    const srv = await server(policy([rule('create-items', ITEM, 'create')]));
    const alice = await open(srv, 'alice');
    expect(ok(await call(alice, edit('running', '<item><name>b</name><colour>green</colour></item>')))).toBe(true);

    const update = denial(await call(alice, edit('running', '<item><name>a</name><colour>pink</colour></item>')));
    expect(update).toMatchObject({ tag: 'access-denied', type: 'application', path: `${ITEM_PATH('a')}/acme-w:colour` });

    const remove = denial(await call(alice, edit('running', '<item nc:operation="delete"><name>a</name></item>')));
    expect(remove).toMatchObject({ tag: 'access-denied', path: ITEM_PATH('a') });
    expect(await top(srv)).toContain('<colour>red</colour>');
    await srv.close();

    const srv2 = await server(policy([rule('items', ITEM, 'create update delete')]));
    const bob = await open(srv2, 'bob');
    expect(ok(await call(bob, edit('running', '<item><name>a</name><colour>pink</colour></item>')))).toBe(true);
    expect(ok(await call(bob, edit('running', '<item nc:operation="delete"><name>a</name></item>')))).toBe(true);
    expect(await top(srv2)).not.toContain('<name>a</name>');
    await srv2.close();
  });

  it('AC1: moving an entry of an ordered-by-user list needs update access', async () => {
    const move = edit('running', '<ordered nc:operation="merge" yang:insert="first"><name>y</name></ordered>');
    const srv = await server(policy([rule('ordered', '/acme-w:top/ordered', 'create delete')]));
    const alice = await open(srv, 'alice');
    expect(denial(await call(alice, move))).toMatchObject({ tag: 'access-denied', path: "/acme-w:top/acme-w:ordered[acme-w:name='y']" });
    await srv.close();

    const srv2 = await server(policy([rule('ordered', '/acme-w:top/ordered', 'update')]));
    const bob = await open(srv2, 'bob');
    expect(ok(await call(bob, move))).toBe(true);
    expect((await top(srv2)).indexOf('<name>y</name>')).toBeLessThan((await top(srv2)).indexOf('<name>x</name>'));
    await srv2.close();
  });

  it('AC2: nodes left as they were need no access: effective operation none, and unaltered merge and replace', async () => {
    // Alice may write nothing at all.
    const srv = await server(policy([]));
    const alice = await open(srv, 'alice');
    expect(ok(await call(alice, edit('running', '<item><name>a</name><colour>red</colour></item>')))).toBe(true);
    expect(ok(await call(alice, edit('running', '<item nc:operation="replace"><name>a</name><colour>red</colour></item>')))).toBe(true);
    expect(ok(await call(alice, edit('running', '<item><name>a</name></item>', '<default-operation>none</default-operation>')))).toBe(true);
    expect(ok(await call(alice, edit('running', '<speed>fast</speed>')))).toBe(true);
    expect(errors(await call(alice, edit('running', '<speed>slow</speed>')))).toHaveLength(1);
    await srv.close();
  });

  it('AC3: inside a created subtree, nacm:default-deny-write decides differently from the root', async () => {
    // No rule matches, so write-default permits the item and default-deny-write refuses its secret (§3.4.5 steps 10, 12).
    const srv = await server(policy([], { 'write-default': 'permit' }));
    const alice = await open(srv, 'alice');
    const reply = await call(alice, edit('running', '<item><name>c</name><secret><code>1234</code></secret></item>'));
    expect(denial(reply)).toMatchObject({ tag: 'access-denied', path: `${ITEM_PATH('c')}/acme-w:secret/acme-w:code` });
    expect(await top(srv)).not.toContain('<name>c</name>');
    // Without the secret, the same create is permitted.
    expect(ok(await call(alice, edit('running', '<item><name>c</name><colour>grey</colour></item>')))).toBe(true);
    await srv.close();
    // A rule that matches the item matches its secret too, and decides before default-deny-write does (§3.4.5 step 7).
    const srv2 = await server(policy([rule('create-items', ITEM, 'create')]));
    expect(ok(await call(await open(srv2, 'alice'), edit('running', '<item><name>c</name><secret><code>1234</code></secret></item>')))).toBe(true);
    await srv2.close();
  });

  it('AC3: a non-presence container appearing or going with its children needs no access of its own', async () => {
    const srv = await server(policy([rule('items', ITEM, 'create delete')]), {}, {});
    const alice = await open(srv, 'alice');
    expect(ok(await call(alice, edit('running', '<item><name>first</name></item>')))).toBe(true);
    expect(await top(srv)).toContain('<name>first</name>');
    expect(ok(await call(alice, edit('running', '<item nc:operation="delete"><name>first</name></item>')))).toBe(true);
    expect(await top(srv)).toBe('');
    // A child it may not create still refuses the whole create.
    expect(denial(await call(alice, edit('running', '<speed>slow</speed>'))).path).toBe('/acme-w:top/acme-w:speed');
    await srv.close();
  });

  it('AC3: inside a created subtree, a keyed rule on a descendant decides differently', async () => {
    const srv = await server(policy([rule('no-x-colour', "/acme-w:top/item[name='x']/colour", 'create', 'deny'), rule('create-items', ITEM, 'create')]));
    const alice = await open(srv, 'alice');
    expect(denial(await call(alice, edit('running', '<item><name>x</name><colour>red</colour></item>')))).toMatchObject({ path: `${ITEM_PATH('x')}/acme-w:colour` });
    expect(ok(await call(alice, edit('running', '<item><name>y</name><colour>red</colour></item>')))).toBe(true);
    // A keyed rule on the entry itself.
    expect(ok(await call(alice, edit('running', '<item><name>x</name></item>')))).toBe(true);
    await srv.close();
    const srv2 = await server(policy([rule('no-bad', "/acme-w:top/item[name='bad']", 'create', 'deny'), rule('create-items', ITEM, 'create')]));
    const bob = await open(srv2, 'bob');
    expect(denial(await call(bob, edit('running', '<item><name>bad</name></item>')))).toMatchObject({ path: ITEM_PATH('bad') });
    expect(ok(await call(bob, edit('running', '<item><name>good</name></item>')))).toBe(true);
    await srv2.close();
  });

  it('AC3: inside a created subtree, a node of another module is decided by module rules for its own module', async () => {
    const srv = await server(policy([{ name: 'acme-w', 'module-name': 'acme-w', 'access-operations': 'create', action: 'permit' }]));
    const alice = await open(srv, 'alice');
    const withExtra = '<item><name>d</name><extra xmlns="urn:example:w-aug">e</extra></item>';
    const reply = await call(alice, edit('running', withExtra));
    expect(denial(reply).path).toBe(`${ITEM_PATH('d')}/acme-w-aug:extra`);
    expect(ok(await call(alice, edit('running', '<item><name>d</name></item>')))).toBe(true);
    await srv.close();
  });

  it('AC3: nacm:default-deny-all needs an explicit rule to write, even with write-default permit', async () => {
    const write = edit('running', '<guarded><value>v</value></guarded>');
    const srv = await server(policy([], { 'write-default': 'permit' }));
    const alice = await open(srv, 'alice');
    expect(ok(await call(alice, edit('running', '<speed>slow</speed>')))).toBe(true);
    expect(denial(await call(alice, write)).tag).toBe('access-denied');
    await srv.close();
    const srv2 = await server(policy([rule('guarded', '/acme-w:top/guarded', '*')], { 'write-default': 'permit' }));
    expect(ok(await call(await open(srv2, 'alice'), write))).toBe(true);
    await srv2.close();
  });

  it('AC3: a deleted subtree is checked inside too', async () => {
    // Deleting an item whose secret exists needs delete on the secret's code, which default-deny-write refuses.
    const srv = await server(policy([], { 'write-default': 'permit' }), {}, { 'acme-w:top': { item: [{ name: 's', secret: { code: '1' } }] } });
    const alice = await open(srv, 'alice');
    expect(denial(await call(alice, edit('running', '<item nc:operation="delete"><name>s</name></item>'))).path).toBe(`${ITEM_PATH('s')}/acme-w:secret/acme-w:code`);
    await srv.close();
  });

  it('AC4: a change the edit makes implicitly, choosing another case of a choice, is checked too (a known deviation)', async () => {
    // Alice may create manual but not delete auto; choosing manual deletes auto implicitly.
    const srv = await server(policy([rule('manual', '/acme-w:top/manual', 'create')]), {}, { 'acme-w:top': { auto: [null] } });
    const alice = await open(srv, 'alice');
    expect(denial(await call(alice, edit('running', '<manual>m</manual>')))).toMatchObject({ tag: 'access-denied', path: '/acme-w:top/acme-w:auto' });
    await srv.close();
    const srv2 = await server(policy([rule('manual', '/acme-w:top/manual', 'create'), rule('auto', '/acme-w:top/auto', 'delete')]), {}, { 'acme-w:top': { auto: [null] } });
    expect(ok(await call(await open(srv2, 'alice'), edit('running', '<manual>m</manual>')))).toBe(true);
    expect(await top(srv2)).toContain('<manual>m</manual>');
    await srv2.close();
  });

  it('AC5: edit-config and edit-data are checked against their target, running or the candidate', async () => {
    const srv = await server(policy([]));
    const alice = await open(srv, 'alice');
    expect(denial(await call(alice, edit('candidate', '<speed>slow</speed>'))).tag).toBe('access-denied');
    expect(await top(srv, 'candidate')).toContain('<speed>fast</speed>');
    const editData = (ds: string): string =>
      `<edit-data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda" xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores"><datastore>ds:${ds}</datastore><config><top xmlns="${W}"><speed>slow</speed></top></config></edit-data>`;
    expect(denial(await call(alice, editData('running'))).tag).toBe('access-denied');
    expect(denial(await call(alice, editData('candidate'))).tag).toBe('access-denied');
    expect(await top(srv)).toContain('<speed>fast</speed>');
    expect(ok(await call(await open(srv, 'admin'), editData('running')))).toBe(true);
    expect(await top(srv)).toContain('<speed>slow</speed>');
    await srv.close();
  });

  it("AC6: commit needs access to everything it changes in running, whoever edited the candidate", async () => {
    const srv = await server(policy([rule('speed', '/acme-w:top/speed', '*')]));
    const admin = await open(srv, 'admin');
    const alice = await open(srv, 'alice');
    expect(ok(await call(admin, edit('candidate', '<speed>slow</speed><item><name>n</name></item>')))).toBe(true);
    // Alice may change the speed but not create items, so she may not commit admin's item.
    const refused = denial(await call(alice, '<commit/>'));
    expect(refused).toMatchObject({ tag: 'access-denied', type: 'application', path: ITEM_PATH('n') });
    expect(await top(srv)).toContain('<speed>fast</speed>');
    expect(await top(srv, 'candidate')).toContain('<name>n</name>');
    expect(ok(await call(admin, '<commit/>'))).toBe(true);
    expect(await top(srv)).toContain('<speed>slow</speed>');
    await srv.close();
  });

  it('AC6: a candidate change alice may make herself, she may commit', async () => {
    const srv = await server(policy([rule('speed', '/acme-w:top/speed', '*')]));
    const alice = await open(srv, 'alice');
    expect(ok(await call(alice, edit('candidate', '<speed>slow</speed>')))).toBe(true);
    expect(ok(await call(alice, '<commit/>'))).toBe(true);
    expect(await top(srv)).toContain('<speed>slow</speed>');
    await srv.close();
  });

  it('AC7: copy-config from running to startup needs only exec access; other copies are checked on what they change', async () => {
    const srv = await server(policy([]));
    const guest = await open(srv, 'guest');
    expect(ok(await call(guest, '<copy-config><target><startup/></target><source><running/></source></copy-config>'))).toBe(true);
    expect(await top(srv, 'startup')).toContain('<speed>fast</speed>');
    // Inline configuration to startup and to running: changes, so refused.
    const inline = (target: string): string => `<copy-config><target><${target}/></target><source><config><top xmlns="${W}"><speed>slow</speed></top></config></source></copy-config>`;
    expect(denial(await call(guest, inline('startup'))).tag).toBe('access-denied');
    expect(denial(await call(guest, inline('running'))).tag).toBe('access-denied');
    expect(await top(srv, 'startup')).toContain('<speed>fast</speed>');
    // The candidate to running: admin edits the candidate, guest may not copy it into running.
    const admin = await open(srv, 'admin');
    expect(ok(await call(admin, edit('candidate', '<speed>slow</speed>')))).toBe(true);
    expect(denial(await call(guest, '<copy-config><target><running/></target><source><candidate/></source></copy-config>')).tag).toBe('access-denied');
    expect(ok(await call(admin, '<copy-config><target><running/></target><source><candidate/></source></copy-config>'))).toBe(true);
    expect(await top(srv)).toContain('<speed>slow</speed>');
    await srv.close();
  });

  it('AC8: delete-config, discard-changes and cancel-commit are not checked as writes', async () => {
    const srv = await server(policy([{ name: 'exec', 'module-name': 'ietf-netconf', 'access-operations': 'exec', action: 'permit' }]));
    const admin = await open(srv, 'admin');
    const alice = await open(srv, 'alice');
    expect(ok(await call(admin, edit('candidate', '<speed>slow</speed>')))).toBe(true);
    expect(ok(await call(alice, '<discard-changes/>'))).toBe(true);
    expect(await top(srv, 'candidate')).toContain('<speed>fast</speed>');
    expect(ok(await call(admin, edit('candidate', '<speed>slow</speed>')))).toBe(true);
    expect(ok(await call(admin, '<commit><confirmed/><persist>p</persist></commit>'))).toBe(true);
    expect(ok(await call(alice, '<cancel-commit><persist-id>p</persist-id></cancel-commit>'))).toBe(true);
    expect(await top(srv)).toContain('<speed>fast</speed>');
    // delete-config needs only exec access, which the rule above grants.
    expect(ok(await call(alice, '<delete-config><target><startup/></target></delete-config>'))).toBe(true);
    await srv.close();
  });

  it('AC8: changes the server makes itself are not checked', async () => {
    const srv = await server(policy([]));
    await srv.running.applyExternal({ 'acme-w:top': { speed: 'external' } }, { source: 'backend' });
    expect(await top(srv)).toContain('<speed>external</speed>');
    await srv.close();
  });

  it('AC9: a refused write changes nothing and reaches no provider', async () => {
    const srv = await server(policy([rule('speed', '/acme-w:top/speed', '*')]));
    const prepared: string[] = [];
    await srv.provide('/acme-w:top', { prepare: (changes) => void prepared.push(...changes.map((c) => c.path)) });
    // Registering pushed the existing subtree to the provider.
    prepared.length = 0;
    const alice = await open(srv, 'alice');
    expect(denial(await call(alice, edit('running', '<speed>slow</speed><item><name>q</name></item>'))).tag).toBe('access-denied');
    expect(prepared).toEqual([]);
    expect(await top(srv)).toContain('<speed>fast</speed>');
    expect(ok(await call(alice, edit('running', '<speed>slow</speed>')))).toBe(true);
    expect(prepared).toEqual(['/acme-w:top/speed']);
    await srv.close();
  });

  it('AC9: one access-denied, for the first refused node in document order', async () => {
    const srv = await server(policy([]));
    const alice = await open(srv, 'alice');
    const reply = await call(alice, edit('running', '<speed>slow</speed><item><name>a</name><colour>pink</colour></item><item><name>z</name></item>'));
    expect(denial(reply).path).toBe('/acme-w:top/acme-w:speed');
    await srv.close();
  });

  it("AC10: the error-path is cut back to the deepest ancestor the user may read", async () => {
    const srv = await server(policy([rule('no-hidden', "/acme-w:top/item[name='hidden']", '*', 'deny'), rule('items', ITEM, '*')]));
    const alice = await open(srv, 'alice');
    const refused = denial(await call(alice, edit('running', '<item nc:operation="delete"><name>hidden</name></item>')));
    expect(refused).toMatchObject({ tag: 'access-denied', type: 'application', path: '/acme-w:top', message: 'Access is denied' });
    // A readable refused node keeps its full path.
    const srv2 = await server(policy([rule('items', ITEM, 'read')]));
    expect(denial(await call(await open(srv2, 'alice'), edit('running', '<item nc:operation="delete"><name>a</name></item>'))).path).toBe(ITEM_PATH('a'));
    await srv.close();
    await srv2.close();
  });

  it('AC11: a refused write fails the whole operation, even under continue-on-error', async () => {
    const srv = await server(policy([rule('speed', '/acme-w:top/speed', '*')]));
    const alice = await open(srv, 'alice');
    // Creating item a fails (data-exists) and continue-on-error goes on; speed is permitted, item z is refused: nothing is applied.
    const body = edit('running', '<item nc:operation="create"><name>a</name></item><speed>slow</speed><item><name>z</name></item>', '<error-option>continue-on-error</error-option>');
    expect(denial(await call(alice, body))).toMatchObject({ tag: 'access-denied', path: ITEM_PATH('z') });
    const now = await top(srv);
    expect(now).toContain('<speed>fast</speed>');
    expect(now).not.toContain('<name>z</name>');
    // Without the refused part, continue-on-error applies the rest and reports the failed part.
    const rest = await call(alice, edit('running', '<item nc:operation="create"><name>a</name></item><speed>slow</speed>', '<error-option>continue-on-error</error-option>'));
    expect(denial(rest).tag).toBe('data-exists');
    expect(await top(srv)).toContain('<speed>slow</speed>');
    await srv.close();
  });

  it('AC12: each refused write counts once in denied-data-writes, raises accessDenied and is logged', async () => {
    const { logger, entries } = recordingLogger();
    const srv = await server(policy([]), { logger });
    const events: AccessDeniedEvent[] = [];
    srv.on('accessDenied', (e) => events.push(e));
    const alice = await open(srv, 'alice');
    // Three refused nodes, one refused operation.
    await call(alice, edit('running', '<speed>slow</speed><item><name>m</name></item><item><name>o</name></item>'));
    expect(await counters(srv)).toMatchObject({ 'denied-data-writes': '1', 'denied-operations': '0' });
    const sessionId = srv.sessions.find((s) => s.username === 'alice')!.id;
    expect(events).toEqual([{ sessionId, username: 'alice', kind: 'write', path: '/acme-w:top/speed' }]);
    expect(entries.filter((l) => l.message === 'Access denied')[0]!.context).toMatchObject({ sessionId, username: 'alice', write: 'update', path: '/acme-w:top/speed' });
    await srv.close();
  });

  it('AC13: recovery sessions, enable-nacm false and devices without ietf-netconf-acm write as before', async () => {
    const write = edit('running', '<speed>slow</speed><guarded><value>v</value></guarded>');
    const srv = await server(policy([]));
    expect(ok(await call(await open(srv, 'recovery'), write))).toBe(true);
    await srv.close();
    const off = await server(policy([], { 'enable-nacm': false }));
    expect(ok(await call(await open(off, 'alice'), write))).toBe(true);
    await off.close();
    const plain = await createServer({ device: { ...WRITE_DEVICE, id: 'plain', yang: { modules: ['acme-w', 'acme-w-aug'] } }, source: WRITE_SOURCE, control: { enabled: false } });
    const reply = await call(await open(plain, 'alice'), write);
    expect(reply.child('ok', NETCONF_NS)).toBeDefined();
    await plain.close();
  });
});
