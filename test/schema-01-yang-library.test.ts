// SCHEMA-01: discover modules and datastores from the YANG library (RFC 8525).
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileYangLibrary, readYangLibrary, type YangLibrary } from '@node-net/yang/core';
import { contentId, createServer, loadDevice, loadDeviceFile, type Device } from '../src/index.js';
import { rawOpen } from './helpers.js';
import { dataJson, readsDevice, send } from './reads-helpers.js';

const fixture = (p: string): string => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const LIBRARY = '<get><filter><yang-library xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library"/><modules-state xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library"/></filter></get>';

async function library(device: Device): Promise<{ library: YangLibrary; json: Record<string, unknown>; hello: string }> {
  const c = await rawOpen(await createServer({ device, control: { enabled: false } }));
  const json = dataJson(device, await send(c, LIBRARY)) as Record<string, unknown>;
  return { library: readYangLibrary(json), json, hello: c.messages[0]!.toString() };
}

describe('SCHEMA-01 YANG library', () => {
  it('AC1: lists every module, revision, feature, deviation and submodule from the device definition', async () => {
    const example = await loadDeviceFile(fixture('example/device.json'));
    const { library: lib } = await library(example);
    const modules = lib.moduleSets[0]!.modules;
    expect(modules.map((m) => `${m.name}@${m.revision ?? ''}`).sort()).toEqual(example.schema.implemented.map((m) => `${m.name}@${m.revision ?? ''}`).sort());
    const widgets = modules.find((m) => m.name === 'example-widgets')!;
    expect(widgets.features).toEqual(['colours']);
    expect(widgets.deviations).toEqual([{ name: 'example-widgets-deviations', revision: '2026-01-02' }]);
    const schema = await loadDeviceFile(fixture('schema/device.json'));
    const set = (await library(schema)).library.moduleSets[0]!;
    expect(set.modules.find((m) => m.name === 'twice')!.submodules).toEqual([{ name: 'twice-sub', revision: '2026-01-01' }]);
    expect(set.importOnly.find((m) => m.name === 'twice')!.revision).toBe('2025-01-01');
  });

  it('AC2: lists each NMDA datastore with its schema, and the content-id changes with the module set', async () => {
    const { library: lib } = await library(await readsDevice());
    expect(lib.datastores).toEqual(
      ['running', 'candidate', 'startup', 'intended', 'operational'].map((d) => ({ name: `ietf-datastores:${d}`, schema: 'complete' })),
    );
    expect(lib.schemas).toEqual([{ name: 'complete', moduleSets: ['complete'] }]);
    const a = await loadDevice({ id: 'a', yang: { modules: [] } });
    const b = await readsDevice();
    const c = await loadDeviceFile(fixture('example/device.json'));
    expect(new Set([contentId(a.schema), contentId(b.schema), contentId(c.schema)]).size).toBe(3);
    expect((await library(b)).library.contentId).toBe(contentId(b.schema));
  });

  it('AC3: the hello advertises the yang-library capability with the same content-id', async () => {
    const device = await readsDevice();
    const { library: lib, hello } = await library(device);
    expect(hello).toContain(`urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&amp;content-id=${lib.contentId!}`);
  });

  it('AC4: provides the deprecated modules-state (RFC 7895) when the device definition asks for it', async () => {
    const reads = await library(await readsDevice());
    const state = reads.json['ietf-yang-library:modules-state'] as { 'module-set-id': string; module: { name: string; 'conformance-type': string }[] };
    expect(state['module-set-id']).toBe(reads.library.contentId);
    expect(state.module.find((m) => m.name === 'reads-test')!['conformance-type']).toBe('implement');
    expect(state.module.find((m) => m.name === 'ietf-yang-types')!['conformance-type']).toBe('import');
    const plain = await library(await loadDevice({ id: 'p', yang: { modules: [] } }));
    expect(plain.json).not.toHaveProperty('ietf-yang-library:modules-state');
  });

  it('AC5: @node-net/yang compiles the reported module set into the same schema the server uses', async () => {
    for (const device of [await readsDevice(), await loadDeviceFile(fixture('example/device.json'))]) {
      const { library: lib } = await library(device);
      const compiled = await compileYangLibrary(lib, { source: device.source });
      const schema = compiled.datastores.get('ietf-datastores:running')!;
      expect(schema.errors).toEqual([]);
      const describe = (s: typeof schema): string[] =>
        s.allModules.map((m) => `${m.implemented ? 'i' : 'o'} ${m.name}@${m.revision ?? ''} [${[...m.enabledFeatures].sort().join(',')}] [${[...m.deviations].sort().join(',')}]`).sort();
      expect(describe(schema)).toEqual(describe(device.schema));
    }
  });
});
