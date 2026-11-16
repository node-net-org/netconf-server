/**
 * Differential notifications against netopeer2 (design §15.2, NOTIF-01..03):
 * create-subscription, RPCs on a subscribed session (:interleave), and the
 * RFC 6470 notifications both servers generate for the same actions,
 * compared after normalisation: eventTime, session ids and source hosts
 * dropped, and notifications compared as a list in the order each server
 * sent them, whatever their place relative to replies.
 *
 * Run with npm run test:interop. Skipped unless NETOPEER2_PORT is set.
 */

import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, INSECURE_ACCEPT_ANY, ssh, type ConnectionFactory, type NetconfClient as Client, type XmlElement } from '@node-net/netconf';
import { decodeXml, encodeJson, memorySource, type JsonValue } from '@node-net/yang/core';
import { createServer, loadDevice, type Device, type NetconfServer } from '../../src/core.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NAME = process.env['NETOPEER2_NAME'] ?? 'nn-netopeer2';
const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const NOTIF = 'urn:ietf:params:xml:ns:netconf:notification:1.0';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const IANA = 'urn:ietf:params:xml:ns:yang:iana-if-type';
const NCM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';

const CONFIG = `<interfaces xmlns="${IF}" xmlns:ianaift="${IANA}">
  <interface><name>eth0</name><description>uplink</description><type>ianaift:ethernetCsmacd</type><enabled>true</enabled></interface>
</interfaces>`;
const edit = (target: string, body: string): string =>
  `<edit-config xmlns="${NC}"><target><${target}/></target><config><interfaces xmlns="${IF}" xmlns:ianaift="${IANA}">${body}</interfaces></config></edit-config>`;
const SUBSCRIBE = `<create-subscription xmlns="${NOTIF}"/>`;

/** A step of a case: an RPC on the subscribed session, or opening and closing a second session. */
type Step = { readonly rpc: string } | { readonly other: 'open-close' };

/**
 * Each case: steps after subscribing (or without a subscription, for those
 * marked so); compared are each RPC's error-tags and the notifications
 * received.
 */
const CASES: Record<string, readonly Step[]> = {
  'interleave: a get-config on the subscribed session is answered': [{ rpc: `<get-config xmlns="${NC}"><source><running/></source></get-config>` }],
  'netconf-config-change after an edit of running': [{ rpc: edit('running', '<interface><name>eth0</name><description>changed</description></interface>') }],
  'netconf-session-start and netconf-session-end for another session': [{ other: 'open-close' }],
  'netconf-confirmed-commit start and complete': [
    { rpc: edit('candidate', '<interface><name>eth0</name><enabled>false</enabled></interface>') },
    { rpc: `<commit xmlns="${NC}"><confirmed/><confirm-timeout>120</confirm-timeout></commit>` },
    { rpc: `<commit xmlns="${NC}"/>` },
  ],
  'a second create-subscription: in-use': [{ rpc: SUBSCRIBE }],
};

/** Cases run on a session with no subscription. */
const UNSUBSCRIBED: Record<string, readonly Step[]> = {
  'stopTime without startTime': [{ rpc: `<create-subscription xmlns="${NOTIF}"><stopTime>2099-01-01T00:00:00Z</stopTime></create-subscription>` }],
};

/** Known deviations: case name → why the outcomes differ. */
const ALLOWED: Record<string, string> = {
  // RFC 6470 §2.1.1 has the server send netconf-confirmed-commit for each step of a confirmed commit. netopeer2
  // sends none; this server sends start and complete here, and the config changes agree.
  'netconf-confirmed-commit start and complete': 'netopeer2 sends no netconf-confirmed-commit',
  // RFC 5277 doesn't name the error for a second subscription on a session. netopeer2 answers operation-failed
  // twice; this server answers in-use (RFC 6241 Appendix A: the resource, the session's subscription, is in use).
  'a second create-subscription: in-use': 'netopeer2 answers operation-failed; this server answers in-use',
};

/**
 * Fields normalised away, with why. RFC 6470's changed-by names the user
 * of the session that made the change. netopeer2 names the system user
 * sysrepo runs as (root), not the NETCONF user; this server names the
 * NETCONF user. Both are compared with the user dropped from changed-by.
 */
const NORMALISED = ['session-id', 'source-host', 'killed-by'];

describe.skipIf(PORT === 0)('notifications agree with netopeer2', () => {
  let device: Device;
  let server: NetconfServer;
  let peerTransport: ConnectionFactory;
  const clients: Client[] = [];

  beforeAll(async () => {
    spawnSync('docker', ['exec', NAME, 'sysrepoctl', '-i', '/opt/dev/sysrepo/tests/files/iana-if-type.yang'], { stdio: 'ignore' });
    peerTransport = ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: INSECURE_ACCEPT_ANY });
    const peer = await connect({ transport: peerTransport, timeouts: { rpc: 20_000 } });
    const schema = async (name: string): Promise<string> =>
      (await peer.session.rpc(`<get-schema xmlns="${NCM}"><identifier>${name}</identifier></get-schema>`)).element.child('data', NCM)!.text();
    device = await loadDevice(
      {
        id: 'interop-notifications',
        yang: { modules: ['ietf-interfaces', 'iana-if-type'] },
        // netopeer2's protocol capabilities, as far as these cases go.
        capabilities: { candidate: true, writableRunning: true, startup: true, confirmedCommit: true, notification: true, interleave: true },
        data: { running: 'running.xml' },
      },
      { source: memorySource([{ text: await schema('ietf-interfaces') }, { text: await schema('iana-if-type') }]), readData: () => Promise.resolve(CONFIG) },
    );
    await peer.session.rpc(`<edit-config xmlns="${NC}"><target><running/></target><default-operation>replace</default-operation><config>${CONFIG}</config></edit-config>`);
    await peer.close();
    server = await createServer({ device, control: { enabled: false } });
  });

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await server?.close();
  });

  /** A notification as RFC 7951 JSON, without what differs between servers by nature. */
  const normalise = (event: XmlElement | undefined): JsonValue => {
    if (event === undefined) return null;
    const json = encodeJson(decodeXml(device.schema, [event], { type: 'notification', unknown: 'skip' })) as Record<string, Record<string, JsonValue>>;
    const strip = (v: JsonValue): JsonValue => {
      if (Array.isArray(v)) return v.map(strip);
      if (typeof v !== 'object' || v === null) return v;
      return Object.fromEntries(Object.entries(v).filter(([k]) => !NORMALISED.includes(k)).map(([k, x]) => [k, k === 'changed-by' ? withoutUser(x) : strip(x)]));
    };
    const withoutUser = (v: JsonValue): JsonValue => (typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'username' && !NORMALISED.includes(k))) : v);
    return strip(json);
  };

  const outcome = async (transport: ConnectionFactory, steps: readonly Step[], subscribe = true): Promise<{ tags: string[][]; notifications: JsonValue[] }> => {
    const client = await connect({ transport, timeouts: { rpc: 20_000 } });
    clients.push(client);
    const received: XmlElement[] = [];
    client.session.onNotification((n) => {
      if (n.event !== undefined) received.push(n.event);
    });
    if (subscribe) await client.session.rpc(SUBSCRIBE);
    const tags: string[][] = [];
    for (const step of steps) {
      if ('other' in step) {
        const other = await connect({ transport });
        await other.close();
        continue;
      }
      try {
        await client.session.rpc(step.rpc);
        tags.push([]);
      } catch (err) {
        const e = err as { errors?: { tag: string }[]; tag?: string };
        tags.push(e.errors?.map((x) => x.tag) ?? [e.tag ?? String(err)]);
      }
    }
    // Give notifications sent after the last reply time to arrive.
    await new Promise((r) => setTimeout(r, 500));
    const caused = received.map(normalise);
    await client.session.rpc(`<edit-config xmlns="${NC}"><target><running/></target><default-operation>replace</default-operation><config>${CONFIG}</config></edit-config>`).catch(() => undefined);
    await client.close();
    return { tags, notifications: caused };
  };

  for (const [name, steps, subscribe] of [...Object.entries(CASES).map(([n, s]) => [n, s, true] as const), ...Object.entries(UNSUBSCRIBED).map(([n, s]) => [n, s, false] as const)]) {
    it(name, async () => {
      const theirs = await outcome(peerTransport, steps, subscribe);
      const mine = await outcome(server.transport({ principal: { username: 'netconf' } }), steps, subscribe);
      if (name in ALLOWED) expect(mine, ALLOWED[name]).not.toEqual(theirs);
      else expect(mine).toEqual(theirs);
    });
  }
});
