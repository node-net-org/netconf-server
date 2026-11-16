// NACM-07: rpc-errors reveal nothing the user may not read (RFC 8341
// §3.4.3, §3.2.5; NACM design §7.3).
import { describe, expect, it } from 'vitest';
import { connectionPair, NETCONF_NS, x, type XmlElement } from '@node-net/netconf/core';
import { decodeJson, type JsonValue } from '@node-net/yang/core';
import { createServer, type NetconfServer, type Principal } from '../src/core.js';
import { Nacm } from '../src/nacm/engine.js';
import { ErrorSanitiser, splitSteps } from '../src/nacm/sanitise.js';
import { BASE_1_0, eom, hello, RawClient, rpc } from './helpers.js';
import { nacm } from './nacm-helpers.js';
import { variant, type Client } from './reads-helpers.js';

type Json = Record<string, JsonValue>;

const RT = 'urn:example:reads';

const OPS: Json = {
  groups: { group: [{ name: 'ops', 'user-name': ['alice'] }] },
  'rule-list': [
    {
      name: 'ops',
      group: ['ops'],
      rule: [
        { name: 'no-mtu', path: '/reads-test:system/mtu', 'access-operations': 'read', action: 'deny' },
        { name: 'no-eth0', path: "/reads-test:interfaces/interface[name='eth0']", 'access-operations': 'read', action: 'deny' },
        { name: 'no-dns', path: '/reads-test:system/dns', 'access-operations': 'read', action: 'deny' },
        { name: 'no-validate', 'module-name': 'ietf-netconf', 'rpc-name': 'validate', 'access-operations': 'exec', action: 'deny' },
      ],
    },
  ],
};

const device = variant((def) => ({ ...def, id: 'reads-nacm', yang: { ...def.yang, modules: [...(def.yang.modules ?? []), 'ietf-netconf-acm'] } }));

/** The internal switch, spread in so the options' type doesn't name it. */
async function server(policy: Json): Promise<NetconfServer> {
  const srv = await createServer({ device: await device, control: { enabled: false }, nacm: { recovery: (p) => p.username === 'recovery' } });
  await srv.running.applyExternal(nacm(policy), { source: 'test' });
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

let id = 0;
async function error(c: Client, body: string): Promise<XmlElement> {
  const reply = await c.request(rpc(body, `message-id="${++id}"`));
  const e = reply.child('rpc-error', NETCONF_NS);
  if (e === undefined) throw new Error(`no rpc-error in ${reply.toString()}`);
  return e;
}

const edit = (config: string): string => `<edit-config><target><candidate/></target><config>${config}</config></edit-config>`;
const BAD_MTU = edit(`<system xmlns="${RT}"><mtu>abc</mtu></system>`);
const badType = (name: string): string => edit(`<interfaces xmlns="${RT}" xmlns:rt="${RT}"><interface><name>${name}</name><type>rt:bogus</type></interface></interfaces>`);
const CREATE_ETH0_DESCRIPTION = edit(`<interfaces xmlns="${RT}"><interface><name>eth0</name><description xmlns:nc="${NETCONF_NS}" nc:operation="create">x</description></interface></interfaces>`);

/** A child's text by name alone: elements built with x() have no namespace until serialised. */
function named(e: XmlElement, name: string): string | undefined {
  return e.elements.find((c) => c.name === name)?.text().trim();
}

function field(e: XmlElement, name: string): string | undefined {
  return e.child(name, NETCONF_NS)?.text().trim();
}

describe('NACM-07 rpc-errors that leak nothing', () => {
  it('AC1–AC4: an error naming an unreadable leaf is cut back to its readable parent, with a generic message, and keeps its type and tag', async () => {
    const srv = await server(OPS);
    const alice = await open(srv, { username: 'alice' });
    const e = await error(alice, BAD_MTU);
    expect(field(e, 'error-type')).toBe('application');
    expect(field(e, 'error-tag')).toBe('invalid-value');
    expect(field(e, 'error-severity')).toBe('error');
    const path = e.child('error-path', NETCONF_NS)!;
    expect(path.text().trim()).toBe('/reads-test:system');
    expect(path.lookupNamespace('reads-test')).toBe(RT);
    expect(field(e, 'error-message')).toBe('A value is not valid');
    expect(e.child('error-message', NETCONF_NS)!.toString()).toContain('xml:lang="en"');
    expect(e.toString()).not.toContain('abc');
    expect(e.toString()).not.toContain('mtu');
    await srv.close();
  });

  it('AC1: a keyed rule cuts the path at the list, and only for the entry it names', async () => {
    const srv = await server(OPS);
    const alice = await open(srv, { username: 'alice' });
    const eth0 = await error(alice, badType('eth0'));
    expect(field(eth0, 'error-path')).toBe('/reads-test:interfaces');
    expect(field(eth0, 'error-message')).toBe('A value is not valid');
    const lo = await error(alice, badType('lo'));
    expect(field(lo, 'error-path')).toBe("/reads-test:interfaces/reads-test:interface[reads-test:name='lo']/reads-test:type");
    expect(field(lo, 'error-message')).toBe("'rt:bogus' is not a known identity");
    // data-exists on an unreadable node: the tag still says what happened.
    const exists = await error(alice, CREATE_ETH0_DESCRIPTION);
    expect(field(exists, 'error-tag')).toBe('data-exists');
    expect(field(exists, 'error-path')).toBe('/reads-test:interfaces');
    expect(field(exists, 'error-message')).toBe('The data already exists');
    await srv.close();
  });

  it('AC1: with no readable ancestor, the error-path is left out', async () => {
    const srv = await server({ ...OPS, 'rule-list': [{ name: 'ops', group: ['ops'], rule: [{ name: 'no-system', path: '/reads-test:system', 'access-operations': 'read', action: 'deny' }] }] });
    const alice = await open(srv, { username: 'alice' });
    const e = await error(alice, BAD_MTU);
    expect(e.child('error-path', NETCONF_NS)).toBeUndefined();
    expect(field(e, 'error-tag')).toBe('invalid-value');
    await srv.close();
  });

  it('AC6–AC7: operation errors, recovery sessions and enable-nacm false are unchanged', async () => {
    const srv = await server(OPS);
    const alice = await open(srv, { username: 'alice' });
    const denied = await error(alice, '<validate><source><running/></source></validate>');
    expect(field(denied, 'error-path')).toBe('/nc:rpc/nc:validate');
    expect(field(denied, 'error-message')).toBe('Access to validate is denied');
    const rec = await open(srv, { username: 'recovery' });
    const e = await error(rec, BAD_MTU);
    expect(field(e, 'error-path')).toBe('/reads-test:system/reads-test:mtu');
    expect(field(e, 'error-message')).toBe("'abc' is not an integer");
    const off = await server({ ...OPS, 'enable-nacm': false });
    const bob = await open(off, { username: 'alice' });
    expect(field(await error(bob, BAD_MTU), 'error-path')).toBe('/reads-test:system/reads-test:mtu');
    await srv.close();
    await off.close();
  });

  it('AC3–AC5: error-info naming nodes is dropped, session-id and error-app-tag stay, and readable errors lose only unreadable non-unique entries', async () => {
    const d = await device;
    const engine = new Nacm(d.schema, { warn: () => undefined });
    const subject = engine.subject(decodeJson(d.schema.forDatastore('running'), nacm(OPS)), { username: 'alice' }, false)!;
    const sanitiser = new ErrorSanitiser(d.schema);
    const YANG = 'urn:ietf:params:xml:ns:yang:1';
    const rpcError = (path: string, info: XmlElement[]): XmlElement =>
      x(
        'rpc-error',
        { xmlns: NETCONF_NS },
        x('error-type', 'application'),
        x('error-tag', 'operation-failed'),
        x('error-severity', 'error'),
        x('error-app-tag', 'data-not-unique'),
        x('error-path', { 'xmlns:reads-test': RT, 'xmlns:other': 'urn:other' }, path),
        x('error-message', 'secret detail'),
        x('error-info', info),
      );
    const nonUnique = (path: string): XmlElement => x('non-unique', { xmlns: YANG, 'xmlns:reads-test': RT }, path);
    const info = [x('bad-element', { xmlns: NETCONF_NS }, 'mtu'), x('session-id', { xmlns: NETCONF_NS }, '7'), nonUnique('/reads-test:system/reads-test:mtu')];

    const hidden = sanitiser.error(rpcError('/reads-test:system/reads-test:mtu', info), subject);
    expect(named(hidden, 'error-app-tag')).toBe('data-not-unique');
    expect(named(hidden, 'error-message')).toBe('The operation failed');
    const path = hidden.elements.find((e) => e.name === 'error-path')!;
    expect(path.text()).toBe('/reads-test:system');
    expect([...path.declarations.keys()]).toEqual(['reads-test']);
    expect(hidden.elements.find((e) => e.name === 'error-info')!.elements.map((e) => e.name)).toEqual(['session-id']);

    const readablePath = "/reads-test:interfaces/reads-test:interface[reads-test:name='lo']";
    const readable = sanitiser.error(rpcError(readablePath, [nonUnique(`${readablePath}/reads-test:type`), nonUnique("/reads-test:interfaces/reads-test:interface[reads-test:name='eth0']/reads-test:type")]), subject);
    expect(named(readable, 'error-message')).toBe('secret detail');
    expect(named(readable, 'error-path')).toBe(readablePath);
    expect(readable.elements.find((e) => e.name === 'error-info')!.elements.map((e) => e.text())).toEqual([`${readablePath}/reads-test:type`]);
    // A leaf-list entry named by value.
    expect(named(sanitiser.error(rpcError("/reads-test:system/reads-test:dns[.='8.8.8.8']", []), subject), 'error-path')).toBe('/reads-test:system');
    // A path that names no data node is left alone.
    const odd = rpcError('/reads-test:nowhere/reads-test:mtu', []);
    expect(sanitiser.error(odd, subject)).toBe(odd);
  });

  it('splits location paths on slashes outside predicates and quotes', () => {
    expect(splitSteps("/a:x/a:y[a:k='p/q'][a:j=\"]/\"]/a:z")).toEqual(['a:x', "a:y[a:k='p/q'][a:j=\"]/\"]", 'a:z']);
  });
});
