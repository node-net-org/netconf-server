/**
 * @node-net/netconf's YANG 1.1 action and RPC calls against this server
 * (OPS-28, CONTENT-14): a real server implementation
 * answering <action>, where netopeer2 would need a sysrepo subscriber. The
 * client connects in-process and reads the modules through the server's YANG
 * library and <get-schema>, so its JSON conversion uses the same schema.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { connect, RpcError, x, type NetconfClient } from '@node-net/netconf';
import { PT, providersSession } from './providers-helpers.js';
import type { NetconfServer, OperationCall } from '../src/core.js';

const IF = '/providers-test:interfaces/interface';

const servers: NetconfServer[] = [];
const clients: NetconfClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup() {
  const { srv } = await providersSession();
  servers.push(srv);
  const calls: OperationCall[] = [];
  await srv.provide(IF, { actions: { [`${IF}/reset`]: (call) => (calls.push(call), { result: `reset ${call.path} after ${JSON.stringify(call.input['delay'] ?? 0)}` }) } });
  await srv.provide('/providers-test:system', { rpcs: { 'providers-test:restart': (call) => (calls.push(call), { when: `in ${JSON.stringify(call.input['after'])}s` }) } });
  const client = await connect({ transport: srv.transport(), yang: { requireSchema: true } });
  clients.push(client);
  return { srv, client, calls };
}

describe('@node-net/netconf actions and RPCs against @node-net/netconf-server', () => {
  it('content.invoke runs an action on a list entry with JSON input, and resolves with typed JSON output', async () => {
    const { client, calls } = await setup();
    const out = await client.content.invoke(`${IF}[name="eth1"]/reset`, { delay: 3 });
    expect(out).toEqual({ result: "reset /providers-test:interfaces/interface[name='eth1'] after 3" });
    expect(calls.map((c) => [c.path, c.input])).toEqual([["/providers-test:interfaces/interface[name='eth1']", { delay: 3 }]]);
  });

  it('content.invoke runs an RPC by path, and gives XML output with format xml', async () => {
    const { client } = await setup();
    expect(await client.content.invoke('/providers-test:restart', { after: 5 })).toEqual({ when: 'in 5s' });
    const xml = await client.content.invoke('/providers-test:restart', { after: 7 }, { format: 'xml' });
    expect(xml.map((e) => [e.name, e.ns, e.text()])).toEqual([['when', PT, 'in 7s']]);
  });

  it('ops.action sends an XML or JSON target tree, and the reply carries the output', async () => {
    const { client } = await setup();
    const reply = await client.ops.action(x('interfaces', { xmlns: PT }, x('interface', x('name', 'eth0'), x('reset', x('delay', '1')))));
    expect(reply.output.map((e) => e.text())).toEqual(["reset /providers-test:interfaces/interface[name='eth0'] after 1"]);
    const viaJson = await client.ops.action({ 'providers-test:interfaces': { interface: [{ name: 'eth0', reset: {} }] } });
    expect(viaJson.output.map((e) => e.text())).toEqual(["reset /providers-test:interfaces/interface[name='eth0'] after 0"]);
  });

  it('an action on an entry that does not exist rejects with an RpcError tagged data-missing', async () => {
    const { client, calls } = await setup();
    const err = await client.content.invoke(`${IF}[name="eth9"]/reset`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).errors.map((e) => e.tag)).toEqual(['data-missing']);
    expect(calls).toEqual([]);
  });
});
