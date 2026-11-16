// DEVICE-04: start a device with initial configuration and state.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { encodeJson } from '@node-net/yang/core';
import { DeviceError, loadDevice, type DeviceDefinition } from '../src/core.js';
import { dataJson, readsDevice, readsSession, send } from './reads-helpers.js';

const MODULE = new URL('./fixtures/reads/yang/reads-test@2026-11-13.yang', import.meta.url);
const memorySource = { load: async (name: string) => (name === 'reads-test' ? { text: await readFile(MODULE, 'utf8') } : undefined) };

/** A reads-test device whose data files are given in memory. */
function device(files: Record<string, string>, data: DeviceDefinition['data'], extra: Partial<DeviceDefinition> = {}): ReturnType<typeof loadDevice> {
  return loadDevice(
    { id: 'mem', yang: { modules: ['reads-test'] }, data, ...extra },
    {
      source: memorySource,
      readData: (path) => (path in files ? Promise.resolve(files[path]!) : Promise.reject(new Error(`no file ${path}`))),
    },
  );
}

describe('DEVICE-04 initial data', () => {
  it('AC1: names data files for running, startup and operational, each in XML or RFC 7951 JSON', async () => {
    // The fixture: running in XML, startup and operational in JSON.
    const d = await readsDevice();
    expect(encodeJson(d.initial.running)).toMatchObject({ 'reads-test:system': { hostname: 'r1' } });
    expect(encodeJson(d.initial.startup!)).toEqual({ 'reads-test:system': { hostname: 'r1-startup' } });
    expect(encodeJson(d.initial.operational)).toMatchObject({ 'reads-test:system': { 'uptime-info': { uptime: 1234 } } });
    // And the other way round, from memory.
    const m = await device(
      {
        'r.json': JSON.stringify({ 'reads-test:system': { hostname: 'json' } }),
        's.xml': '<system xmlns="urn:example:reads"><hostname>xml</hostname></system>',
        'o.xml': '<system xmlns="urn:example:reads"><uptime-info><uptime>7</uptime></uptime-info></system>',
      },
      { running: 'r.json', startup: 's.xml', operational: 'o.xml' },
      { capabilities: { startup: true } },
    );
    expect(encodeJson(m.initial.running)).toEqual({ 'reads-test:system': { hostname: 'json' } });
    expect(encodeJson(m.initial.startup!)).toEqual({ 'reads-test:system': { hostname: 'xml' } });
    expect(encodeJson(m.initial.operational)).toEqual({ 'reads-test:system': { 'uptime-info': { uptime: 7 } } });
  });

  it('AC2: validates initial data at load; invalid data stops loading with every violation and where it is', async () => {
    const bad = '<system xmlns="urn:example:reads">\n  <mtu>big</mtu>\n  <colour>red</colour>\n</system>';
    const err = await device({ 'r.xml': bad, 'o.json': '{"reads-test:system":{"hostname":"state?"}}' }, { running: 'r.xml', operational: 'o.json' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeviceError);
    const issues = (err as DeviceError).issues;
    expect(issues.every((i) => i.path === '$.data.running' || i.path === '$.data.operational')).toBe(true);
    const running = issues.filter((i) => i.path === '$.data.running').map((i) => i.message);
    expect(running).toEqual([expect.stringMatching(/^r\.xml:2:3 .*mtu.*big/), expect.stringMatching(/^r\.xml:3:3 .*colour/)]);
    // State in a configuration... no: configuration in the operational file is allowed; a wrong type is not.
    expect(issues.some((i) => i.path === '$.data.operational')).toBe(false);
    const wrongState = await device({ 'o.json': '{"reads-test:system":{"uptime-info":{"uptime":"x"}}}' }, { operational: 'o.json' }).catch((e: unknown) => e);
    expect((wrongState as DeviceError).issues).toEqual([{ path: '$.data.operational', message: expect.stringMatching(/^o\.json:1:\d+ .*uptime/) as unknown }]);
    // A file that can't be read, and data without a reader.
    await expect(device({}, { running: 'missing.xml' })).rejects.toThrow(/can't read missing\.xml/);
    await expect(loadDevice({ id: 'x', yang: { modules: [] }, data: { running: 'r.xml' } })).rejects.toThrow(/readData/);
  });

  it('AC3: state data from the files is what reads return (no providers yet)', async () => {
    const { c, device: d } = await readsSession();
    const reply = await send(c, '<get><filter><interfaces xmlns="urn:example:reads"><interface><name>eth0</name><stats/></interface></interfaces></filter></get>');
    expect(dataJson(d, reply)).toEqual({ 'reads-test:interfaces': { interface: [{ name: 'eth0', stats: { 'in-octets': '100', 'out-octets': '200' } }] } });
  });

  it('AC4: data files of about 100k nodes load in a few seconds', async () => {
    // 25,000 interfaces of four nodes each (the entry and three leaves), and as much state.
    const config = { 'reads-test:interfaces': { interface: Array.from({ length: 25_000 }, (_, i) => ({ name: `if${i}`, enabled: i % 2 === 0, description: `port ${i}` })) } };
    const state = { 'reads-test:interfaces': { interface: Array.from({ length: 25_000 }, (_, i) => ({ name: `if${i}`, stats: { 'in-octets': String(i) } })) } };
    const start = performance.now();
    const d = await device({ 'r.json': JSON.stringify(config), 'o.json': JSON.stringify(state) }, { running: 'r.json', operational: 'o.json' });
    const elapsed = performance.now() - start;
    expect([...d.initial.running.walk()]).toHaveLength(100_001);
    expect(elapsed).toBeLessThan(5000);
  });
});
