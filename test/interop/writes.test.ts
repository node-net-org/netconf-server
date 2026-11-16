/**
 * Differential writes against netopeer2 (design §15.2, WRITE-04 AC7): the
 * same edits, sent to netopeer2 and to this server from the same starting
 * configuration, must leave the same configuration, or fail with the same
 * error-tags. The modules come from netopeer2 through <get-schema>, as in
 * reads.test.ts.
 *
 * Run with npm run test:interop. Skipped unless NETOPEER2_PORT is set.
 */

import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, INSECURE_ACCEPT_ANY, ssh, type NetconfClient as Client, type XmlElement } from '@node-net/netconf';
import { decodeXml, encodeJson, memorySource, type JsonValue } from '@node-net/yang/core';
import { createServer, loadDevice, type Device, type NetconfServer } from '../../src/core.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NAME = process.env['NETOPEER2_NAME'] ?? 'nn-netopeer2';
const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const IANA = 'urn:ietf:params:xml:ns:yang:iana-if-type';
const NCM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring';

const CONFIG = `<interfaces xmlns="${IF}" xmlns:ianaift="${IANA}">
  <interface><name>eth0</name><description>uplink</description><type>ianaift:ethernetCsmacd</type><enabled>true</enabled></interface>
  <interface><name>lo0</name><type>ianaift:softwareLoopback</type><enabled>true</enabled></interface>
</interfaces>`;

const ifs = (body: string): string => `<interfaces xmlns="${IF}" xmlns:nc="${NC}" xmlns:ianaift="${IANA}">${body}</interfaces>`;
const edit = (target: string, config: string, params = ''): string =>
  `<edit-config xmlns="${NC}"><target><${target}/></target>${params}<config>${config}</config></edit-config>`;

/** Each case: requests sent in order on one session; the outcome compared is every reply's error-tags and running afterwards. */
const CASES: Record<string, string[]> = {
  'merge a leaf into running': [edit('running', ifs('<interface><name>eth0</name><description>changed</description></interface>'))],
  'create a list entry': [edit('running', ifs('<interface nc:operation="create"><name>eth1</name><type>ianaift:ethernetCsmacd</type></interface>'))],
  'delete a list entry': [edit('running', ifs('<interface nc:operation="delete"><name>lo0</name></interface>'))],
  'replace a list entry': [edit('running', ifs('<interface nc:operation="replace"><name>eth0</name><type>ianaift:ethernetCsmacd</type></interface>'))],
  'edit the candidate and commit': [edit('candidate', ifs('<interface><name>eth0</name><enabled>false</enabled></interface>')), `<commit xmlns="${NC}"/>`],
  'edit the candidate and discard': [edit('candidate', ifs('<interface><name>eth0</name><enabled>false</enabled></interface>')), `<discard-changes xmlns="${NC}"/>`],
  'create of an existing entry: data-exists': [edit('running', ifs('<interface nc:operation="create"><name>eth0</name><type>ianaift:ethernetCsmacd</type></interface>'))],
  'delete of a missing entry: data-missing': [edit('running', ifs('<interface nc:operation="delete"><name>eth9</name></interface>'))],
  'a value of the wrong type: invalid-value': [edit('running', ifs('<interface><name>eth0</name><enabled>maybe</enabled></interface>'))],
  'an unknown element: unknown-element': [edit('running', ifs('<interface><name>eth0</name><colour>red</colour></interface>'))],
  'a missing mandatory leaf: data-missing': [edit('running', ifs('<interface><name>eth5</name></interface>'))],
  'a missing mandatory leaf in the candidate, then commit': [edit('candidate', ifs('<interface><name>eth5</name></interface>')), `<commit xmlns="${NC}"/>`],
  'lock, edit, unlock': [`<lock xmlns="${NC}"><target><running/></target></lock>`, edit('running', ifs('<interface><name>lo0</name><description>locked</description></interface>')), `<unlock xmlns="${NC}"><target><running/></target></unlock>`],
};

/**
 * Known deviations: case name → why the outcomes differ.
 *
 * Not a case anywhere (the NACM exchanges are in nacm.test.ts, whose modules
 * have no `when` or `choice` an edit could flip): RFC 8341 §3.2.5 says
 * nodes an edit changes implicitly, by a `when` turning false or by another
 * case of a `choice` being chosen, need no access. This server checks writes
 * on the diff, which can't tell those changes from explicit ones, so it
 * checks them too and may refuse an edit netopeer2 accepts (NACM design
 * §7.2, "One known deviation").
 */
const ALLOWED: Record<string, string> = {
  // RFC 6241 Appendix A: a value that isn't valid for its type is invalid-value. netopeer2 passes on libyang's
  // two validation failures as operation-failed; this server follows the RFC.
  'a value of the wrong type: invalid-value': 'netopeer2 answers operation-failed twice; RFC 6241 says invalid-value',
  // RFC 6241 §8.6.4: test-then-set, the default with :validate, validates before setting, so this server refuses the
  // edit. netopeer2 leaves the candidate unvalidated until commit, whatever the test-option, and then answers
  // operation-failed twice where RFC 7950 has data-missing. test-option set, or the candidateUnvalidated quirk
  // (src/quirks/catalogue.ts), gives this server netopeer2's timing; the error-tags at commit still differ.
  'a missing mandatory leaf in the candidate, then commit': 'netopeer2 validates the candidate only at commit',
};

describe.skipIf(PORT === 0)('writes agree with netopeer2', () => {
  let peer: Client;
  let ours: Client;
  let server: NetconfServer;
  let device: Device;

  /** Puts a client's running and candidate back to CONFIG. */
  const reset = async (client: Client): Promise<void> => {
    await client.session.rpc(`<discard-changes xmlns="${NC}"/>`).catch(() => undefined);
    await client.session.rpc(edit('running', CONFIG, '<default-operation>replace</default-operation>'));
  };

  beforeAll(async () => {
    spawnSync('docker', ['exec', NAME, 'sysrepoctl', '-i', '/opt/dev/sysrepo/tests/files/iana-if-type.yang'], { stdio: 'ignore' });
    peer = await connect({ transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: INSECURE_ACCEPT_ANY }), timeouts: { rpc: 20_000 } });
    const schema = async (name: string): Promise<string> =>
      (await peer.session.rpc(`<get-schema xmlns="${NCM}"><identifier>${name}</identifier></get-schema>`)).element.child('data', NCM)!.text();
    const library = await peer.session.rpc(
      `<get xmlns="${NC}"><filter><yang-library xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library"><module-set><module><name>ietf-interfaces</name><feature/></module></module-set></yang-library></filter></get>`,
    );
    const features = library.data!.toString().match(/<feature>[^<]+<\/feature>/g)?.map((f) => f.replace(/<\/?feature>/g, '')) ?? [];
    device = await loadDevice(
      {
        id: 'interop-writes',
        yang: { modules: ['ietf-interfaces', 'iana-if-type'], features: { 'ietf-interfaces': features } },
        // netopeer2 has a writable running and a candidate, as this device does.
        capabilities: { candidate: true, writableRunning: true, startup: true },
        data: { running: 'running.xml' },
      },
      { source: memorySource([{ text: await schema('ietf-interfaces') }, { text: await schema('iana-if-type') }]), readData: () => Promise.resolve(CONFIG) },
    );
    server = await createServer({ device });
    ours = await connect({ transport: server.transport() });
  });

  afterAll(async () => {
    if (peer !== undefined) await reset(peer).catch(() => undefined);
    await ours?.close();
    await server?.close();
    await peer?.close();
  });

  const running = async (client: Client): Promise<JsonValue> => {
    const reply = await client.session.rpc(`<get-config xmlns="${NC}"><source><running/></source><filter><interfaces xmlns="${IF}"/></filter></get-config>`);
    const elements = (reply.data?.elements ?? []).filter((e: XmlElement) => e.ns === IF);
    return encodeJson(decodeXml(device.schema.forDatastore('running'), elements));
  };

  /** Sends the requests in order; the error-tags of each reply (empty for ok), then running. */
  const outcome = async (client: Client, requests: readonly string[]): Promise<{ tags: string[][]; running: JsonValue }> => {
    await reset(client);
    const tags: string[][] = [];
    for (const request of requests) {
      try {
        await client.session.rpc(request);
        tags.push([]);
      } catch (err) {
        const e = err as { errors?: { tag: string }[]; tag?: string };
        tags.push(e.errors?.map((x) => x.tag) ?? [e.tag ?? String(err)]);
      }
    }
    return { tags, running: await running(client) };
  };

  for (const [name, requests] of Object.entries(CASES)) {
    it(name, async () => {
      const theirs = await outcome(peer, requests);
      const mine = await outcome(ours, requests);
      if (name in ALLOWED) expect(mine, ALLOWED[name]).not.toEqual(theirs);
      else expect(mine).toEqual(theirs);
    });
  }
});
