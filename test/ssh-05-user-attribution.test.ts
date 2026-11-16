// SSH-05: see which user made each change.
import { serializeXml } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { loadDeviceFile, type NetconfServer } from '../src/index.js';
import { NOTIFICATIONS } from './notify-helpers.js';
import { recordingLogger, sshClient, sshServer } from './ssh-helpers.js';

const NT = 'urn:example:notif';

async function server(logger?: ReturnType<typeof recordingLogger>['logger']): ReturnType<typeof sshServer> {
  const device = await loadDeviceFile(NOTIFICATIONS);
  return sshServer({
    server: { device, ...(logger === undefined ? {} : { logger }) },
    users: [
      { username: 'alice', password: 'a', lab: true },
      { username: 'bob', password: 'b', lab: true },
    ],
  });
}

const editPort = (port: number): string =>
  `<edit-config xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><target><running/></target><config><servers xmlns="${NT}"><server><name>a</name><port>${port}</port></server></servers></config></edit-config>`;

describe('SSH-05 user attribution', () => {
  it('names the user and session that made a change in netconf-config-change', async () => {
    const f = await server();
    const watcher = await sshClient(f.port, { username: 'bob', password: 'b' });
    const seen: string[] = [];
    watcher.session.onNotification((n) => seen.push(serializeXml(n.element)));
    await watcher.session.rpc('<create-subscription xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"/>');
    const alice = await sshClient(f.port, { username: 'alice', password: 'a' });
    await alice.session.rpc(editPort(9000));
    await expect.poll(() => seen.find((s) => s.includes('netconf-config-change'))).toBeDefined();
    const change = seen.find((s) => s.includes('netconf-config-change'))!;
    expect(change).toContain('<username>alice</username>');
    expect(change).toContain(`<session-id>${alice.session.sessionId}</session-id>`);
    expect(change).toContain('<source-host>127.0.0.1</source-host>');
    await alice.close();
    await watcher.close();
    await f.close();
  });

  it("shows the user in monitoring's sessions and locks", async () => {
    const f = await server();
    const alice = await sshClient(f.port, { username: 'alice', password: 'a' });
    await alice.ops.lock('running');
    const bob = await sshClient(f.port, { username: 'bob', password: 'b' });
    const state = serializeXml(await bob.ops.get({ filter: { 'ietf-netconf-monitoring:netconf-state': {} } }));
    expect(state).toMatch(/<session>(?:(?!<\/session>).)*<username>alice<\/username>/s);
    expect(state).toMatch(/<session>(?:(?!<\/session>).)*<username>bob<\/username>/s);
    expect(state).toMatch(/<locks>.*<locked-by-session>\d+<\/locked-by-session>/s);
    const lockedBy = Number(/<locked-by-session>(\d+)<\/locked-by-session>/.exec(state)![1]);
    expect(lockedBy).toBe(alice.session.sessionId);
    expect(f.server.sessions.find((s) => s.id === lockedBy)?.username).toBe('alice');
    await alice.close();
    await bob.close();
    await f.close();
  });

  it('puts the session id and username on every log line about a session', async () => {
    const { logger, entries } = recordingLogger();
    const f = await server(logger);
    const alice = await sshClient(f.port, { username: 'alice', password: 'a' });
    await alice.session.rpc(editPort(9001));
    await alice.ops.getConfig({ source: 'running' });
    await alice.session.rpc('<bogus xmlns="urn:example:nothing"/>').catch(() => undefined);
    await alice.close();
    await f.close();
    const aboutSessions = entries.filter((e) => 'sessionId' in e.context);
    expect(aboutSessions.length).toBeGreaterThan(4);
    for (const e of aboutSessions) expect(e.context, e.message).toMatchObject({ username: 'alice' });
  });

  it('passes every operation through one authorization check with the user, operation and datastore', async () => {
    const { logger, entries } = recordingLogger();
    const f = await server(logger);
    const alice = await sshClient(f.port, { username: 'alice', password: 'a' });
    await alice.ops.getConfig({ source: 'candidate' });
    await alice.session.rpc(editPort(9002));
    await alice.ops.lock('running');
    await alice.session.rpc('<get-data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda" xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores"><datastore>ds:operational</datastore></get-data>').catch(() => undefined);
    const checks = entries.filter((e) => e.message.startsWith('Request '));
    expect(checks.map((c) => [c.context['username'], c.context['operation'], c.context['datastore']])).toEqual(
      expect.arrayContaining([
        ['alice', 'get-config', 'candidate'],
        ['alice', 'edit-config', 'running'],
        ['alice', 'lock', 'running'],
      ]),
    );
    // Allowed until access control is added: every check led to a reply.
    expect(checks.every((c) => typeof c.context['messageId'] === 'string')).toBe(true);
    await alice.close();
    await f.close();
  });
});

export type { NetconfServer };
