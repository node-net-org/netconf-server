// NACM-10: a subscription receives only the notifications its user may
// receive (RFC 8341 §3.4.6, NACM design §8), and netconf-config-change
// only the edits its user may read (design §12, decision 3). NACM-04:
// each denied notification counted in denied-notifications and reported.
import { NETCONF_NS, type XmlElement } from '@node-net/netconf/core';
import { memorySource } from '@node-net/yang/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type AccessDeniedEvent, type DeviceDefinition, type NetconfServer, type ServerOptions } from '../src/core.js';
import { nacm } from './nacm-helpers.js';
import { call, ok, open, type Client, type Json } from './nacm-write-helpers.js';
import { recordingLogger } from './ssh-helpers.js';

const N = 'urn:example:n';
const NCN = 'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications';
const NACM_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';

const ACME_N = `module acme-n {
  yang-version 1.1;
  namespace "${N}";
  prefix n;
  import ietf-netconf-acm { prefix nacm; }
  container top {
    list item {
      key name;
      leaf name { type string; }
      leaf colour { type string; }
      notification flap { leaf why { type string; } }
    }
    container guarded {
      nacm:default-deny-all;
      leaf value { type string; }
      notification tamper;
    }
  }
  notification alarm { leaf text { type string; } }
  notification secret-alarm { nacm:default-deny-all; }
}`;

const ACME_M = `module acme-m {
  namespace "urn:example:m";
  prefix m;
  notification other;
}`;

const DEVICE: DeviceDefinition = {
  id: 'nacm-notifications',
  yang: { modules: ['ietf-netconf-acm', 'acme-n', 'acme-m'] },
  capabilities: { writableRunning: true, notification: true, interleave: true },
};

/** Groups: admin (admin), ops (alice, bob), guest (guest); admin may do anything. */
function policy(opsRules: Json[], extra: Json = {}): Json {
  return {
    groups: { group: [{ name: 'admin', 'user-name': ['admin'] }, { name: 'ops', 'user-name': ['alice', 'bob'] }, { name: 'guest', 'user-name': ['guest'] }] },
    'write-default': 'permit',
    'rule-list': [
      { name: 'admin', group: ['admin'], rule: [{ name: 'all', 'module-name': '*', 'access-operations': '*', action: 'permit' }] },
      { name: 'ops', group: ['ops'], rule: opsRules },
    ],
    ...extra,
  };
}

const START: Json = { 'acme-n:top': { item: [{ name: 'a', colour: 'red' }, { name: 'hidden', colour: 'blue' }], guarded: { value: 'x' } } };

let servers: NetconfServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function server(p: Json | undefined, options: Partial<ServerOptions> = {}, device: DeviceDefinition = DEVICE): Promise<NetconfServer> {
  const srv = await createServer({ device, source: memorySource([{ text: ACME_N }, { text: ACME_M }]), control: { enabled: false }, nacm: { recovery: (u) => u.username === 'recovery' }, ...options });
  servers.push(srv);
  await srv.running.applyExternal({ ...START, ...(p === undefined ? {} : nacm(p)) }, { source: 'test' });
  return srv;
}

/** A session of `user` with a subscription to the NETCONF stream. */
async function subscriber(srv: NetconfServer, user: string, filter = ''): Promise<Client> {
  const c = await open(srv, user);
  expect(ok(await call(c, `<create-subscription xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0">${filter}</create-subscription>`))).toBe(true);
  return c;
}

/** The names of the notifications a session received, in order. */
function received(c: Client): string[] {
  return notifications(c).map((n) => n.elements.find((e) => e.name !== 'eventTime')!.name);
}

/** The notifications a session received, apart from the session-start and -end every session's opening and closing sends. */
function notifications(c: Client): XmlElement[] {
  return c.messages.filter((m) => m.name === 'notification' && !m.elements.some((e) => e.ns === NCN && e.name.startsWith('netconf-session-')));
}

/**
 * Sends the notifications, then an `other` (which every test policy lets
 * through) as a marker, and waits until each client has the marker: what
 * arrived before it is everything it will get.
 */
async function publish(srv: NetconfServer, clients: Client[], send: () => void | Promise<void>): Promise<void> {
  await send();
  srv.notify('/acme-m:other');
  for (const c of clients) await c.until(() => received(c).at(-1) === 'other', 2000, 'the marker');
}

const deny = (name: string, extra: Json): Json => ({ name, 'access-operations': 'read', action: 'deny', ...extra });
const permit = (name: string, extra: Json): Json => ({ name, 'access-operations': 'read', action: 'permit', ...extra });

describe('NACM-10 notification access control', () => {
  it('AC1: a notification-name rule denies that notification only', async () => {
    const srv = await server(policy([deny('no-alarm', { 'module-name': 'acme-n', 'notification-name': 'alarm' })]));
    const alice = await subscriber(srv, 'alice');
    const admin = await subscriber(srv, 'admin');
    await publish(srv, [alice, admin], () => srv.notify('/acme-n:alarm', { text: 'hot' }));
    expect(received(alice)).toEqual(['other']);
    expect(received(admin)).toEqual(['alarm', 'other']);
  });

  it("AC1: a module rule denies every notification of the module, and '*' names match any", async () => {
    const srv = await server(policy([deny('no-n', { 'module-name': 'acme-n' })]));
    const alice = await subscriber(srv, 'alice');
    await publish(srv, [alice], () => srv.notify('/acme-n:alarm'));
    expect(received(alice)).toEqual(['other']);

    const srv2 = await server(policy([deny('none', { 'module-name': 'acme-n', 'notification-name': '*' })]));
    const bob = await subscriber(srv2, 'bob');
    await publish(srv2, [bob], () => srv2.notify('/acme-n:alarm'));
    expect(received(bob)).toEqual(['other']);
  });

  it('AC1: nacm:default-deny-all denies a notification unless a rule permits it', async () => {
    const srv = await server(policy([]));
    const alice = await subscriber(srv, 'alice');
    const guest = await subscriber(srv, 'guest');
    const admin = await subscriber(srv, 'admin');
    await publish(srv, [alice, guest, admin], () => srv.notify('/acme-n:secret-alarm'));
    expect(received(alice)).toEqual(['other']);
    expect(received(guest)).toEqual(['other']);
    expect(received(admin)).toEqual(['secret-alarm', 'other']);

    const srv2 = await server(policy([permit('secret', { 'module-name': 'acme-n', 'notification-name': 'secret-alarm' })]));
    const bob = await subscriber(srv2, 'bob');
    await publish(srv2, [bob], () => srv2.notify('/acme-n:secret-alarm'));
    expect(received(bob)).toEqual(['secret-alarm', 'other']);
  });

  it('AC1: with no matching rule, read-default decides', async () => {
    const srv = await server(policy([permit('other', { 'module-name': 'acme-m' })], { 'read-default': 'deny' }));
    const alice = await subscriber(srv, 'alice');
    await publish(srv, [alice], () => srv.notify('/acme-n:alarm'));
    expect(received(alice)).toEqual(['other']);
  });

  it('AC2: a nested notification needs read access to every instance on its path, and to itself', async () => {
    const srv = await server(
      policy([
        deny('no-hidden', { path: "/acme-n:top/item[name='hidden']" }),
        // Permits the notification itself, but can't reach past the unreadable entry above it.
        permit('flaps', { path: '/acme-n:top/item/flap' }),
      ]),
    );
    const alice = await subscriber(srv, 'alice');
    const admin = await subscriber(srv, 'admin');
    await publish(srv, [alice, admin], () => {
      srv.notify("/acme-n:top/item[name='a']/flap", { why: 'cable' });
      srv.notify("/acme-n:top/item[name='hidden']/flap", { why: 'cable' });
    });
    expect(received(alice)).toEqual(['top', 'other']);
    expect(notifications(alice)[0]!.toString()).toContain('<name>a</name>');
    expect(received(admin)).toEqual(['top', 'top', 'other']);
  });

  it('AC2: a nested notification under a default-deny-all container is denied; a rule denying it alone denies it', async () => {
    const srv = await server(policy([deny('no-flap', { path: '/acme-n:top/item/flap' })]));
    const alice = await subscriber(srv, 'alice');
    await publish(srv, [alice], () => {
      srv.notify('/acme-n:top/guarded/tamper');
      srv.notify("/acme-n:top/item[name='a']/flap");
    });
    expect(received(alice)).toEqual(['other']);
  });

  it('AC3: replayComplete and notificationComplete are always sent', async () => {
    const srv = await server(policy([deny('nothing', { 'module-name': '*' })], { 'read-default': 'deny' }));
    const alice = await subscriber(srv, 'alice');
    srv.notify('/nc-notifications:replayComplete');
    srv.notify('/nc-notifications:notificationComplete');
    await alice.until(() => received(alice).length === 2, 2000, 'two notifications');
    expect(received(alice)).toEqual(['replayComplete', 'notificationComplete']);
  });

  it('AC4: a change to /nacm applies from the next notification', async () => {
    const srv = await server(policy([]));
    const alice = await subscriber(srv, 'alice');
    await publish(srv, [alice], () => srv.notify('/acme-n:alarm'));
    await srv.running.applyExternal(nacm(policy([deny('no-alarm', { 'module-name': 'acme-n', 'notification-name': 'alarm' })])), { source: 'test' });
    await publish(srv, [alice], () => srv.notify('/acme-n:alarm'));
    expect(received(alice)).toEqual(['alarm', 'other', 'other']);
  });

  it("AC5: access is checked before the filter, so a filter can't select a denied notification", async () => {
    const srv = await server(policy([deny('no-alarm', { 'module-name': 'acme-n', 'notification-name': 'alarm' })]));
    const alice = await subscriber(srv, 'alice', `<filter type="subtree"><alarm xmlns="${N}"/><other xmlns="urn:example:m"/></filter>`);
    await publish(srv, [alice], () => srv.notify('/acme-n:alarm'));
    expect(received(alice)).toEqual(['other']);
  });

  describe('AC6, AC7: netconf-config-change', () => {
    const editColours = `<edit-config><target><running/></target><config><top xmlns="${N}"><item><name>a</name><colour>green</colour></item><item><name>hidden</name><colour>black</colour></item></top></config></edit-config>`;
    const editHidden = `<edit-config><target><running/></target><config><top xmlns="${N}"><item><name>hidden</name><colour>white</colour></item></top></config></edit-config>`;
    const targets = (n: XmlElement): string[] =>
      n.child('netconf-config-change', NCN)!.elements.filter((e) => e.name === 'edit').map((e) => e.child('target', NCN)!.text().trim());

    it('leaves out the edits whose target the subscriber may not read; others get them all', async () => {
      const srv = await server(policy([deny('no-hidden', { path: "/acme-n:top/item[name='hidden']" })]));
      const alice = await subscriber(srv, 'alice');
      const bob = await subscriber(srv, 'bob');
      const admin = await subscriber(srv, 'admin');
      const writer = await open(srv, 'admin');
      await publish(srv, [alice, bob, admin], async () => void expect(ok(await call(writer, editColours))).toBe(true));
      const [aliceChange] = notifications(alice);
      expect(targets(aliceChange!)).toEqual(["/n:top/n:item[n:name='a']/n:colour"]);
      expect(targets(notifications(bob)[0]!)).toEqual(targets(aliceChange!));
      expect(targets(notifications(admin)[0]!)).toEqual(["/n:top/n:item[n:name='a']/n:colour", "/n:top/n:item[n:name='hidden']/n:colour"]);
    });

    it('a netconf-config-change left with no edits is not sent, and is not counted as denied', async () => {
      const srv = await server(policy([deny('no-hidden', { path: "/acme-n:top/item[name='hidden']" })]));
      const alice = await subscriber(srv, 'alice');
      const admin = await subscriber(srv, 'admin');
      const writer = await open(srv, 'admin');
      await publish(srv, [alice, admin], async () => void expect(ok(await call(writer, editHidden))).toBe(true));
      expect(received(alice)).toEqual(['other']);
      expect(received(admin)).toEqual(['netconf-config-change', 'other']);
      expect((await deniedNotifications(srv))).toBe('0');
    });

    it('an edit under a default-deny-all node is left out, and changes to /nacm are left out for a user who cannot read it', async () => {
      const srv = await server(policy([]));
      const alice = await subscriber(srv, 'alice');
      const writer = await open(srv, 'admin');
      const both = `<edit-config><target><running/></target><config><top xmlns="${N}"><guarded><value>y</value></guarded><item><name>a</name><colour>pink</colour></item></top><nacm xmlns="${NACM_NS}"><read-default>permit</read-default></nacm></config></edit-config>`;
      await publish(srv, [alice], async () => void expect(ok(await call(writer, both))).toBe(true));
      expect(targets(notifications(alice)[0]!)).toEqual(["/n:top/n:item[n:name='a']/n:colour"]);
    });

    it('a netconf-config-change without an edit list (past 1000 changes) is sent on its type alone', async () => {
      const srv = await server(policy([deny('no-hidden', { path: "/acme-n:top/item[name='hidden']" })]));
      const alice = await subscriber(srv, 'alice');
      const writer = await open(srv, 'admin');
      const many = Array.from({ length: 1001 }, (_, i) => `<item><name>i${i}</name><colour>c</colour></item>`).join('');
      await publish(srv, [alice], async () => void expect(ok(await call(writer, `<edit-config><target><running/></target><config><top xmlns="${N}">${many}</top></config></edit-config>`))).toBe(true));
      const change = notifications(alice)[0]!.child('netconf-config-change', NCN)!;
      expect(change.elements.filter((e) => e.name === 'edit')).toEqual([]);
      expect(change.child('datastore', NCN)?.text()).toBe('running');
    });

    it('the filter selects from the edits the subscriber may read', async () => {
      const srv = await server(policy([deny('no-hidden', { path: "/acme-n:top/item[name='hidden']" })]));
      // Only the hidden entry's edit would match: after the cut, nothing does, so alice gets only the marker.
      const xpath = `/ncn:netconf-config-change[ncn:edit[contains(ncn:target, 'hidden')]] | /m:other`;
      const filter = `<filter type="xpath" xmlns:ncn="${NCN}" xmlns:m="urn:example:m" select="${xpath}"/>`;
      const alice = await subscriber(srv, 'alice', filter);
      const admin = await subscriber(srv, 'admin', filter);
      const writer = await open(srv, 'admin');
      await publish(srv, [alice, admin], async () => void expect(ok(await call(writer, editColours))).toBe(true));
      expect(received(alice)).toEqual(['other']);
      expect(received(admin)).toEqual(['netconf-config-change', 'other']);
    });
  });

  it('AC8: recovery sessions, enable-nacm false and devices without ietf-netconf-acm receive everything', async () => {
    const p = policy([deny('nothing', { 'module-name': '*' })], { 'read-default': 'deny' });
    const srv = await server(p);
    const rec = await subscriber(srv, 'recovery');
    await publish(srv, [rec], () => srv.notify('/acme-n:secret-alarm'));
    expect(received(rec)).toEqual(['secret-alarm', 'other']);

    const off = await server({ ...p, 'enable-nacm': false });
    const alice = await subscriber(off, 'alice');
    await publish(off, [alice], () => off.notify('/acme-n:secret-alarm'));
    expect(received(alice)).toEqual(['secret-alarm', 'other']);

    const plain = await server(undefined, {}, { ...DEVICE, id: 'plain', yang: { modules: ['acme-n', 'acme-m'] } });
    const bob = await subscriber(plain, 'bob');
    await publish(plain, [bob], () => plain.notify('/acme-n:secret-alarm'));
    expect(received(bob)).toEqual(['secret-alarm', 'other']);
  });
});

async function deniedNotifications(srv: NetconfServer): Promise<string> {
  const rec = await open(srv, 'recovery');
  const reply = await call(rec, `<get><filter type="subtree"><nacm xmlns="${NACM_NS}"><denied-notifications/></nacm></filter></get>`);
  return reply.child('data', NETCONF_NS)!.child('nacm', NACM_NS)!.child('denied-notifications', NACM_NS)!.text();
}

describe('NACM-04 denied notifications are counted and reported', () => {
  it('each denied notification counts once per subscription, raises accessDenied and is logged', async () => {
    const { logger, entries } = recordingLogger();
    const srv = await server(policy([deny('no-alarm', { 'module-name': 'acme-n', 'notification-name': 'alarm' }), deny('no-hidden', { path: "/acme-n:top/item[name='hidden']" })]), { logger });
    const events: AccessDeniedEvent[] = [];
    srv.on('accessDenied', (e) => events.push(e));
    const alice = await subscriber(srv, 'alice');
    const bob = await subscriber(srv, 'bob');
    await publish(srv, [alice, bob], () => {
      srv.notify('/acme-n:alarm');
      srv.notify("/acme-n:top/item[name='hidden']/flap");
    });
    expect(await deniedNotifications(srv)).toBe('4');
    expect(events.every((e) => typeof e.sessionId === 'number')).toBe(true);
    expect(events.map(({ sessionId: _, ...e }) => e)).toEqual([
      { username: 'alice', kind: 'notification', operation: 'alarm' },
      { username: 'bob', kind: 'notification', operation: 'alarm' },
      { username: 'alice', kind: 'notification', operation: 'flap', path: "/acme-n:top/item[name='hidden']/flap" },
      { username: 'bob', kind: 'notification', operation: 'flap', path: "/acme-n:top/item[name='hidden']/flap" },
    ]);
    const logged = entries.filter((e) => e.level === 'info' && e.message === 'Access denied');
    expect(logged).toHaveLength(4);
    expect(logged[0]!.context).toMatchObject({ username: 'alice', notification: 'alarm', rule: 'ops/no-alarm', step: 8 });
  });
});
