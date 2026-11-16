// DEVICE-01: define a device as a data file.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { DeviceError, loadDevice, loadDeviceFile, validateDefinition } from '../src/index.js';

const fixture = (p: string): string => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const schemaFile = fileURLToPath(new URL('../schemas/device.schema.json', import.meta.url));

async function schemaValidator(): Promise<(v: unknown) => boolean> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(JSON.parse(await readFile(schemaFile, 'utf8')) as object) as (v: unknown) => boolean;
}

const VALID: unknown[] = [
  { id: 'a', yang: { modules: [] } },
  {
    $schema: 'x',
    id: 'b.2_c-d',
    description: 'd',
    emulates: 'nokia-7210-sas',
    yang: { modules: ['m', { name: 'n', revision: '2020-01-01' }], features: { m: [], n: ['f'] }, deviations: ['d'], importOnly: [{ name: 'i' }], directories: ['y'] },
    capabilities: {
      writableRunning: true,
      candidate: true,
      confirmedCommit: true,
      rollbackOnError: false,
      validate: false,
      startup: true,
      xpath: false,
      withDefaults: { basicMode: 'trim', alsoSupported: ['report-all'] },
      notification: true,
      interleave: true,
      extra: ['urn:x'],
      moduleCapabilities: ['urn:m?module=m'],
    },
    data: { running: 'r.xml', startup: 's.JSON', operational: 'o.json' },
    yangLibrary: { modulesState: true },
    quirks: {},
  },
  { id: 'c', yang: { modules: [] }, capabilities: { withDefaults: false } },
];

const INVALID: [string, unknown, string][] = [
  ['not an object', [], '$'],
  ['a yangLibrary that is not an object', { id: 'a', yang: { modules: [] }, yangLibrary: true }, '$.yangLibrary'],
  ['a non-boolean modulesState', { id: 'a', yang: { modules: [] }, yangLibrary: { modulesState: 'yes' } }, '$.yangLibrary.modulesState'],
  ['an unknown yangLibrary setting', { id: 'a', yang: { modules: [] }, yangLibrary: { schemaMount: true } }, '$.yangLibrary.schemaMount'],
  ['no id', { yang: { modules: [] } }, '$.id'],
  ['a bad id', { id: '-x', yang: { modules: [] } }, '$.id'],
  ['no yang', { id: 'a' }, '$.yang'],
  ['no modules', { id: 'a', yang: {} }, '$.yang.modules'],
  ['a bad module name', { id: 'a', yang: { modules: ['9bad'] } }, '$.yang.modules[0]'],
  ['a bad revision', { id: 'a', yang: { modules: [{ name: 'm', revision: 'May' }] } }, '$.yang.modules[0].revision'],
  ['an unknown top-level key', { id: 'a', yang: { modules: [] }, colour: 'red' }, '$.colour'],
  ['an unknown capability', { id: 'a', yang: { modules: [] }, capabilities: { telepathy: true } }, '$.capabilities.telepathy'],
  ['a non-boolean capability', { id: 'a', yang: { modules: [] }, capabilities: { candidate: 'yes' } }, '$.capabilities.candidate'],
  ['confirmed commit without candidate', { id: 'a', yang: { modules: [] }, capabilities: { confirmedCommit: true } }, '$.capabilities.confirmedCommit'],
  ['interleave without notification', { id: 'a', yang: { modules: [] }, capabilities: { interleave: true } }, '$.capabilities.interleave'],
  ['a bad with-defaults mode', { id: 'a', yang: { modules: [] }, capabilities: { withDefaults: { basicMode: 'all' } } }, '$.capabilities.withDefaults.basicMode'],
  ['a data file that is not XML or JSON', { id: 'a', yang: { modules: [] }, data: { running: 'r.txt' } }, '$.data.running'],
  ['an unknown quirk', { id: 'a', yang: { modules: [] }, quirks: { 'no-message-id': true } }, '$.quirks["no-message-id"]'],
  ['features that are not lists', { id: 'a', yang: { modules: [], features: { m: 'f' } } }, '$.yang.features.m'],
];

describe('DEVICE-01 device definitions', () => {
  it.each(VALID.map((v, i) => [i, v]))('accepts valid definition %i, and so does the JSON Schema', async (_i, def) => {
    expect(validateDefinition(def)).toEqual([]);
    expect((await schemaValidator())(def)).toBe(true);
  });

  it.each(INVALID)('rejects %s at its JSON path, and so does the JSON Schema', async (_what, def, path) => {
    expect(validateDefinition(def).map((i) => i.path)).toContain(path);
    expect((await schemaValidator())(def)).toBe(false);
  });

  it('reports every problem, not just the first', () => {
    const issues = validateDefinition({ id: 3, yang: { modules: ['ok', 7] }, capabilities: { candidate: 1 }, extra: true });
    expect(issues.map((i) => i.path).sort()).toEqual(['$.capabilities.candidate', '$.extra', '$.id', '$.yang.modules[1]']);
  });

  it('rejects an invalid definition at load with a DeviceError listing the issues', async () => {
    const err = await loadDevice({ id: 'a', yang: { modules: 'x' }, quirks: { nope: 1 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceError);
    expect((err as DeviceError).issues.map((i) => i.path)).toEqual(['$.yang.modules', '$.quirks.nope']);
    expect((err as DeviceError).message).toContain('$.quirks.nope: is not a known quirk');
  });

  it('loads from a file, resolving module directories and data files relative to it', async () => {
    const device = await loadDeviceFile(fixture('example/device.json'));
    expect(device.id).toBe('example');
    expect(device.emulates).toBe('sysrepo-netopeer2');
    expect(device.schema.module('example-widgets')?.implemented).toBe(true);
    expect(device.data).toEqual({ running: fixture('example/data/running.xml'), operational: fixture('example/data/state.json') });
  });

  it('the example fixture validates against the shipped schema', async () => {
    const def: unknown = JSON.parse(await readFile(fixture('example/device.json'), 'utf8'));
    expect((await schemaValidator())(def)).toBe(true);
  });

  it('loads from an object in memory, with modules from a source', async () => {
    const { memorySource } = await import('@node-net/yang/core');
    const text = await readFile(fixture('example/yang/example-widgets@2026-01-01.yang'), 'utf8');
    const device = await loadDevice({ id: 'mem', yang: { modules: ['example-widgets'] } }, { source: memorySource([text]) });
    expect(device.schema.module('example-widgets')?.implemented).toBe(true);
  });

  it('refuses module directories in an object definition without a directory source', async () => {
    const err = await loadDevice({ id: 'mem', yang: { modules: [], directories: ['y'] } }).catch((e: unknown) => e);
    expect((err as DeviceError).issues[0]!.path).toBe('$.yang.directories');
  });

  it('reports a missing or unparseable file as a DeviceError', async () => {
    await expect(loadDeviceFile(fixture('nope.json'))).rejects.toBeInstanceOf(DeviceError);
    await expect(loadDeviceFile(fixture('not-json.json'))).rejects.toThrow('not valid JSON');
  });
});
