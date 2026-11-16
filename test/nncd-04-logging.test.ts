// NNCD-04: set the log level and read structured logs.
import { describe, expect, it } from 'vitest';
import { StderrLogger } from '../src/node/nncd.js';
import { baseConfig, clientKey, runNncd, sshClient, startNncd, writeConfig } from './ssh-helpers.js';

const PASSWORD = 'Zq9-unique-pass';

describe('NNCD-04 logging', { timeout: 30_000 }, () => {
  it('accepts trace, debug, info, warn, error and silent, defaulting to info', async () => {
    const lines: string[] = [];
    const logger = new StderrLogger({ write: (t: string) => lines.push(t) });
    expect(logger.level).toBe('info');
    logger.debug?.('hidden');
    logger.info?.('shown');
    expect(lines).toHaveLength(1);
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const) {
      const out: string[] = [];
      const l = new StderrLogger({ write: (t: string) => out.push(t) }, level);
      for (const m of ['trace', 'debug', 'info', 'warn', 'error'] as const) l[m]?.(m);
      expect(out.length, level).toBe(['trace', 'debug', 'info', 'warn', 'error', 'silent'].length - 1 - ['trace', 'debug', 'info', 'warn', 'error', 'silent'].indexOf(level));
    }
    // Disabled levels have no method at all, so callers skip their work.
    expect(new StderrLogger({ write: () => undefined }, 'warn').debug).toBeUndefined();
    const bad = await runNncd(['--config', await writeConfig(baseConfig()), '--log-level', 'chatty']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('trace, debug, info, warn, error, silent');
  });

  it('writes one line per entry to stderr with the level, message and context', async () => {
    const nncd = await startNncd(['--config', await writeConfig(baseConfig()), '--log-level', 'debug']);
    const client = await sshClient(nncd.port);
    await client.ops.getConfig({ source: 'running' });
    await client.close();
    await nncd.stop();
    const lines = nncd.stderr().trimEnd().split('\n');
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z (trace|debug|info |warn |error) ("[^"]*"|\S+)( \w+=("(?:[^"\\]|\\.)*"|\S+))*$/);
    const request = lines.find((l) => l.includes('"Request get-config"'));
    expect(request).toMatch(/ sessionId=\d+ username=netconf messageId=\S+ operation=get-config datastore=running/);
    expect(lines.some((l) => /"Session started" sessionId=\d+ username=netconf transport=ssh/.test(l))).toBe(true);
  });

  it('logs every message received and sent at trace, and never a password or private key', async () => {
    const key = clientKey();
    const nncd = await startNncd([
      '--config',
      await writeConfig(baseConfig({ users: [{ username: 'netconf', password: PASSWORD, lab: true }, { username: 'ops', authorizedKeys: [key.public] }] })),
      '--log-level',
      'trace',
    ]);
    const a = await sshClient(nncd.port, { password: PASSWORD });
    await a.ops.getConfig({ source: 'running' });
    await a.close();
    await sshClient(nncd.port, { password: 'wrong-' + PASSWORD }).catch(() => undefined);
    const b = await sshClient(nncd.port, { username: 'ops', privateKey: key.private });
    await b.close();
    await nncd.stop();
    const log = nncd.stderr();
    expect(log).toMatch(/trace Received sessionId=\d+ username=netconf message=".*<get-config>/);
    expect(log).toMatch(/trace Sent sessionId=\d+ username=netconf message=".*<rpc-reply/);
    expect(log).toMatch(/trace Sent .*<hello/);
    expect(log).not.toContain(PASSWORD);
    const keyBody = key.private.split('\n').filter((l) => !l.startsWith('-----')).join('');
    for (const piece of keyBody.match(/.{20}/g) ?? []) expect(log).not.toContain(piece);
    // The host key's private part never appears either: only its fingerprint.
    expect(log).not.toContain('PRIVATE KEY');
  });

  it('takes the level from the config, and the command line wins', async () => {
    const config = await writeConfig(baseConfig({ logLevel: 'debug' }));
    const fromConfig = await startNncd(['--config', config]);
    await (await sshClient(fromConfig.port)).close();
    await fromConfig.stop();
    expect(fromConfig.stderr()).toMatch(/ debug "Session ended"|debug "The client went away"|debug "Request /);

    const overridden = await startNncd(['--config', config, '--log-level', 'info']);
    await (await sshClient(overridden.port)).close();
    await overridden.stop();
    expect(overridden.stderr()).toContain('nncd started');
    expect(overridden.stderr()).not.toMatch(/ debug /);

    const silent = await runNncd(['--config', await writeConfig(baseConfig({ logLevel: 'silent' })), '--check']);
    expect(silent.stderr).toBe('');
    const loud = await runNncd(['--config', await writeConfig(baseConfig({ logLevel: 'silent' })), '--check', '--log-level', 'warn']);
    expect(loud.stderr).toContain('warn  "A lab user has a plain-text password');
  });
});
