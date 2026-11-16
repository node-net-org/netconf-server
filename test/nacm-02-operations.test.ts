// NACM-02: refuse operations the policy doesn't permit. NACM-03: recovery
// sessions. NACM-04: denials counted, reported and logged.
import { describe, expect, it } from 'vitest';
import { connectionPair, NETCONF_NS, type XmlElement } from '@node-net/netconf/core';
import type { JsonValue } from '@node-net/yang/core';
import { createServer, type AccessDeniedEvent, type NetconfServer, type Principal, type ServerOptions } from '../src/core.js';
import { loadDeviceFile } from '../src/index.js';
import { BASE_1_0, eom, errorTag, hello, RawClient, rpc } from './helpers.js';
import { A2, A3, ACME_SOURCE, GROUPS, nacm, NACM_DEVICE, NO_NACM_DEVICE } from './nacm-helpers.js';
import { recordingLogger } from './ssh-helpers.js';

const NCM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';
const NNSM = 'urn:node-net:yang:net-netconf-server-monitoring';
const NACM_NS = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';
const CONTROL_NS = 'urn:node-net:yang:net-netconf-server-control';

type Client = RawClient & { request(text: string): Promise<XmlElement> };

async function nacmServer(policy: Record<string, JsonValue> | undefined, options: Partial<ServerOptions> = {}): Promise<NetconfServer> {
  const srv = await createServer({ device: NACM_DEVICE, source: ACME_SOURCE, control: { enabled: false }, ...options });
  if (policy !== undefined) await srv.running.applyExternal(nacm(policy), { source: 'test' });
  return srv;
}

let id = 0;

/** A raw session authenticated as `principal`, after the hellos. */
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

function call(c: Client, body: string): Promise<XmlElement> {
  return c.request(rpc(body, `message-id="${++id}"`));
}

function rpcError(reply: XmlElement): XmlElement {
  return reply.child('rpc-error', NETCONF_NS)!;
}

function ok(reply: XmlElement): boolean {
  return reply.child('ok', NETCONF_NS) !== undefined;
}

const DELETE_STARTUP = '<delete-config><target><startup/></target></delete-config>';

describe('NACM-02 operation access control', () => {
  it('refuses a denied operation with access-denied, error-type protocol and an error-path naming it', async () => {
    const srv = await nacmServer(A3);
    const c = await open(srv, { username: 'guest' });
    const reply = await call(c, DELETE_STARTUP);
    const e = rpcError(reply);
    expect(errorTag(reply)).toBe('access-denied');
    expect(e.child('error-type', NETCONF_NS)!.text()).toBe('protocol');
    const path = e.child('error-path', NETCONF_NS)!;
    expect(path.text().trim()).toBe('/nc:rpc/nc:delete-config');
    expect(path.lookupNamespace('nc')).toBe(NETCONF_NS);
    await srv.close();
  });

  it('always permits close-session', async () => {
    const srv = await nacmServer({ ...A3, 'exec-default': 'deny', 'rule-list': [{ name: 'all', group: ['*'], rule: [{ name: 'none', action: 'deny' }] }] });
    const c = await open(srv, { username: 'guest' });
    expect(errorTag(await call(c, '<get/>'))).toBe('access-denied');
    expect(ok(await call(c, '<close-session/>'))).toBe(true);
    await srv.close();
  });

  it('refuses kill-session and delete-config without a permitting rule, whatever exec-default says', async () => {
    const srv = await nacmServer({ groups: GROUPS, 'exec-default': 'permit' });
    const other = await open(srv, { username: 'admin' });
    const c = await open(srv, { username: 'guest' });
    expect(errorTag(await call(c, DELETE_STARTUP))).toBe('access-denied');
    const otherId = srv.sessions.find((s) => s.username === 'admin')!.id;
    expect(errorTag(await call(c, `<kill-session><session-id>${otherId}</session-id></kill-session>`))).toBe('access-denied');
    // A.2's permit-all lets admin do both.
    await srv.running.applyExternal(nacm(A2), { source: 'test' });
    expect(ok(await call(other, DELETE_STARTUP))).toBe(true);
    await srv.close();
  });

  it("checks operations from other modules the same way, naming them with their module's prefix", async () => {
    const srv = await nacmServer(A3);
    srv.handle('http://example.com/ns/netconf', 'reboot', () => 'ok');
    srv.handle('http://example.com/ns/netconf', 'ping', () => 'ok');
    const c = await open(srv, { username: 'guest' });
    expect(ok(await call(c, '<ping xmlns="http://example.com/ns/netconf"/>'))).toBe(true);
    const reply = await call(c, '<reboot xmlns="http://example.com/ns/netconf"/>');
    expect(errorTag(reply)).toBe('access-denied');
    const path = rpcError(reply).child('error-path', NETCONF_NS)!;
    expect(path.text().trim()).toBe('/nc:rpc/acme:reboot');
    expect(path.lookupNamespace('acme')).toBe('http://example.com/ns/netconf');
    await srv.close();
  });

  it("denies the control module's operations by default, so a control user needs a rule or recovery", async () => {
    const srv = await nacmServer(A3, { control: { enabled: true }, nacm: { recovery: (p) => p.username === 'root' } });
    const guest = await open(srv, { username: 'guest' });
    const reply = await call(guest, `<reset xmlns="${CONTROL_NS}"/>`);
    expect(errorTag(reply)).toBe('access-denied');
    expect(rpcError(reply).child('error-path', NETCONF_NS)!.text().trim()).toBe('/nc:rpc/nnsc:reset');
    const root = await open(srv, { username: 'root' });
    expect(ok(await call(root, `<snapshot xmlns="${CONTROL_NS}"><name>s</name></snapshot>`))).toBe(true);
    await srv.running.applyExternal(nacm(A2), { source: 'test' });
    const admin = await open(srv, { username: 'admin' });
    expect(ok(await call(admin, `<snapshot xmlns="${CONTROL_NS}"><name>t</name></snapshot>`))).toBe(true);
    await srv.close();
  });

  it('applies a change to /nacm from the next message, on a session already open', async () => {
    const srv = await nacmServer(A3);
    const c = await open(srv, { username: 'wilma' });
    expect(errorTag(await call(c, DELETE_STARTUP))).toBe('access-denied');
    await srv.running.applyExternal(nacm({ 'rule-list': [{ name: 'guest-limited-acl', rule: [{ name: 'deny-delete-config', action: 'permit' }] }] }), { source: 'test' });
    expect(ok(await call(c, DELETE_STARTUP))).toBe(true);
    await srv.close();
  });

  it('checks nothing when enable-nacm is false', async () => {
    const srv = await nacmServer({ ...A3, 'enable-nacm': false });
    const c = await open(srv, { username: 'guest' });
    expect(ok(await call(c, DELETE_STARTUP))).toBe(true);
    await srv.close();
  });

  it('never applies to a device without ietf-netconf-acm', async () => {
    const srv = await createServer({ device: NO_NACM_DEVICE, source: ACME_SOURCE, control: { enabled: false } });
    const c = await open(srv, { username: 'guest' });
    expect(ok(await call(c, DELETE_STARTUP))).toBe(true);
    await srv.close();
  });

  it('checks nothing when enable-nacm is false', async () => {
    const srv = await nacmServer({ ...A3, 'enable-nacm': false }, { control: { enabled: true } });
    const guest = await open(srv, { username: 'guest' });
    expect(ok(await call(guest, DELETE_STARTUP))).toBe(true);
    expect(ok(await call(guest, `<snapshot xmlns="${CONTROL_NS}"><name>s</name></snapshot>`))).toBe(true);
    const other = await open(srv, { username: 'admin' });
    const otherId = srv.sessions.find((s) => s.username === 'admin')!.id;
    expect(ok(await call(guest, `<kill-session><session-id>${otherId}</session-id></kill-session>`))).toBe(true);
    await other.waitClosed();
    await srv.close();
  });
});

describe('NACM-02 the bundled sysrepo-netopeer2 device', () => {
  it('AC8: enforces whenever the device implements ietf-netconf-acm: admin may write, other users may not', async () => {
    const device = await loadDeviceFile(new URL('../devices/sysrepo-netopeer2/device.json', import.meta.url).pathname);
    const srv = await createServer({ device, control: { enabled: false } });
    const write = `<edit-config><target><running/></target><config><nacm xmlns="${NACM_NS}"><read-default>deny</read-default></nacm></config></edit-config>`;
    const local = await open(srv, { username: 'local' });
    expect(errorTag(await call(local, write))).toBe('access-denied');
    const admin = await open(srv, { username: 'admin' });
    expect(ok(await call(admin, write))).toBe(true);
    await srv.close();
  });
});

describe('NACM-03 recovery sessions', () => {
  async function sessionsRecovery(srv: NetconfServer, c: Client): Promise<Record<string, string>> {
    const reply = await call(c, `<get><filter type="subtree"><netconf-state xmlns="${NCM}"><sessions/></netconf-state></filter></get>`);
    const sessions = reply.child('data', NETCONF_NS)!.child('netconf-state', NCM)!.child('sessions', NCM)!.elements;
    return Object.fromEntries(sessions.map((s) => [s.child('username', NCM)!.text(), s.child('recovery', NNSM)!.text()]));
  }

  it('lets a recovery session do what the policy denies, decided once at session start, and reports it in monitoring', async () => {
    let asked = 0;
    const srv = await nacmServer(A3, { nacm: { recovery: (p) => (asked++, p.username === 'root') } });
    const root = await open(srv, { username: 'root' });
    const guest = await open(srv, { username: 'guest' });
    expect(asked).toBe(2);
    expect(ok(await call(root, DELETE_STARTUP))).toBe(true);
    expect(ok(await call(root, DELETE_STARTUP))).toBe(true);
    expect(asked).toBe(2);
    expect(errorTag(await call(guest, DELETE_STARTUP))).toBe('access-denied');
    expect(await sessionsRecovery(srv, root)).toEqual({ root: 'true', guest: 'false' });
    await srv.close();
  });

  it('gives in-process sessions no recovery unless their user is named', async () => {
    const srv = await nacmServer(A3);
    const c = await open(srv, { username: 'local' });
    expect(errorTag(await call(c, DELETE_STARTUP))).toBe('access-denied');
    expect(await sessionsRecovery(srv, c)).toEqual({ local: 'false' });
    await srv.close();
  });

  it('treats a recovery function that throws as no recovery, and logs it', async () => {
    const { logger, entries } = recordingLogger();
    const srv = await nacmServer(A3, { logger, nacm: { recovery: () => { throw new Error('directory down'); } } });
    const c = await open(srv, { username: 'root' });
    expect(errorTag(await call(c, DELETE_STARTUP))).toBe('access-denied');
    expect(entries.some((e) => e.level === 'error' && e.message.includes('nacm.recovery') && e.context['error'] === 'directory down')).toBe(true);
    await srv.close();
  });
});

describe('NACM-04 denials counted, reported and logged', () => {
  async function counters(c: Client): Promise<Record<string, string>> {
    const reply = await call(c, `<get><filter type="subtree"><nacm xmlns="${NACM_NS}"><denied-operations/><denied-data-writes/><denied-notifications/></nacm></filter></get>`);
    const n = reply.child('data', NETCONF_NS)!.child('nacm', NACM_NS)!;
    return Object.fromEntries(n.elements.map((e) => [e.name, e.text()]));
  }

  it('counts each refused operation, emits accessDenied and logs it at info', async () => {
    const { logger, entries } = recordingLogger();
    const srv = await nacmServer({ ...A3, 'rule-list': [...(A3['rule-list'] as JsonValue[]), { name: 'read-nacm', group: ['guest'], rule: [{ name: 'r', path: '/ietf-netconf-acm:nacm', 'access-operations': 'read', action: 'permit' }] }] }, { logger });
    const events: AccessDeniedEvent[] = [];
    srv.on('accessDenied', (e) => events.push(e));
    const c = await open(srv, { username: 'guest' });
    expect(await counters(c)).toEqual({ 'denied-operations': '0', 'denied-data-writes': '0', 'denied-notifications': '0' });
    await call(c, DELETE_STARTUP);
    await call(c, DELETE_STARTUP);
    expect((await counters(c))['denied-operations']).toBe('2');
    const sessionId = srv.sessions[0]!.id;
    expect(events).toEqual([
      { sessionId, username: 'guest', kind: 'operation', operation: 'delete-config' },
      { sessionId, username: 'guest', kind: 'operation', operation: 'delete-config' },
    ]);
    const logged = entries.filter((e) => e.level === 'info' && e.message === 'Access denied');
    expect(logged).toHaveLength(2);
    expect(logged[0]!.context).toMatchObject({ sessionId, username: 'guest', operation: 'delete-config', rule: 'guest-limited-acl/deny-delete-config' });
    await srv.close();
  });

  it('reports the counters even when enable-nacm is false, and only on devices with ietf-netconf-acm', async () => {
    const srv = await nacmServer({ 'enable-nacm': false });
    const c = await open(srv, { username: 'guest' });
    expect(await counters(c)).toEqual({ 'denied-operations': '0', 'denied-data-writes': '0', 'denied-notifications': '0' });
    await srv.close();
    const plain = await createServer({ device: NO_NACM_DEVICE, source: ACME_SOURCE, control: { enabled: false } });
    const p = await open(plain, { username: 'guest' });
    const reply = await call(p, '<get/>');
    expect(reply.child('data', NETCONF_NS)!.child('nacm', NACM_NS)).toBeUndefined();
    await plain.close();
  });
});
