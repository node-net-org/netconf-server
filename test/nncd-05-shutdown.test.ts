// NNCD-05: shut the server down cleanly.
import { join } from 'node:path';
import { connect } from '@node-net/netconf';
import { serializeXml } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { createServer, loadDeviceFile, type CommitEvent } from '../src/index.js';
import { baseConfig, FIXTURES, sshClient, startNncd, WRITES_DEVICE, writeConfig } from './ssh-helpers.js';

const WT = 'urn:example:writes';
const setHostname = (target: string, name: string): string =>
  `<edit-config xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><target><${target}/></target><config><system xmlns="${WT}"><hostname>${name}</hostname></system></config></edit-config>`;
const slowProvider = (ms: number): Record<string, unknown> => ({
  providers: [{ module: join(FIXTURES, 'nncd/system-provider.mjs'), path: '/writes-test:system', options: { prepareDelayMs: ms } }],
});

describe('NNCD-05 shutdown', { timeout: 30_000 }, () => {
  it('on SIGINT or SIGTERM stops accepting, lets a write in progress finish, closes every session and exits 0', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const nncd = await startNncd(['--config', await writeConfig(baseConfig(slowProvider(800)))]);
      const writer = await sshClient(nncd.port);
      const idle = await sshClient(nncd.port);
      const idleClosed = new Promise((r) => idle.session.onClosed(r));
      const write = writer.session.rpc(setHostname('running', 'during-shutdown'));
      await new Promise((r) => setTimeout(r, 150));
      nncd.child.kill(signal);
      await nncd.waitFor(/Shutting down/);
      // Not accepting any more.
      await expect(sshClient(nncd.port)).rejects.toThrow();
      // The write already started finishes and is answered.
      expect((await write).ok).toBe(true);
      await idleClosed;
      const { code } = await nncd.exited;
      expect(code, signal).toBe(0);
      expect(nncd.stderr()).toMatch(/"Session ended" sessionId=\d+ username=netconf reason=closed/);
    }
  });

  it('exits at once with status 130 on a second signal during shutdown', async () => {
    const nncd = await startNncd(['--config', await writeConfig(baseConfig(slowProvider(8_000)))]);
    const writer = await sshClient(nncd.port);
    void writer.session.rpc(setHostname('running', 'slow')).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 150));
    nncd.child.kill('SIGTERM');
    await nncd.waitFor(/Shutting down/);
    nncd.child.kill('SIGTERM');
    const started = Date.now();
    expect((await nncd.exited).code).toBe(130);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(nncd.stderr()).toContain('Second signal: exiting now');
  });

  it('rolls back pending confirmed commits without persist before exit, as if their sessions had ended', async () => {
    const server = await createServer({ device: await loadDeviceFile(WRITES_DEVICE) });
    const commits: CommitEvent[] = [];
    server.on('commit', (e) => commits.push(e));
    const client = await connect({ transport: server.transport() });
    await client.session.rpc(setHostname('candidate', 'trial'));
    await client.session.rpc('<commit xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><confirmed/></commit>');
    expect(serializeXml(await client.ops.getConfig({ source: 'running' }))).toContain('<hostname>trial</hostname>');
    await server.close();
    // Rolled back before close() resolved.
    expect(commits.map((c) => c.cause)).toEqual(['commit', 'rollback']);
    expect(commits[1]!.changes.map((c) => c.path)).toEqual(commits[0]!.changes.map((c) => c.path));

    // With persist, it survives the session: shutdown leaves it be.
    const kept = await createServer({ device: await loadDeviceFile(WRITES_DEVICE) });
    const keptCommits: CommitEvent[] = [];
    kept.on('commit', (e) => keptCommits.push(e));
    const c2 = await connect({ transport: kept.transport() });
    await c2.session.rpc(setHostname('candidate', 'persisted'));
    await c2.session.rpc('<commit xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><confirmed/><persist>p1</persist></commit>');
    await kept.close();
    expect(keptCommits.map((c) => c.cause)).toEqual(['commit']);

    // And through nncd: a confirmed commit then SIGTERM still exits 0.
    const nncd = await startNncd(['--config', await writeConfig(baseConfig())]);
    const remote = await sshClient(nncd.port);
    await remote.session.rpc(setHostname('candidate', 'remote-trial'));
    await remote.session.rpc('<commit xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><confirmed/></commit>');
    expect((await nncd.stop()).code).toBe(0);
  });
});
