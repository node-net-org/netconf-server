/**
 * Differential reads against netopeer2 (design §15.2, READ-04 AC5): the same
 * modules, the same configuration and the same filters, sent to netopeer2 and
 * to this server, must give the same data. The modules come from netopeer2
 * itself through <get-schema>, so both sides compile the same text.
 *
 * Run with npm run test:interop, which starts the container. Skipped unless
 * NETOPEER2_PORT is set.
 */

import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
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
  <interface><name>eth1</name><description>spare</description><type>ianaift:ethernetCsmacd</type><enabled>false</enabled></interface>
  <interface><name>lo0</name><type>ianaift:softwareLoopback</type><enabled>true</enabled></interface>
</interfaces>`;

/** Filters both servers answer, by name. A deviation found later goes in ALLOWED with the reason. */
const CASES: Record<string, string> = {
  'selection of the container': `<filter><interfaces xmlns="${IF}"/></filter>`,
  'content match on a key: the whole entry': `<filter><interfaces xmlns="${IF}"><interface><name>eth1</name></interface></interfaces></filter>`,
  'containment with selections': `<filter><interfaces xmlns="${IF}"><interface><name/><enabled/></interface></interfaces></filter>`,
  'content match on a non-key leaf with a selection': `<filter><interfaces xmlns="${IF}"><interface><enabled>false</enabled><description/></interface></interfaces></filter>`,
  'content match on an identityref': `<filter><interfaces xmlns="${IF}" xmlns:x="${IANA}"><interface><type>x:softwareLoopback</type><name/></interface></interfaces></filter>`,
  'two content matches, both true': `<filter><interfaces xmlns="${IF}"><interface><name>eth0</name><enabled>true</enabled></interface></interfaces></filter>`,
  'two content matches, one false': `<filter><interfaces xmlns="${IF}"><interface><name>eth0</name><enabled>false</enabled></interface></interfaces></filter>`,
  'a key that matches nothing': `<filter><interfaces xmlns="${IF}"><interface><name>nope</name></interface></interfaces></filter>`,
  'xpath: one leaf of one entry': `<filter type="xpath" xmlns:if="${IF}" select="/if:interfaces/if:interface[if:name='eth0']/if:description"/>`,
  'xpath: entries by a predicate': `<filter type="xpath" xmlns:if="${IF}" select="/if:interfaces/if:interface[if:enabled='false']"/>`,
};

/** Known deviations: case name → why the answers differ. Empty so far. */
const ALLOWED: Record<string, string> = {};

describe.skipIf(PORT === 0)('reads agree with netopeer2', () => {
  let peer: Client;
  let ours: Client;
  let server: NetconfServer;
  let device: Device;

  beforeAll(async () => {
    // iana-if-type isn't installed in the stock image; sysrepo ships a copy.
    spawnSync('docker', ['exec', NAME, 'sysrepoctl', '-i', '/opt/dev/sysrepo/tests/files/iana-if-type.yang'], { stdio: 'ignore' });
    peer = await connect({ transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: INSECURE_ACCEPT_ANY }), timeouts: { rpc: 20_000 } });
    await peer.session.rpc(`<edit-config xmlns="${NC}"><target><running/></target><default-operation>replace</default-operation><config><interfaces xmlns="${IF}"/></config></edit-config>`).catch(() => undefined);
    await peer.session.rpc(`<edit-config xmlns="${NC}" xmlns:nc="${NC}"><target><running/></target><config>${CONFIG.replace('<interfaces ', '<interfaces nc:operation="replace" ')}</config></edit-config>`);

    // The same modules, from netopeer2, with the features it has enabled.
    const schema = async (name: string): Promise<string> =>
      (await peer.session.rpc(`<get-schema xmlns="${NCM}"><identifier>${name}</identifier></get-schema>`)).element.child('data', NCM)!.text();
    const library = await peer.session.rpc(
      `<get xmlns="${NC}"><filter><yang-library xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library"><module-set><module><name>ietf-interfaces</name><feature/></module></module-set></yang-library></filter></get>`,
    );
    const features = library.data!.toString().match(/<feature>[^<]+<\/feature>/g)?.map((f) => f.replace(/<\/?feature>/g, '')) ?? [];
    device = await loadDevice(
      { id: 'interop', yang: { modules: ['ietf-interfaces', 'iana-if-type'], features: { 'ietf-interfaces': features } }, data: { running: 'running.xml' } },
      {
        source: memorySource([{ text: await schema('ietf-interfaces') }, { text: await schema('iana-if-type') }]),
        readData: () => Promise.resolve(CONFIG),
      },
    );
    server = await createServer({ device });
    ours = await connect({ transport: server.transport() });
  });

  afterAll(async () => {
    await ours?.close();
    await server?.close();
    await peer?.close();
  });

  /** A get-config reply's interfaces, as RFC 7951 JSON. */
  const read = async (client: Client, filter: string): Promise<JsonValue> => {
    const reply = await client.session.rpc(`<get-config xmlns="${NC}"><source><running/></source>${filter}</get-config>`);
    const elements = (reply.data?.elements ?? []).filter((e: XmlElement) => e.ns === IF);
    return encodeJson(decodeXml(device.schema.forDatastore('running'), elements));
  };

  it('both hold the same three interfaces (so agreement is not two empty answers)', async () => {
    for (const client of [peer, ours]) {
      const data = (await read(client, CASES['selection of the container']!)) as { 'ietf-interfaces:interfaces': { interface: { name: string }[] } };
      expect(data['ietf-interfaces:interfaces'].interface.map((i) => i.name)).toEqual(['eth0', 'eth1', 'lo0']);
    }
  });

  for (const [name, filter] of Object.entries(CASES)) {
    it(name, async () => {
      const [theirs, mine] = await Promise.all([read(peer, filter), read(ours, filter)]);
      if (name in ALLOWED) expect(mine, ALLOWED[name]).not.toEqual(theirs);
      else expect(mine).toEqual(theirs);
    });
  }
});
