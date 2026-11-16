// DEVICE-02: give a device its YANG modules, features and deviations.
// DEVICE-03: advertise exactly a real device's capabilities.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connect } from '@node-net/netconf';
import { DeviceError, loadDevice, loadDeviceFile, createServer } from '../src/index.js';
import { errorTag, rawOpen, rpc } from './helpers.js';

const fixture = (p: string): string => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const CAP = 'urn:ietf:params:netconf:capability:';

describe('DEVICE-02 YANG modules, features and deviations', () => {
  it('takes modules from the definition directories and @node-net/yang bundled modules together', async () => {
    const device = await loadDeviceFile(fixture('example/device.json'));
    expect(device.schema.module('example-widgets')?.revision).toBe('2026-01-01');
    // ietf-yang-types comes from @node-net/yang's bundled modules, imported by the base modules.
    expect(device.schema.module('ietf-yang-types')).toBeDefined();
  });

  it('enables the listed features, applies deviations, and finds imports automatically', async () => {
    const device = await loadDeviceFile(fixture('example/device.json'));
    const widgets = device.schema.module('example-widgets')!;
    expect([...widgets.enabledFeatures]).toEqual(['colours']);
    expect(widgets.deviations).toEqual(['example-widgets-deviations']);
    // `weight` is deviated out, `size` is behind a disabled feature, and `colour` is enabled by its feature.
    expect(device.schema.find('/example-widgets:widgets/widget/weight')).toBeUndefined();
    expect(device.schema.find('/example-widgets:widgets/widget/size')).toBeUndefined();
    expect(device.schema.find('/example-widgets:widgets/widget/colour')).toBeDefined();
    const uri = device.capabilities.find((c) => c.includes('module=example-widgets&'));
    expect(uri).toBe('urn:example:widgets?module=example-widgets&revision=2026-01-01&features=colours&deviations=example-widgets-deviations');
    expect(device.capabilities).toContain('urn:example:widgets-deviations?module=example-widgets-deviations&revision=2026-01-02');
  });

  it('stops loading when modules fail to compile, with @node-net/yang diagnostics and file locations', async () => {
    const err = await loadDeviceFile(fixture('broken/device.json')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceError);
    const issue = (err as DeviceError).issues.find((i) => i.message.includes('no-such-type'));
    expect(issue?.path).toMatch(/broken@2026-01-01\.yang:5:\d+$/);
    const missing = await loadDevice({ id: 'm', yang: { modules: ['no-such-module'] } }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(DeviceError);
    expect((missing as DeviceError).message).toContain('no-such-module');
  });

  it('adds the NETCONF base modules the server needs when they are not listed', async () => {
    const plain = await loadDevice({ id: 'p', yang: { modules: [] } });
    const implemented = plain.schema.implemented.map((m) => m.name).sort();
    expect(implemented).toEqual(
      [
        'ietf-datastores',
        'ietf-netconf',
        'ietf-netconf-monitoring',
        'ietf-netconf-nmda',
        'ietf-netconf-with-defaults',
        'ietf-origin',
        'ietf-yang-library',
        'net-netconf-server-monitoring',
      ].sort(),
    );
    const notifying = await loadDevice({ id: 'n', yang: { modules: [] }, capabilities: { notification: true, withDefaults: false } });
    const names = notifying.schema.implemented.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['notifications', 'nc-notifications', 'ietf-netconf-notifications']));
    expect(names).not.toContain('ietf-netconf-with-defaults');
  });
});

describe('DEVICE-03 capabilities', () => {
  it('advertises the optional protocol capabilities the definition chooses', async () => {
    const device = await loadDeviceFile(fixture('example/device.json'));
    const caps = device.capabilities;
    for (const c of ['candidate:1.0', 'confirmed-commit:1.1', 'startup:1.0', 'notification:1.0', 'interleave:1.0', 'rollback-on-error:1.0', 'validate:1.1', 'xpath:1.0']) {
      expect(caps).toContain(CAP + c);
    }
    expect(caps).not.toContain(`${CAP}writable-running:1.0`);
    expect(caps).toContain(`${CAP}with-defaults:1.0?basic-mode=explicit&also-supported=report-all,report-all-tagged,trim`);

    const lean = await loadDevice({
      id: 'lean',
      yang: { modules: [] },
      capabilities: { rollbackOnError: false, validate: false, xpath: false, withDefaults: { basicMode: 'trim' } },
    });
    expect(lean.capabilities.filter((c) => c.startsWith(CAP))).toEqual([
      `${CAP}writable-running:1.0`,
      `${CAP}with-defaults:1.0?basic-mode=trim`,
      expect.stringMatching(new RegExp(`^${CAP}yang-library:1\\.1\\?revision=2019-01-04&content-id=`)),
    ]);
  });

  it('answers operations behind a capability the device lacks with operation-not-supported', async () => {
    const srv = await createServer({ device: { id: 'nocand', yang: { modules: [] } } });
    const c = await rawOpen(srv);
    for (const [i, op] of ['<commit/>', '<discard-changes/>', '<cancel-commit/>', '<create-subscription xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"/>'].entries()) {
      expect(errorTag(await c.request(rpc(op, `message-id="${i}"`)))).toBe('operation-not-supported');
    }
  });

  it('adds extra capability URIs, and can replace module capabilities with the real device text', async () => {
    const real = 'urn:ietf:params:xml:ns:netconf:base:1.0?module=ietf-netconf&revision=2011-06-01&features=candidate';
    const device = await loadDevice({ id: 'x', yang: { modules: [] }, capabilities: { extra: ['urn:vendor:cap:1.0'], moduleCapabilities: [real] } });
    expect(device.capabilities.at(-1)).toBe('urn:vendor:cap:1.0');
    expect(device.capabilities.filter((c) => c.includes('module='))).toEqual([real]);
    const srv = await createServer({ device });
    const client = await connect({ transport: srv.transport() });
    expect(client.session.serverCapabilities.has('urn:vendor:cap:1.0')).toBe(true);
    await client.close();
  });

  it('has writable-running without a candidate and not with one, unless the definition says otherwise', async () => {
    const has = async (caps: object): Promise<boolean> => (await loadDevice({ id: 'w', yang: { modules: [] }, capabilities: caps })).capabilities.includes(`${CAP}writable-running:1.0`);
    expect(await has({})).toBe(true);
    expect(await has({ candidate: true })).toBe(false);
    expect(await has({ candidate: true, writableRunning: true })).toBe(true);
    expect(await has({ writableRunning: false })).toBe(false);
  });

  it('gives a stable content-id that changes with the module set', async () => {
    const a = await loadDevice({ id: 'a', yang: { modules: [] } });
    const a2 = await loadDevice({ id: 'a2', yang: { modules: [] } });
    const b = await loadDevice({ id: 'b', yang: { modules: [] }, capabilities: { candidate: true } });
    const id = (d: typeof a): string | undefined => d.capabilities.find((c) => c.includes('yang-library'))?.split('content-id=')[1];
    expect(id(a)).toBe(id(a2));
    expect(id(a)).not.toBe(id(b));
  });
});
