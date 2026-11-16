// NACM-01: decide access from the /nacm policy exactly as RFC 8341 specifies.
// Table-driven from RFC 8341 Appendix A: each row is a user, a request and
// the verdict with the step of §3.4.4, §3.4.5 or §3.4.6 that reached it.
import { beforeAll, describe, expect, it } from 'vitest';
import { DataTree, decodeJson, ListEntry, type InstanceNode, type JsonValue, type RpcNode, type SchemaNode } from '@node-net/yang/core';
import { loadDevice, type Device } from '../src/core.js';
import { decideData, decideExec, decideNotification, type Subject } from '../src/nacm/decide.js';
import { Nacm } from '../src/nacm/engine.js';
import type { AccessOperation } from '../src/nacm/policy.js';
import { A2, A3, A4, A5, ACME_SOURCE, GROUPS, nacm, NACM_DEVICE } from './nacm-helpers.js';
import { recordingLogger } from './ssh-helpers.js';

type Json = Record<string, JsonValue>;

let device: Device;
let engine: Nacm;

beforeAll(async () => {
  device = await loadDevice(NACM_DEVICE, { source: ACME_SOURCE });
  engine = new Nacm(device.schema, {});
});

function running(policy: Json | undefined, data: Json = {}): DataTree {
  return decodeJson(device.schema.forDatastore('running'), { ...(policy === undefined ? {} : nacm(policy)), ...data });
}

function subject(policy: Json | undefined, username: string, options: { groups?: string[]; recovery?: boolean } = {}): Subject {
  return engine.subject(running(policy), { username, ...(options.groups === undefined ? {} : { groups: options.groups }) }, options.recovery ?? false)!;
}

function rpc(module: string, name: string): RpcNode {
  const node = device.schema.module(module)!.rpcs.find((r) => r.name === name);
  if (node === undefined) throw new Error(`no rpc ${module}:${name}`);
  return node;
}

/** The data with dummy and eth0 interfaces, for instance requests. */
const INTERFACES: Json = { 'acme-itf:interfaces': { interface: [{ name: 'dummy', mtu: 1500 }, { name: 'eth0', mtu: 1500 }] } };

function entry(name: string): ListEntry {
  const tree = running(undefined, INTERFACES);
  const list = tree.child('interfaces', 'acme-itf') as unknown as { childrenNamed(n: string): InstanceNode[] };
  return list.childrenNamed('interface').find((e) => e instanceof ListEntry && e.keys[0]!.value.value === name) as ListEntry;
}

function leafOf(e: ListEntry, name: string): InstanceNode {
  return e.child(name)!;
}

function schemaNode(path: string): SchemaNode {
  const n = device.schema.find(path);
  if (n === undefined) throw new Error(`no node ${path}`);
  return n;
}

const OFF: Json = { 'enable-nacm': false, 'exec-default': 'deny', 'read-default': 'deny', groups: GROUPS };
const EXEC_DENY = (p: Json): Json => ({ ...p, 'exec-default': 'deny' });

describe('NACM-01 the policy engine', () => {
  describe('§3.4.4 protocol operations (exec)', () => {
    const rows: { why: string; policy: () => Json | undefined; user: string; groups?: string[]; recovery?: boolean; rpc: [string, string]; permit: boolean; step: number; rule?: string }[] = [
      { why: 'enable-nacm false permits anything', policy: () => OFF, user: 'nobody', rpc: ['ietf-netconf', 'kill-session'], permit: true, step: 1 },
      { why: 'a recovery session is permitted', policy: () => EXEC_DENY(A3), user: 'guest', recovery: true, rpc: ['ietf-netconf', 'delete-config'], permit: true, step: 2 },
      { why: 'close-session is always permitted', policy: () => EXEC_DENY({ ...A2, 'rule-list': [{ name: 'deny', group: ['*'], rule: [{ name: 'all', 'access-operations': '*', action: 'deny' }] }] }), user: 'guest', rpc: ['ietf-netconf', 'close-session'], permit: true, step: 3 },
      { why: 'a user in no group skips the rules (step 5): get falls to exec-default', policy: () => A2, user: 'nobody', rpc: ['ietf-netconf', 'get'], permit: true, step: 12 },
      { why: "a user in no group skips even a '*' rule-list", policy: () => ({ groups: GROUPS, 'rule-list': [{ name: 'all', group: ['*'], rule: [{ name: 'deny-get', 'module-name': 'ietf-netconf', 'rpc-name': 'get', action: 'deny' }] }] }), user: 'nobody', rpc: ['ietf-netconf', 'get'], permit: true, step: 12 },
      { why: "a '*' rule-list applies to a user in any group", policy: () => ({ groups: GROUPS, 'rule-list': [{ name: 'all', group: ['*'], rule: [{ name: 'deny-get', 'module-name': 'ietf-netconf', 'rpc-name': 'get', action: 'deny' }] }] }), user: 'guest', rpc: ['ietf-netconf', 'get'], permit: false, step: 8, rule: 'all/deny-get' },
      { why: 'A.2 permit-exec lets limited kill sessions', policy: () => A2, user: 'wilma', rpc: ['ietf-netconf', 'kill-session'], permit: true, step: 8, rule: 'limited-acl/permit-exec' },
      { why: 'A.2 permit-all lets admin delete configurations', policy: () => A2, user: 'andy', rpc: ['ietf-netconf', 'delete-config'], permit: true, step: 8, rule: 'admin-acl/permit-all' },
      { why: 'A.2 deny-ncm denies guest the monitoring module, its RPC included', policy: () => A2, user: 'guest', rpc: ['ietf-netconf-monitoring', 'get-schema'], permit: false, step: 8, rule: 'guest-acl/deny-ncm' },
      { why: 'A.2 a rule for another module does not match', policy: () => A2, user: 'guest', rpc: ['ietf-netconf', 'get-config'], permit: true, step: 12 },
      { why: 'A.2 a rule that permits beats default-deny-all', policy: () => A2, user: 'wilma', rpc: ['acme-netconf', 'reboot'], permit: true, step: 8, rule: 'limited-acl/permit-exec' },
      { why: 'A.3 deny-kill-session', policy: () => A3, user: 'bam-bam', rpc: ['ietf-netconf', 'kill-session'], permit: false, step: 8, rule: 'guest-limited-acl/deny-kill-session' },
      { why: 'A.3 deny-delete-config', policy: () => A3, user: 'guest@example.com', rpc: ['ietf-netconf', 'delete-config'], permit: false, step: 8, rule: 'guest-limited-acl/deny-delete-config' },
      { why: 'A.3 permit-edit-config matters once exec-default is deny', policy: () => EXEC_DENY(A3), user: 'wilma', rpc: ['ietf-netconf', 'edit-config'], permit: true, step: 8, rule: 'limited-acl/permit-edit-config' },
      { why: 'A.3 guest has no edit-config rule, so exec-default deny refuses it', policy: () => EXEC_DENY(A3), user: 'guest', rpc: ['ietf-netconf', 'edit-config'], permit: false, step: 12 },
      { why: 'A.3 an rpc-name rule does not match another operation', policy: () => A3, user: 'guest', rpc: ['ietf-netconf', 'lock'], permit: true, step: 12 },
      { why: 'nacm:default-deny-all on an rpc denies it', policy: () => A3, user: 'guest', rpc: ['acme-netconf', 'reboot'], permit: false, step: 10 },
      { why: 'without a rule, kill-session is denied whatever exec-default says', policy: () => A2, user: 'guest', rpc: ['ietf-netconf', 'kill-session'], permit: false, step: 11 },
      { why: 'without a rule, delete-config is denied', policy: () => undefined, user: 'anyone', rpc: ['ietf-netconf', 'delete-config'], permit: false, step: 11 },
      { why: 'with no /nacm, exec-default permit applies', policy: () => undefined, user: 'anyone', rpc: ['acme-netconf', 'ping'], permit: true, step: 12 },
      { why: 'transport groups count when enable-external-groups is true', policy: () => A2, user: 'carol', groups: ['admin'], rpc: ['ietf-netconf', 'delete-config'], permit: true, step: 8, rule: 'admin-acl/permit-all' },
      { why: 'transport groups are ignored when enable-external-groups is false', policy: () => ({ ...A2, 'enable-external-groups': false }), user: 'carol', groups: ['admin'], rpc: ['ietf-netconf', 'delete-config'], permit: false, step: 11 },
    ];
    for (const r of rows) {
      it(`step ${r.step}: ${r.why}`, () => {
        const s = subject(r.policy(), r.user, { ...(r.groups === undefined ? {} : { groups: r.groups }), ...(r.recovery === undefined ? {} : { recovery: r.recovery }) });
        const v = decideExec(s, rpc(...r.rpc));
        expect(v).toEqual({ permit: r.permit, step: r.step, ...(r.rule === undefined ? {} : { rule: r.rule }) });
      });
    }
  });

  describe('§3.4.5 data nodes', () => {
    const rows: { why: string; policy: () => Json | undefined; user: string; recovery?: boolean; target: () => SchemaNode | InstanceNode; access: AccessOperation; permit: boolean; step: number; rule?: string }[] = [
      { why: 'enable-nacm false permits anything', policy: () => OFF, user: 'guest', target: () => schemaNode('/acme-netconf:acme-netconf/secret/key'), access: 'read', permit: true, step: 1 },
      { why: 'a recovery session is permitted', policy: () => A4, user: 'guest', recovery: true, target: () => schemaNode('/ietf-netconf-acm:nacm'), access: 'update', permit: true, step: 2 },
      { why: 'A.4 deny-nacm denies guest /nacm', policy: () => A4, user: 'guest', target: () => schemaNode('/ietf-netconf-acm:nacm'), access: 'read', permit: false, step: 7, rule: 'guest-acl/deny-nacm' },
      { why: 'A.4 a path rule covers descendants', policy: () => A4, user: 'guest', target: () => schemaNode('/ietf-netconf-acm:nacm/groups/group/name'), access: 'create', permit: false, step: 7, rule: 'guest-acl/deny-nacm' },
      { why: 'A.4 permit-acme-config lets limited create config parameters', policy: () => A4, user: 'wilma', target: () => schemaNode('/acme-netconf:acme-netconf/config-parameters/speed'), access: 'create', permit: true, step: 7, rule: 'limited-acl/permit-acme-config' },
      { why: 'A.4 permit-dummy-interface lets limited update the dummy entry', policy: () => A4, user: 'wilma', target: () => leafOf(entry('dummy'), 'mtu'), access: 'update', permit: true, step: 7, rule: 'guest-limited-acl/permit-dummy-interface' },
      { why: 'A.4 but not create it: write-default deny', policy: () => A4, user: 'wilma', target: () => entry('dummy'), access: 'create', permit: false, step: 12 },
      { why: 'A.4 a keyed rule does not match another entry', policy: () => A4, user: 'guest', target: () => leafOf(entry('eth0'), 'mtu'), access: 'update', permit: false, step: 12 },
      { why: 'A.4 a keyed rule does not match a request that names no instance', policy: () => A4, user: 'guest', target: () => schemaNode('/acme-itf:interfaces/interface/mtu'), access: 'update', permit: false, step: 12 },
      { why: 'A.4 permit-interface lets admin delete any entry', policy: () => A4, user: 'admin', target: () => entry('eth0'), access: 'delete', permit: true, step: 7, rule: 'admin-acl/permit-interface' },
      { why: 'A.4 reading an entry no rule covers falls to read-default', policy: () => A4, user: 'guest', target: () => entry('eth0'), access: 'read', permit: true, step: 11 },
      { why: 'A.2 a module rule covers its data', policy: () => A2, user: 'guest', target: () => schemaNode('/ietf-netconf-monitoring:netconf-state/sessions'), access: 'read', permit: false, step: 7, rule: 'guest-acl/deny-ncm' },
      { why: 'A.3 a protocol-operation rule never matches data', policy: () => ({ groups: GROUPS, 'rule-list': [{ name: 'l', group: ['guest'], rule: [{ name: 'r', 'module-name': 'acme-netconf', 'rpc-name': '*', action: 'permit' }] }] }), user: 'guest', target: () => schemaNode('/acme-netconf:acme-netconf/secret'), access: 'read', permit: false, step: 9 },
      { why: 'default-deny-all hides a node from reads', policy: () => A4, user: 'wilma', target: () => schemaNode('/acme-netconf:acme-netconf/secret'), access: 'read', permit: false, step: 9 },
      { why: "default-deny-all on an ancestor covers its descendants", policy: () => A4, user: 'wilma', target: () => schemaNode('/acme-netconf:acme-netconf/secret/key'), access: 'read', permit: false, step: 9 },
      { why: '/nacm itself is default-deny-all', policy: () => A4, user: 'wilma', target: () => schemaNode('/ietf-netconf-acm:nacm/groups'), access: 'read', permit: false, step: 9 },
      { why: 'default-deny-write refuses writes even with write-default permit', policy: () => ({ ...A4, 'write-default': 'permit' }), user: 'wilma', target: () => schemaNode('/acme-netconf:acme-netconf/protected/value'), access: 'update', permit: false, step: 10 },
      { why: 'default-deny-all refuses writes too', policy: () => ({ ...A4, 'write-default': 'permit' }), user: 'wilma', target: () => schemaNode('/acme-netconf:acme-netconf/secret/key'), access: 'delete', permit: false, step: 10 },
      { why: 'default-deny-write does not hide a node from reads', policy: () => A4, user: 'wilma', target: () => schemaNode('/acme-netconf:acme-netconf/protected/value'), access: 'read', permit: true, step: 11 },
      { why: 'read-default deny hides what no rule covers', policy: () => ({ ...A4, 'read-default': 'deny' }), user: 'guest', target: () => entry('eth0'), access: 'read', permit: false, step: 11 },
      { why: 'write-default permit allows what no rule covers', policy: () => ({ ...A4, 'write-default': 'permit' }), user: 'guest', target: () => leafOf(entry('eth0'), 'mtu'), access: 'update', permit: true, step: 12 },
      { why: 'exec on an action no rule covers falls to exec-default', policy: () => A4, user: 'wilma', target: () => schemaNode('/acme-itf:interfaces/interface/reset'), access: 'exec', permit: true, step: 13 },
      { why: 'exec-default deny refuses it', policy: () => EXEC_DENY(A4), user: 'wilma', target: () => schemaNode('/acme-itf:interfaces/interface/reset'), access: 'exec', permit: false, step: 13 },
      { why: 'a user in no group goes straight to the defaults', policy: () => A4, user: 'nobody', target: () => schemaNode('/ietf-netconf-acm:nacm'), access: 'read', permit: false, step: 9 },
      { why: "a rule whose path doesn't resolve never matches", policy: () => ({ groups: GROUPS, 'rule-list': [{ name: 'l', group: ['guest'], rule: [{ name: 'gone', path: '/acme-netconf:acme-netconf/nowhere', action: 'deny' }] }] }), user: 'guest', target: () => entry('eth0'), access: 'read', permit: true, step: 11 },
    ];
    for (const r of rows) {
      it(`step ${r.step}: ${r.why}`, () => {
        const s = subject(r.policy(), r.user, r.recovery === undefined ? {} : { recovery: r.recovery });
        expect(decideData(s, r.target(), r.access)).toEqual({ permit: r.permit, step: r.step, ...(r.rule === undefined ? {} : { rule: r.rule }) });
      });
    }
  });

  describe('§3.4.6 notifications', () => {
    const notif = (module: string, name: string): SchemaNode => device.schema.module(module)!.notifications.find((n) => n.name === name)!;
    const rows: { why: string; policy: () => Json | undefined; user: string; recovery?: boolean; target: () => SchemaNode | InstanceNode; permit: boolean; step: number; rule?: string }[] = [
      { why: 'enable-nacm false permits anything', policy: () => OFF, user: 'guest', target: () => notif('acme-system', 'sys-alarm'), permit: true, step: 1 },
      { why: 'a recovery session is permitted', policy: () => A5, user: 'guest', recovery: true, target: () => notif('acme-system', 'sys-config-change'), permit: true, step: 2 },
      { why: 'replayComplete is always permitted', policy: () => ({ ...A5, 'read-default': 'deny' }), user: 'guest', target: () => notif('nc-notifications', 'replayComplete'), permit: true, step: 3 },
      { why: 'notificationComplete is always permitted', policy: () => ({ ...A5, 'read-default': 'deny' }), user: 'guest', target: () => notif('nc-notifications', 'notificationComplete'), permit: true, step: 3 },
      { why: 'A.5 deny-config-change drops it for guest', policy: () => A5, user: 'guest', target: () => notif('acme-system', 'sys-config-change'), permit: false, step: 8, rule: 'sys-acl/deny-config-change' },
      { why: 'A.5 admin has no rule-list, so read-default applies', policy: () => A5, user: 'admin', target: () => notif('acme-system', 'sys-config-change'), permit: true, step: 11 },
      { why: 'A.5 a notification-name rule does not match another notification', policy: () => A5, user: 'wilma', target: () => notif('ietf-netconf-notifications', 'netconf-config-change'), permit: true, step: 11 },
      { why: 'default-deny-all drops it', policy: () => A5, user: 'admin', target: () => notif('acme-system', 'sys-alarm'), permit: false, step: 10 },
      { why: 'a module rule permits it over default-deny-all', policy: () => A2, user: 'admin', target: () => notif('acme-system', 'sys-alarm'), permit: true, step: 8, rule: 'admin-acl/permit-all' },
      { why: 'read-default deny drops it', policy: () => ({ ...A5, 'read-default': 'deny' }), user: 'nobody', target: () => notif('acme-system', 'sys-config-change'), permit: false, step: 11 },
      { why: 'a nested notification is read access to a data node (§3.4.5): a path rule decides it', policy: () => ({ groups: GROUPS, 'rule-list': [{ name: 'l', group: ['guest'], rule: [{ name: 'no-itf', path: '/acme-itf:interfaces', 'access-operations': 'read', action: 'deny' }] }] }), user: 'guest', target: () => schemaNode('/acme-itf:interfaces/interface/link-flap'), permit: false, step: 7, rule: 'l/no-itf' },
      { why: 'a nested notification no rule covers falls to read-default (§3.4.5 step 11)', policy: () => A5, user: 'guest', target: () => schemaNode('/acme-itf:interfaces/interface/link-flap'), permit: true, step: 11 },
    ];
    for (const r of rows) {
      it(`step ${r.step}: ${r.why}`, () => {
        const s = subject(r.policy(), r.user, r.recovery === undefined ? {} : { recovery: r.recovery });
        expect(decideNotification(s, r.target())).toEqual({ permit: r.permit, step: r.step, ...(r.rule === undefined ? {} : { rule: r.rule }) });
      });
    }
  });
});

describe('NACM-01 compiling and caching the policy', () => {
  it('compiles groups by user, rule-lists and rules in order, with module-name and access-operations defaulting to *', () => {
    const p = engine.policy(running(A4));
    expect([...p.groupsByUser.get('andy')!]).toEqual(['admin']);
    expect(p.ruleLists.map((l) => l.name)).toEqual(['guest-acl', 'limited-acl', 'guest-limited-acl', 'admin-acl']);
    const deny = p.ruleLists[0]!.rules[0]!;
    expect(deny.moduleName).toBe('*');
    expect(deny.operations).toBe('*');
    expect([...(p.ruleLists[1]!.rules[0]!.operations as Set<string>)].sort()).toEqual(['create', 'delete', 'read', 'update']);
    expect([p.enabled, p.readDefault, p.writeDefault, p.execDefault, p.externalGroups]).toEqual([true, 'permit', 'deny', 'permit', true]);
  });

  it("uses RFC 8341's defaults when there is no /nacm: reads permitted, writes denied, operations permitted", () => {
    const p = engine.policy(running(undefined));
    expect([p.enabled, p.readDefault, p.writeDefault, p.execDefault, p.ruleLists.length]).toEqual([true, 'permit', 'deny', 'permit', 0]);
  });

  it('compiles a /nacm node once, and warns once per compile about a path that never matches', () => {
    const { logger, entries } = recordingLogger();
    const e = new Nacm(device.schema, logger);
    const tree = running({ groups: GROUPS, 'rule-list': [{ name: 'l', group: ['guest'], rule: [{ name: 'gone', path: '/acme-netconf:acme-netconf/nowhere', action: 'deny' }] }] });
    const first = e.policy(tree);
    expect(e.policy(tree)).toBe(first);
    expect(entries.filter((x) => x.level === 'warn').map((x) => x.message)).toEqual(['NACM rule l/gone: path /acme-netconf:acme-netconf/nowhere never matches']);
    // A new /nacm node is a new policy, compiled (and warned about) again.
    expect(e.policy(running({ groups: GROUPS, 'rule-list': [{ name: 'l', group: ['guest'], rule: [{ name: 'gone', path: '/acme-netconf:acme-netconf/nowhere', action: 'deny' }] }] }))).not.toBe(first);
    expect(entries.filter((x) => x.level === 'warn')).toHaveLength(2);
  });

  it('shares the groups and rule-lists of sessions with the same group set', () => {
    const tree = running(A4);
    const a = engine.subject(tree, { username: 'wilma' }, false)!;
    const b = engine.subject(tree, { username: 'bam-bam' }, false)!;
    expect(b.ruleLists).toBe(a.ruleLists);
    expect(a.ruleLists.map((l) => l.name)).toEqual(['limited-acl', 'guest-limited-acl']);
  });

  it('checks nothing when the device lacks ietf-netconf-acm', async () => {
    const plain = await loadDevice({ id: 'plain', yang: { modules: [] } });
    const e = new Nacm(plain.schema, {});
    expect(e.subject(new DataTree(plain.schema), { username: 'guest' }, false)).toBeUndefined();
    expect(e.enforced).toBe(false);
    expect(e.stateJson()).toEqual({});
  });
});
