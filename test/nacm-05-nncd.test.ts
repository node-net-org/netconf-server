// NACM-05: name recovery users in nncd's deployment config.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareServer, readServerConfig } from '../src/index.js';
import { validateConfig } from '../src/node/config-validate.js';
import { baseConfig, PKG_DIR, recordingLogger, runNncd, writeConfig } from './ssh-helpers.js';

/** A bundled device that implements ietf-netconf-acm. */
const NETOPEER2 = join(PKG_DIR, 'devices/sysrepo-netopeer2/device.json');

describe('NACM-05 nncd recovery users', { timeout: 30_000 }, () => {
  it('makes sessions of the named users recovery sessions, whatever authenticated them', async () => {
    const loaded = await readServerConfig(await writeConfig(baseConfig({ device: NETOPEER2, nacm: { recoveryUsers: ['root', 'ops'] } })));
    const prepared = await prepareServer(loaded);
    const recovery = prepared.options.nacm!.recovery!;
    expect([recovery({ username: 'root' }), recovery({ username: 'ops', groups: ['x'] }), recovery({ username: 'netconf' })]).toEqual([true, true, false]);
    const none = await prepareServer(await readServerConfig(await writeConfig(baseConfig({ device: NETOPEER2 }))));
    expect(none.options.nacm).toBeUndefined();
  });

  it('rejects recovery users that are not a list of non-empty strings, naming the config path', () => {
    expect(validateConfig({ device: 'd.json', nacm: { recoveryUsers: ['root', ''] } })).toEqual([{ path: '/nacm/recoveryUsers/1', message: 'must not be empty' }]);
    expect(validateConfig({ device: 'd.json', nacm: { recoveryUsers: 'root' } })).toEqual([{ path: '/nacm/recoveryUsers', message: 'must be a list of strings' }]);
  });

  it('--check warns, without failing, when the device implements ietf-netconf-acm and no recovery user is named', async () => {
    const { logger, entries } = recordingLogger();
    await prepareServer(await readServerConfig(await writeConfig(baseConfig({ device: NETOPEER2 }))), { logger, check: true });
    expect(entries.filter((e) => e.level === 'warn' && e.message.includes('nacm.recoveryUsers names no one'))).toHaveLength(1);

    const warned = await runNncd(['--config', await writeConfig(baseConfig({ device: NETOPEER2 })), '--check']);
    expect(warned.code).toBe(0);
    expect(warned.stderr).toContain('nacm.recoveryUsers names no one');

    const named = await runNncd(['--config', await writeConfig(baseConfig({ device: NETOPEER2, nacm: { recoveryUsers: ['root'] } })), '--check']);
    expect(named.code).toBe(0);
    expect(named.stderr).not.toContain('recoveryUsers');
    // The writes device has no ietf-netconf-acm: nothing to warn about.
    const plain = await runNncd(['--config', await writeConfig(baseConfig()), '--check']);
    expect(plain.stderr).not.toContain('recoveryUsers');
  });
});
