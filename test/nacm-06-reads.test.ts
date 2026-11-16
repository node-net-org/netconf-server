// NACM-06: reads leave out what the user may not read (RFC 8341 §3.2.4,
// §3.4.5; NACM design §5, §7.1). The reads fixture device, with
// ietf-netconf-acm added.
import { describe, expect, it } from 'vitest';
import { connectionPair, NETCONF_NS, type XmlElement } from '@node-net/netconf/core';
import { DataTree, decodeJson, decodeXml, encodeJson, mergeTrees, type InstanceNode, type JsonValue } from '@node-net/yang/core';
import { Reader } from '../src/rpc/reads.js';
import { createServer, type Device, type NetconfServer, type Principal } from '../src/core.js';
import { decideData } from '../src/nacm/decide.js';
import { Nacm } from '../src/nacm/engine.js';
import { readPlan } from '../src/nacm/read-plan.js';
import { BASE_1_0, eom, hello, RawClient, rpc } from './helpers.js';
import { nacm } from './nacm-helpers.js';
import { dataJson, NMDA, variant, WD, type Client } from './reads-helpers.js';

type Json = Record<string, JsonValue>;

/** alice is in ops; the defaults permit reads; three read denials, one of them keyed. */
const OPS: Json = {
  groups: { group: [{ name: 'ops', 'user-name': ['alice'] }, { name: 'admin', 'user-name': ['root'] }] },
  'rule-list': [
    {
      name: 'ops',
      group: ['ops'],
      rule: [
        { name: 'no-mtu', path: '/reads-test:system/mtu', 'access-operations': 'read', action: 'deny' },
        { name: 'no-description', path: '/reads-test:interfaces/interface/description', 'access-operations': 'read', action: 'deny' },
        { name: 'no-eth0', path: "/reads-test:interfaces/interface[name='eth0']", 'access-operations': '*', action: 'deny' },
      ],
    },
    { name: 'admin', group: ['admin'], rule: [{ name: 'all', 'module-name': '*', 'access-operations': '*', action: 'permit' }] },
  ],
};

let device: Promise<Device> | undefined;

function nacmDevice(): Promise<Device> {
  device ??= variant((def) => ({ ...def, id: 'reads-nacm', yang: { ...def.yang, modules: [...(def.yang.modules ?? []), 'ietf-netconf-acm'] } }));
  return device;
}

async function server(policy: Json | undefined, recoveryUsers: string[] = ['recovery']): Promise<NetconfServer> {
  const srv = await createServer({ device: await nacmDevice(), control: { enabled: false }, nacm: { recovery: (p) => recoveryUsers.includes(p.username) } });
  if (policy !== undefined) await srv.running.applyExternal(nacm(policy), { source: 'test' });
  return srv;
}

async function open(srv: NetconfServer, principal: Principal): Promise<Client> {
  const [client, serverEnd] = connectionPair();
  srv.serve(serverEnd, { principal, transport: 'test' });
  const c = new RawClient(client) as Client;
  await c.waitFor(1);
  c.send(eom(hello([BASE_1_0])));
  c.request = async (text) => {
    const n = c.messages.length + 1;
    c.send(eom(text));
    return c.waitFor(n);
  };
  return c;
}

/** The internal switch, spread in so the options' type doesn't name it. */
let id = 0;
function send(c: Client, body: string): Promise<XmlElement> {
  return c.request(rpc(body, `message-id="${++id}"`));
}

const RT = 'urn:example:reads';
const getConfig = (extra = ''): string => `<get-config><source><running/></source>${extra}</get-config>`;
const getData = (ds: string, extra = ''): string => `<get-data xmlns="${NMDA}" xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores"><datastore>ds:${ds}</datastore>${extra}</get-data>`;

/** alice's view of running in the fixture: no mtu, no eth0, no descriptions. */
const ALICE_RUNNING = {
  'reads-test:system': { hostname: 'r1', dns: ['8.8.8.8', '1.1.1.1'] },
  'reads-test:interfaces': { interface: [{ name: 'lo', type: 'reads-test:loopback' }] },
};

async function json(srv: NetconfServer, c: Client, body: string, ns = NETCONF_NS, ds = 'operational'): Promise<Json> {
  return dataJson(srv.device, await send(c, body), ns, ds) as Json;
}

describe('NACM-06 read access control', () => {
  it('AC1: get-config and get leave out unreadable nodes and their descendants, keyed entries included', async () => {
    const srv = await server(OPS);
    const alice = await open(srv, { username: 'alice' });
    expect(await json(srv, alice, getConfig(), NETCONF_NS, 'running')).toEqual(ALICE_RUNNING);
    const get = await json(srv, alice, '<get/>');
    expect(get['reads-test:system']).toEqual({ hostname: 'r1', dns: ['8.8.8.8', '1.1.1.1'], 'uptime-info': { uptime: 1234 } });
    expect((get['reads-test:interfaces'] as { interface: { name: string }[] }).interface.map((i) => i.name)).toEqual(['lo', 'mgmt0']);
    // The snapshot itself is untouched: a recovery session still sees everything.
    const rec = await open(srv, { username: 'recovery' });
    const all = await json(srv, rec, getConfig(), NETCONF_NS, 'running');
    expect(all['reads-test:system']).toMatchObject({ mtu: 1500 });
    expect((all['reads-test:interfaces'] as { interface: object[] }).interface).toHaveLength(2);
    await srv.close();
  });

  it('AC2: a rule naming list entries by key shows only those entries', async () => {
    const policy: Json = {
      groups: OPS['groups']!,
      'rule-list': [
        {
          name: 'ops',
          group: ['ops'],
          rule: [
            { name: 'lo-only', path: "/reads-test:interfaces/interface[name='lo']", 'access-operations': 'read', action: 'permit' },
            { name: 'no-interfaces', path: '/reads-test:interfaces/interface', 'access-operations': 'read', action: 'deny' },
          ],
        },
      ],
    };
    const srv = await server(policy);
    const alice = await open(srv, { username: 'alice' });
    const ifs = (await json(srv, alice, '<get/>'))['reads-test:interfaces'] as { interface: { name: string; stats?: object }[] };
    expect(ifs.interface).toEqual([{ name: 'lo', type: 'reads-test:loopback', stats: { 'in-octets': '1', 'out-octets': '1' } }]);
    await srv.close();
  });

  it('AC3: subtree filters, content matches, XPath filters, origin filters, max-depth and config-filter select only readable data', async () => {
    const srv = await server(OPS);
    const alice = await open(srv, { username: 'alice' });
    // A content match on an unreadable leaf, or an unreadable key, matches nothing.
    expect(await json(srv, alice, getConfig(`<filter><system xmlns="${RT}"><mtu>1500</mtu></system></filter>`), NETCONF_NS, 'running')).toEqual({});
    expect(await json(srv, alice, getConfig(`<filter><interfaces xmlns="${RT}"><interface><name>eth0</name></interface></interfaces></filter>`), NETCONF_NS, 'running')).toEqual({});
    // Selecting an unreadable node selects nothing; a readable entry comes without its unreadable leaf.
    expect(await json(srv, alice, getConfig(`<filter><interfaces xmlns="${RT}"><interface><description/></interface></interfaces></filter>`), NETCONF_NS, 'running')).toEqual({});
    expect(await json(srv, alice, getConfig(`<filter><interfaces xmlns="${RT}"><interface><name>lo</name></interface></interfaces></filter>`), NETCONF_NS, 'running')).toEqual({
      'reads-test:interfaces': ALICE_RUNNING['reads-test:interfaces'],
    });
    // XPath.
    const xpath = (select: string): string => getConfig(`<filter type="xpath" xmlns:rt="${RT}" select="${select}"/>`);
    expect(await json(srv, alice, xpath("/rt:interfaces/rt:interface[rt:name='eth0']"), NETCONF_NS, 'running')).toEqual({});
    expect(await json(srv, alice, xpath('/rt:system/rt:mtu'), NETCONF_NS, 'running')).toEqual({});
    expect(await json(srv, alice, xpath('/rt:interfaces'), NETCONF_NS, 'running')).toEqual({ 'reads-test:interfaces': ALICE_RUNNING['reads-test:interfaces'] });
    // get-data's subtree filter, max-depth and config-filter.
    expect(await json(srv, alice, getData('running', `<subtree-filter><system xmlns="${RT}"/></subtree-filter><max-depth>2</max-depth>`), NMDA, 'running')).toEqual({
      'reads-test:system': ALICE_RUNNING['reads-test:system'],
    });
    const state = await json(srv, alice, getData('operational', '<config-filter>false</config-filter>'), NMDA);
    expect((state['reads-test:interfaces'] as { interface: { name: string }[] }).interface.map((i) => i.name)).toEqual(['lo', 'mgmt0']);
    // Origin filters: configuration from intended (eth0 is unreadable), and state.
    const intended = await json(srv, alice, getData('operational', '<origin-filter xmlns:or="urn:ietf:params:xml:ns:yang:ietf-origin">or:intended</origin-filter>'), NMDA);
    expect((intended['reads-test:interfaces'] as { interface: { name: string }[] }).interface.map((i) => i.name)).toEqual(['lo', 'mgmt0']);
    await srv.close();
  });

  it('AC4: with-defaults modes never bring back the default of an unreadable leaf', async () => {
    const srv = await server(OPS);
    const alice = await open(srv, { username: 'alice' });
    for (const mode of ['report-all', 'report-all-tagged', 'trim', 'explicit']) {
      const data = await json(srv, alice, getConfig(`<with-defaults xmlns="${WD}">${mode}</with-defaults>`), NETCONF_NS, 'running');
      expect(data['reads-test:system']).not.toHaveProperty('mtu');
    }
    const all = await json(srv, alice, getConfig(`<with-defaults xmlns="${WD}">report-all</with-defaults>`), NETCONF_NS, 'running');
    expect(all['reads-test:system']).toMatchObject({ clock: { timezone: 'UTC' } });
    await srv.close();
  });

  it('AC5: /nacm is hidden without a permitting rule, and shown with one', async () => {
    const srv = await server(OPS);
    const alice = await open(srv, { username: 'alice' });
    const root = await open(srv, { username: 'root' });
    expect(await json(srv, alice, '<get/>')).not.toHaveProperty('ietf-netconf-acm:nacm');
    expect(await json(srv, alice, getConfig(), NETCONF_NS, 'running')).not.toHaveProperty('ietf-netconf-acm:nacm');
    expect(await json(srv, root, '<get/>')).toHaveProperty('ietf-netconf-acm:nacm');
    // With no policy at all, every user still reads everything but /nacm.
    const bare = await server(undefined);
    const bob = await open(bare, { username: 'bob' });
    const get = await json(bare, bob, '<get/>');
    expect(get).not.toHaveProperty('ietf-netconf-acm:nacm');
    expect(get['reads-test:system']).toMatchObject({ mtu: 1500 });
    await srv.close();
    await bare.close();
  });

  it('AC6: copy-config from a datastore leaves out what the user may not read, except running to startup', async () => {
    // Leaving nodes out of the copy deletes them from the target, so alice needs write access to them (NACM-08),
    // and must be able to read /nacm, which is default-deny-all, or the copy would delete it.
    const readNacm: Json = { name: 'read-nacm', path: '/ietf-netconf-acm:nacm', 'access-operations': 'read', action: 'permit' };
    const rules = (OPS['rule-list'] as Json[]).map((l) => (l['name'] === 'ops' ? { ...l, rule: [readNacm, ...(l['rule'] as Json[]).map((r) => ({ ...r, 'access-operations': 'read' }))] } : l));
    const srv = await server({ ...OPS, 'write-default': 'permit', 'rule-list': rules });
    const alice = await open(srv, { username: 'alice' });
    const rec = await open(srv, { username: 'recovery' });
    expect((await send(alice, '<copy-config><target><candidate/></target><source><running/></source></copy-config>')).child('ok', NETCONF_NS)).toBeDefined();
    const { 'ietf-netconf-acm:nacm': kept, ...candidate } = await json(srv, rec, '<get-config><source><candidate/></source></get-config>', NETCONF_NS, 'candidate');
    expect(kept).toBeDefined();
    expect(candidate).toEqual(ALICE_RUNNING);
    expect((await send(alice, '<copy-config><target><startup/></target><source><running/></source></copy-config>')).child('ok', NETCONF_NS)).toBeDefined();
    const startup = await json(srv, rec, '<get-config><source><startup/></source></get-config>', NETCONF_NS, 'startup');
    expect(startup['reads-test:system']).toMatchObject({ mtu: 1500 });
    await srv.close();
  });

  it('AC7: a provider whose subtree the user may not read is not asked for data', async () => {
    const policy: Json = { ...OPS, 'rule-list': [{ name: 'ops', group: ['ops'], rule: [{ name: 'no-uptime', path: '/reads-test:system/uptime-info', 'access-operations': 'read', action: 'deny' }] }] };
    const srv = await server(policy);
    const calls: string[] = [];
    await srv.provide('/reads-test:system/uptime-info', { onRead: ({ username }) => void calls.push(username ?? '') });
    const alice = await open(srv, { username: 'alice' });
    const rec = await open(srv, { username: 'recovery' });
    await send(alice, '<get/>');
    expect(calls).toEqual([]);
    await send(rec, '<get/>');
    expect(calls).toEqual(['recovery']);
    await srv.close();
  });

  it('AC8: recovery sessions and enable-nacm false read everything', async () => {
    const srv = await server(OPS);
    const rec = await open(srv, { username: 'recovery' });
    const get = await json(srv, rec, '<get/>');
    expect(get).toHaveProperty('ietf-netconf-acm:nacm');
    expect(get['reads-test:system']).toMatchObject({ mtu: 1500 });
    const off = await server({ ...OPS, 'enable-nacm': false });
    const alice = await open(off, { username: 'alice' });
    const all = await json(off, alice, '<get/>');
    expect(all).toHaveProperty('ietf-netconf-acm:nacm');
    expect((all['reads-test:interfaces'] as { interface: object[] }).interface).toHaveLength(3);
    await srv.close();
    await off.close();
  });

  it('AC9: a change to the read rules applies from the next message', async () => {
    const srv = await server(OPS);
    const alice = await open(srv, { username: 'alice' });
    expect((await json(srv, alice, getConfig(), NETCONF_NS, 'running'))['reads-test:system']).not.toHaveProperty('mtu');
    await srv.running.applyExternal(nacm({ 'rule-list': [{ name: 'ops', rule: [{ name: 'no-mtu', '@': { 'ietf-netconf:operation': 'delete' } }] }] }), { source: 'test' });
    expect((await json(srv, alice, getConfig(), NETCONF_NS, 'running'))['reads-test:system']).toMatchObject({ mtu: 1500 });
    await srv.close();
  });

  it('AC10: a read with nothing to drop keeps its tree; a tree built for the read is pruned in place; a snapshot is copied', async () => {
    const d = await nacmDevice();
    const engine = new Nacm(d.schema, { warn: () => undefined });
    const reader = new Reader(d, undefined as never);
    const empty = engine.subject(d.initial.running, { username: 'bob' }, false)!;
    const emptyPlan = readPlan(empty, d.schema);
    // /nacm is default-deny-all, so the root is mixed even with no policy; a tree without /nacm has nothing to drop.
    expect(emptyPlan.root).toBe('mixed');
    expect(reader.retrieve({ tree: d.initial.running, owned: false, plan: emptyPlan })).toBe(d.initial.running);
    const plan = readPlan(engine.subject(decodeJson(d.schema.forDatastore('running'), nacm(OPS)), { username: 'alice' }, false)!, d.schema);
    const owned = mergeTrees(d.initial.running);
    expect(reader.retrieve({ tree: owned, owned: true, plan })).toBe(owned);
    expect(encodeJson(owned)).toEqual(ALICE_RUNNING);
    const copied = reader.retrieve({ tree: d.initial.running, owned: false, plan });
    expect(copied).not.toBe(d.initial.running);
    expect(encodeJson(copied)).toEqual(ALICE_RUNNING);
    expect(encodeJson(d.initial.running)).toMatchObject({ 'reads-test:system': { mtu: 1500 } });
    // A reply from a snapshot with nothing else to do leaves the dropped nodes out as it encodes, and copies nothing.
    const data = reader.reply(NETCONF_NS, { tree: d.initial.running, owned: false, plan });
    expect(encodeJson(decodeXml(d.schema.forDatastore('running'), data.elements))).toEqual(ALICE_RUNNING);
    expect(encodeJson(d.initial.running)).toMatchObject({ 'reads-test:system': { mtu: 1500 } });
  });

  it('the read plan keeps exactly the nodes RFC 8341 §3.4.5 lets the user read', async () => {
    const policies: Json[] = [
      OPS,
      { ...OPS, 'read-default': 'deny', 'rule-list': [{ name: 'ops', group: ['ops'], rule: [{ name: 'ifs', path: '/reads-test:interfaces', 'access-operations': 'read', action: 'permit' }, ...((OPS['rule-list'] as Json[])[0]!['rule'] as Json[])] }] },
      { ...OPS, 'rule-list': [{ name: 'ops', group: ['ops'], rule: [{ name: 'mod', 'module-name': 'reads-test', 'access-operations': 'read', action: 'deny' }] }] },
      { ...OPS, 'rule-list': [{ name: 'ops', group: ['ops'], rule: [{ name: 'lo-name', path: "/reads-test:interfaces/interface[name='lo']/type", 'access-operations': 'read', action: 'deny' }] }] },
    ];
    const d = await nacmDevice();
    const engine = new Nacm(d.schema, { warn: () => undefined });
    const tree = d.initial.running;
    for (const policy of policies) {
      const subject = engine.subject(decodeJson(d.schema.forDatastore('running'), nacm(policy)), { username: 'alice' }, false)!;
      const plan = readPlan(subject, d.schema);
      const expected = new Set<InstanceNode>();
      const visit = (nodes: readonly InstanceNode[]): void => {
        for (const n of nodes) {
          if (!decideData(subject, n, 'read').permit) continue;
          expected.add(n);
          if ('children' in n) visit(n.children);
        }
      };
      visit(tree.children);
      const dropped = new Set(plan.pruner().drops(tree));
      const kept = new Set<InstanceNode>();
      const keep = (nodes: readonly InstanceNode[]): void => {
        for (const n of nodes) {
          if (dropped.has(n)) continue;
          kept.add(n);
          if ('children' in n) keep(n.children);
        }
      };
      keep(tree.children);
      // Keys travel with their entry; apart from them, the two agree.
      const isKey = (n: InstanceNode): boolean => n.parent !== undefined && !(n.parent instanceof DataTree) && n.parent.kind === 'list' && n.parent.keys.includes(n as never);
      expect([...kept].filter((n) => !isKey(n) && !expected.has(n)).map((n) => n.path)).toEqual([]);
      expect([...expected].filter((n) => !kept.has(n)).map((n) => n.path)).toEqual([]);
    }
  });
});
