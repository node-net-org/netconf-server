/**
 * Test support for NACM writes and actions (NACM-08, NACM-09): a device
 * implementing ietf-netconf-acm with a candidate, a module with lists, an
 * ordered-by-user list, default-deny statements, actions and an
 * augmentation from another module, and raw in-process sessions.
 */

import { connectionPair, NETCONF_NS, type XmlElement } from '@node-net/netconf/core';
import { memorySource, type JsonValue } from '@node-net/yang/core';
import { createServer, type DeviceDefinition, type NetconfServer, type Principal, type ServerOptions } from '../src/core.js';
import { BASE_1_0, eom, hello, RawClient, rpc } from './helpers.js';
import { nacm } from './nacm-helpers.js';

const ACME_W = `module acme-w {
  yang-version 1.1;
  namespace "urn:example:w";
  prefix w;
  import ietf-netconf-acm { prefix nacm; }
  container top {
    leaf speed { type string; }
    list item {
      key name;
      leaf name { type string; }
      leaf colour { type string; }
      container secret {
        nacm:default-deny-write;
        leaf code { type string; }
      }
    }
    list ordered {
      key name;
      ordered-by user;
      leaf name { type string; }
    }
    choice mode {
      leaf auto { type empty; }
      leaf manual { type string; }
    }
    container guarded {
      nacm:default-deny-all;
      leaf value { type string; }
    }
    list port {
      key id;
      leaf id { type string; }
      action bounce {
        input { leaf why { type string; } }
      }
    }
  }
}`;

const ACME_W_AUG = `module acme-w-aug {
  yang-version 1.1;
  namespace "urn:example:w-aug";
  prefix wa;
  import acme-w { prefix w; }
  augment /w:top/w:item {
    leaf extra { type string; }
  }
}`;

export const W = 'urn:example:w';
export const WA = 'urn:example:w-aug';
export const NACM_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';

export const WRITE_SOURCE = memorySource([{ text: ACME_W }, { text: ACME_W_AUG }]);

export const WRITE_DEVICE: DeviceDefinition = {
  id: 'nacm-writes',
  yang: { modules: ['ietf-netconf-acm', 'acme-w', 'acme-w-aug'] },
  capabilities: { candidate: true, confirmedCommit: true, writableRunning: true, startup: true },
};

export type Json = Record<string, JsonValue>;

/** Groups: admin (admin), ops (alice, bob), guest (guest). */
export const GROUPS: Json = {
  group: [
    { name: 'admin', 'user-name': ['admin'] },
    { name: 'ops', 'user-name': ['alice', 'bob'] },
    { name: 'guest', 'user-name': ['guest'] },
  ],
};

const ADMIN_LIST: Json = { name: 'admin', group: ['admin'], rule: [{ name: 'all', 'module-name': '*', 'access-operations': '*', action: 'permit' }] };

/** A policy: the groups, admin permitted everything, then the ops rules given, in order. */
export function policy(opsRules: Json[], extra: Json = {}): Json {
  return { groups: GROUPS, 'rule-list': [ADMIN_LIST, { name: 'ops', group: ['ops'], rule: opsRules }], ...extra };
}

/** A data-node rule for ops. */
export function rule(name: string, path: string, ops: string, action: 'permit' | 'deny' = 'permit'): Json {
  return { name, path, 'access-operations': ops, action };
}

/** Running content the tests start from. */
export const START: Json = {
  'acme-w:top': {
    speed: 'fast',
    item: [{ name: 'a', colour: 'red' }, { name: 'hidden', colour: 'blue' }],
    ordered: [{ name: 'x' }, { name: 'y' }],
    port: [{ id: 'p1' }, { id: 'p2' }],
  },
};

export async function server(nacmPolicy: Json | undefined, options: Partial<ServerOptions> = {}, data: Json = START): Promise<NetconfServer> {
  const srv = await createServer({
    device: WRITE_DEVICE,
    source: WRITE_SOURCE,
    control: { enabled: false },
    nacm: { recovery: (p) => p.username === 'recovery' },
    ...options,
  });
  await srv.running.applyExternal({ ...data, ...(nacmPolicy === undefined ? {} : nacm(nacmPolicy)) }, { source: 'test' });
  return srv;
}

export type Client = RawClient & { request(text: string): Promise<XmlElement> };

/** A raw session authenticated as `principal`, after the hellos. */
export async function open(srv: NetconfServer, principal: Principal | string): Promise<Client> {
  const [client, serverEnd] = connectionPair();
  srv.serve(serverEnd, { principal: typeof principal === 'string' ? { username: principal } : principal, transport: 'test' });
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
export function call(c: Client, body: string): Promise<XmlElement> {
  return c.request(rpc(body, `message-id="${++id}"`));
}

export function ok(reply: XmlElement): boolean {
  return reply.child('ok', NETCONF_NS) !== undefined;
}

export function errors(reply: XmlElement): XmlElement[] {
  return reply.elements.filter((e) => e.name === 'rpc-error');
}

/** The single rpc-error of a reply, as plain fields. */
export function denial(reply: XmlElement): { tag: string; type: string; path: string | undefined; message: string } {
  const es = errors(reply);
  if (es.length !== 1) throw new Error(`Expected one rpc-error, got ${reply.toString()}`);
  const e = es[0]!;
  const text = (name: string): string | undefined => e.child(name, NETCONF_NS)?.text().trim();
  return { tag: text('error-tag')!, type: text('error-type')!, path: text('error-path'), message: text('error-message')! };
}

/** An `<edit-config>` of `target` with `<top>` content and optional extra parameters. */
export function edit(target: 'running' | 'candidate', top: string, extra = ''): string {
  return `<edit-config><target><${target}/></target>${extra}<config><top xmlns="${W}" xmlns:nc="${NETCONF_NS}" xmlns:yang="urn:ietf:params:xml:ns:yang:1">${top}</top></config></edit-config>`;
}

/** The `<top>` of a datastore, read by a recovery session, as XML text. */
export async function top(srv: NetconfServer, datastore: 'running' | 'candidate' | 'startup' = 'running'): Promise<string> {
  const rec = await open(srv, 'recovery');
  const reply = await call(rec, `<get-config><source><${datastore}/></source><filter type="subtree"><top xmlns="${W}"/></filter></get-config>`);
  return reply.child('data', NETCONF_NS)?.child('top', W)?.toString() ?? '';
}

/** The NACM counters, read by a recovery session. */
export async function counters(srv: NetconfServer): Promise<Record<string, string>> {
  const rec = await open(srv, 'recovery');
  const reply = await call(rec, `<get><filter type="subtree"><nacm xmlns="${NACM_NS}"><denied-operations/><denied-data-writes/></nacm></filter></get>`);
  const n = reply.child('data', NETCONF_NS)!.child('nacm', NACM_NS)!;
  return Object.fromEntries(n.elements.map((e) => [e.name, e.text().trim()]));
}
