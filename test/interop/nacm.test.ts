/**
 * Differential NACM against netopeer2 (NACM design §11 item 3, NACM-11):
 * the same reads, writes and denied operations, as the same two users, on
 * both servers under the same policy.
 *
 * - admin: `netconf` over SSH, in netopeer2's nn-admin group with a
 *   permit-all rule (scripts/netopeer2.sh).
 * - guest: `nn-guest`, the CN of the test-only TLS certificate guest.pem,
 *   which netopeer2's cert-to-name makes a user in no NACM group. Only the
 *   defaults apply to it: read-default and write-default permit,
 *   `default-deny-all` on /nacm, kill-session and delete-config denied.
 *
 * This server gets netopeer2's modules (through <get-schema>), its /nacm
 * and its truststore (read as admin), and serves the same users in
 * process. ietf-truststore is `nacm:default-deny-write`, which gives the
 * guest a refused write without changing the policy.
 *
 * Never write /nacm as the guest on netopeer2: netopeer2 lets it, and the
 * server is shared. admin's only change to /nacm is an empty group, added
 * and removed in one case.
 *
 * Run with npm run test:interop. Skipped unless NETOPEER2_PORT is set.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, INSECURE_ACCEPT_ANY, ssh, tls, type ConnectionFactory, type NetconfClient as Client, type XmlElement } from '@node-net/netconf';
import { decodeXml, encodeJson, memorySource, type JsonValue } from '@node-net/yang/core';
import { createServer, loadDevice, type Device, type NetconfServer } from '../../src/core.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const TLS_PORT = Number(process.env['NETOPEER2_TLS_PORT'] ?? PORT + 1000);
const NAME = process.env['NETOPEER2_NAME'] ?? 'nn-netopeer2';
const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const NOTIF = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
const NCN = 'urn:ietf:params:xml:ns:yang:ietf-netconf-notifications';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const IANA = 'urn:ietf:params:xml:ns:yang:iana-if-type';
const NCM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';
const ACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';
const TS = 'urn:ietf:params:xml:ns:yang:ietf-truststore';
const YL = 'urn:ietf:params:xml:ns:yang:ietf-yang-library';

/** The test-only certificates netopeer2.sh's TLS endpoint trusts, kept with @node-net/netconf's TLS tests in the checkout beside this one. */
const fixture = (name: string): string => readFileSync(new URL(`../../../netconf/test/fixtures/tls/${name}`, import.meta.url), 'utf8');

const CONFIG = `<interfaces xmlns="${IF}" xmlns:ianaift="${IANA}">
  <interface><name>eth0</name><description>uplink</description><type>ianaift:ethernetCsmacd</type><enabled>true</enabled></interface>
</interfaces>`;

const editConfig = (config: string): string => `<edit-config xmlns="${NC}"><target><running/></target><config>${config}</config></edit-config>`;
const ifs = (body: string): string => `<interfaces xmlns="${IF}" xmlns:nc="${NC}" xmlns:ianaift="${IANA}">${body}</interfaces>`;
const BAG = `<truststore xmlns="${TS}"><certificates><name>nn-interop-bag</name><description>interop</description></certificates></truststore>`;
const REMOVE_BAG = `<truststore xmlns="${TS}" xmlns:nc="${NC}"><certificates nc:operation="remove"><name>nn-interop-bag</name></certificates></truststore>`;
const GROUP = `<nacm xmlns="${ACM}"><groups><group><name>nn-interop-empty</name></group></groups></nacm>`;
const REMOVE_GROUP = `<nacm xmlns="${ACM}" xmlns:nc="${NC}"><groups><group nc:operation="remove"><name>nn-interop-empty</name></group></groups></nacm>`;
const getConfig = (filter: string): string => `<get-config xmlns="${NC}"><source><running/></source><filter type="subtree">${filter}</filter></get-config>`;

type User = 'admin' | 'guest';

/** Reads: what each user gets back, compared as RFC 7951 JSON. */
const READS: Record<string, string> = {
  '/nacm': `<nacm xmlns="${ACM}"/>`,
  '/interfaces': `<interfaces xmlns="${IF}"/>`,
  '/truststore': `<truststore xmlns="${TS}"/>`,
};

/** Writes: requests as one user, compared by each reply's error-tags and then running's interfaces and truststore. */
const WRITES: Record<string, { user: User; requests: string[] }> = {
  'guest: merge a description (write-default permit)': { user: 'guest', requests: [editConfig(ifs('<interface><name>eth0</name><description>by guest</description></interface>'))] },
  'guest: create an interface': { user: 'guest', requests: [editConfig(ifs('<interface><name>eth7</name><type>ianaift:softwareLoopback</type></interface>'))] },
  'guest: create in the truststore (default-deny-write): access-denied': { user: 'guest', requests: [editConfig(BAG)] },
  'admin: create in the truststore (permit-all rule)': { user: 'admin', requests: [editConfig(BAG)] },
  'guest: kill-session: access-denied': { user: 'guest', requests: [`<kill-session xmlns="${NC}"><session-id>999999</session-id></kill-session>`] },
  'guest: delete-config: access-denied': { user: 'guest', requests: [`<delete-config xmlns="${NC}"><target><startup/></target></delete-config>`] },
};

/**
 * Known deviations, beside the comparisons they affect. Only error-tags
 * are compared for writes, since netopeer2 gives a refused write
 * error-type protocol where RFC 8341 §3.4.5 and this server give
 * application.
 *
 * The implicit-change deviation (NACM design §7.2: nodes an edit changes
 * implicitly are checked like explicit ones) has no case here: neither
 * module has a `when` or a `choice` an edit could flip.
 */
const ALLOWED = {
  // RFC 8341 §3.4.4 and its example give an operation's access-denied error-path as /nc:rpc/nc:<op>; netopeer2
  // names the operation's schema node.
  'operation error-path': 'netopeer2 gives /ietf-netconf:<op>; this server /nc:rpc/nc:<op>, as RFC 8341 §3.4.4 shows',
  // NACM design §12 decision 3: this server leaves out netconf-config-change edits the subscriber may not read;
  // RFC 8341 §3.4.6 lets anyone who may receive the notification type see all of it, as netopeer2 does.
  'netconf-config-change edits of unreadable data': 'netopeer2 sends the guest edits of /nacm; this server leaves them out',
};

describe.skipIf(PORT === 0)('NACM agrees with netopeer2', () => {
  let device: Device;
  let server: NetconfServer;
  let peerAdmin: ConnectionFactory;
  let peerGuest: ConnectionFactory;
  let start: JsonValue;
  const transports = (): Record<'peer' | 'ours', Record<User, ConnectionFactory>> => ({
    peer: { admin: peerAdmin, guest: peerGuest },
    ours: { admin: server.transport({ principal: { username: 'netconf' } }), guest: server.transport({ principal: { username: 'nn-guest' } }) },
  });
  const open: Client[] = [];
  const client = async (transport: ConnectionFactory): Promise<Client> => {
    const c = await connect({ transport, timeouts: { rpc: 20_000 } });
    open.push(c);
    return c;
  };

  /** Running's interfaces, truststore and /nacm, as admin sees them, as RFC 7951 JSON. */
  const configOf = async (c: Client, filter: string): Promise<JsonValue> => {
    const reply = await c.session.rpc(getConfig(filter));
    return encodeJson(decodeXml(device.schema.forDatastore('running'), reply.data?.elements ?? []));
  };

  /** Puts a server's interfaces and truststore back as they started, as admin. */
  const reset = async (admin: Client): Promise<void> => {
    await admin.session.rpc(editConfig(REMOVE_BAG)).catch(() => undefined);
    await admin.session.rpc(editConfig(REMOVE_GROUP)).catch(() => undefined);
    await admin.session.rpc(`<edit-config xmlns="${NC}"><target><running/></target><config>${ifs(`<interface nc:operation="remove"><name>eth7</name></interface>`)}</config></edit-config>`).catch(() => undefined);
    await admin.session.rpc(`<edit-config xmlns="${NC}"><target><running/></target><config>${CONFIG.replace('<interfaces ', `<interfaces xmlns:nc="${NC}" nc:operation="replace" `)}</config></edit-config>`);
  };

  beforeAll(async () => {
    spawnSync('docker', ['exec', NAME, 'sysrepoctl', '-i', '/opt/dev/sysrepo/tests/files/iana-if-type.yang'], { stdio: 'ignore' });
    peerAdmin = ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: INSECURE_ACCEPT_ANY });
    peerGuest = tls({ host: 'localhost', port: TLS_PORT, cert: fixture('guest.pem'), key: fixture('guest.key'), ca: fixture('ca.pem') });
    const admin = await connect({ transport: peerAdmin, timeouts: { rpc: 20_000 } });
    await reset(admin);
    const modules = ['ietf-interfaces', 'iana-if-type', 'ietf-truststore', 'ietf-crypto-types'];
    const schema = async (name: string): Promise<string> =>
      (await admin.session.rpc(`<get-schema xmlns="${NCM}"><identifier>${name}</identifier></get-schema>`)).element.child('data', NCM)!.text();
    // The features netopeer2 enables, from its YANG library.
    const library = await admin.session.rpc(`<get xmlns="${NC}"><filter><yang-library xmlns="${YL}"><module-set><module/></module-set></yang-library></filter></get>`);
    const features: Record<string, string[]> = {};
    for (const m of library.data?.child('yang-library', YL)?.child('module-set', YL)?.elements.filter((e) => e.name === 'module') ?? []) {
      const name = m.child('name', YL)?.text() ?? '';
      if (modules.includes(name)) features[name] = m.elements.filter((e) => e.name === 'feature').map((e) => e.text());
    }
    device = await loadDevice(
      {
        id: 'interop-nacm',
        yang: { modules: ['ietf-netconf-acm', ...modules], features },
        capabilities: { candidate: true, writableRunning: true, startup: true, notification: true, interleave: true },
      },
      { source: memorySource(await Promise.all(modules.map(async (m) => ({ text: await schema(m) })))) },
    );
    // The same policy and truststore as netopeer2's, and the same interfaces.
    const peerRunning = await admin.session.rpc(getConfig(`<nacm xmlns="${ACM}"/><truststore xmlns="${TS}"/><interfaces xmlns="${IF}"/>`));
    start = encodeJson(decodeXml(device.schema.forDatastore('running'), peerRunning.data?.elements ?? []));
    await admin.close();
    server = await createServer({ device, control: { enabled: false } });
    await server.running.applyExternal(start, { source: 'netopeer2' });
  });

  afterAll(async () => {
    for (const c of open) await c.close().catch(() => undefined);
    if (peerAdmin !== undefined) {
      const admin = await connect({ transport: peerAdmin, timeouts: { rpc: 20_000 } }).catch(() => undefined);
      if (admin !== undefined) {
        await reset(admin).catch(() => undefined);
        await admin.close();
      }
    }
    await server?.close();
  });

  it('both start from the same policy, with admin in a group and the guest in none', async () => {
    const t = transports();
    const theirs = await configOf(await client(t.peer.admin), `<nacm xmlns="${ACM}"/>`);
    expect(await configOf(await client(t.ours.admin), `<nacm xmlns="${ACM}"/>`)).toEqual(theirs);
    expect(JSON.stringify(theirs)).toContain('netconf');
    expect(JSON.stringify(theirs)).not.toContain('nn-guest');
  });

  for (const user of ['admin', 'guest'] as const) {
    for (const [name, filter] of Object.entries(READS)) {
      it(`${user} reads ${name}`, async () => {
        const t = transports();
        const theirs = await configOf(await client(t.peer[user]), filter);
        const mine = await configOf(await client(t.ours[user]), filter);
        expect(mine).toEqual(theirs);
        // So that agreement is not two empty answers where the user may read.
        if (user === 'admin' || name !== '/nacm') expect(theirs).not.toEqual({});
        if (user === 'guest' && name === '/nacm') expect(theirs).toEqual({});
      });
    }
  }

  /** Each reply's error-tags (empty for ok), then the interfaces and truststore admin sees. */
  const outcome = async (side: 'peer' | 'ours', user: User, requests: readonly string[]): Promise<{ tags: string[][]; running: JsonValue }> => {
    const t = transports()[side];
    const admin = await client(t.admin);
    await reset(admin);
    const c = await client(t[user]);
    const tags: string[][] = [];
    for (const request of requests) {
      try {
        await c.session.rpc(request);
        tags.push([]);
      } catch (err) {
        const e = err as { errors?: { tag: string }[]; tag?: string };
        tags.push(e.errors?.map((x) => x.tag) ?? [e.tag ?? String(err)]);
      }
    }
    const running = await configOf(admin, `<interfaces xmlns="${IF}"/><truststore xmlns="${TS}"/>`);
    await reset(admin);
    return { tags, running };
  };

  for (const [name, { user, requests }] of Object.entries(WRITES)) {
    it(name, async () => {
      const theirs = await outcome('peer', user, requests);
      const mine = await outcome('ours', user, requests);
      expect(mine).toEqual(theirs);
      if (name.endsWith('access-denied')) expect(mine.tags).toEqual([['access-denied']]);
    });
  }

  it('admin may run kill-session: neither server refuses it access', async () => {
    // Session 999999 doesn't exist, so both fail it, but not for access. netopeer2 answers operation-failed twice
    // where this server answers invalid-value, as the writes interop file records for type errors.
    const t = transports();
    for (const transport of [t.peer.admin, t.ours.admin]) {
      const err = (await (await client(transport)).session.rpc(`<kill-session xmlns="${NC}"><session-id>999999</session-id></kill-session>`).catch((e: unknown) => e)) as {
        errors?: { tag: string }[];
      };
      expect(err.errors?.length).toBeGreaterThan(0);
      expect(err.errors?.map((e) => e.tag)).not.toContain('access-denied');
    }
  });

  it(`deviation: ${ALLOWED['operation error-path']}`, async () => {
    const t = transports();
    const path = async (transport: ConnectionFactory): Promise<string | undefined> => {
      const err = (await (await client(transport)).session.rpc(`<kill-session xmlns="${NC}"><session-id>999999</session-id></kill-session>`).catch((e: unknown) => e)) as {
        errors?: { tag: string; path?: string }[];
      };
      expect(err.errors?.[0]?.tag).toBe('access-denied');
      return err.errors?.[0]?.path;
    };
    expect(await path(t.peer.guest)).toBe('/ietf-netconf:kill-session');
    expect(await path(t.ours.guest)).toBe('/nc:rpc/nc:kill-session');
  });

  it(`deviation: ${ALLOWED['netconf-config-change edits of unreadable data']}`, async () => {
    /** The edit targets of the netconf-config-changes the guest receives while admin edits an interface and /nacm in one edit. */
    const targets = async (side: 'peer' | 'ours'): Promise<string[]> => {
      const t = transports()[side];
      const admin = await client(t.admin);
      await reset(admin);
      const guest = await client(t.guest);
      const changes: XmlElement[] = [];
      guest.session.onNotification((n) => {
        if (n.event?.name === 'netconf-config-change' && n.event.ns === NCN) changes.push(n.event);
      });
      await guest.session.rpc(`<create-subscription xmlns="${NOTIF}"/>`);
      try {
        await admin.session.rpc(editConfig(ifs('<interface><name>eth0</name><description>seen</description></interface>') + GROUP));
        await expect.poll(() => changes.length, { timeout: 5000 }).toBeGreaterThan(0);
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        await reset(admin);
      }
      return changes[0]!.elements.filter((e) => e.name === 'edit').map((e) => e.child('target', NCN)!.text().trim());
    };
    const theirs = await targets('peer');
    const mine = await targets('ours');
    // Both tell the guest about the interface; only netopeer2 tells it about /nacm.
    expect(theirs.some((p) => p.includes('interface'))).toBe(true);
    expect(mine.some((p) => p.includes('interface'))).toBe(true);
    expect(theirs.some((p) => p.includes('nacm'))).toBe(true);
    expect(mine.some((p) => p.includes('nacm'))).toBe(false);
  });
});
