// SCHEMA-02: download module source with get-schema (RFC 6022 §3.1).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseModule, parseYin, writeYin } from '@node-net/yang/core';
import { createServer, loadDevice, loadDeviceFile } from '../src/index.js';
import { errorTag, NC, rawOpen } from './helpers.js';
import { NCM, readsSession, send, type Client } from './reads-helpers.js';

const fixture = (p: string): string => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const getSchema = (id: string, extra = ''): string => `<get-schema xmlns="${NCM}"><identifier>${id}</identifier>${extra}</get-schema>`;

async function schemaSession(): Promise<Client> {
  return rawOpen(await createServer({ device: await loadDeviceFile(fixture('schema/device.json')) }));
}

describe('SCHEMA-02 get-schema', () => {
  it('AC1: with an identifier and version, returns that module or submodule exactly as the source has it', async () => {
    const { c } = await readsSession();
    const reply = await send(c, getSchema('reads-test', '<version>2026-11-13</version><format>yang</format>'));
    expect(reply.child('data', NCM)!.text()).toBe(await readFile(fixture('reads/yang/reads-test@2026-11-13.yang'), 'utf8'));
    const s = await schemaSession();
    const sub = await send(s, getSchema('twice-sub', '<version>2026-01-01</version>'));
    expect(sub.child('data', NCM)!.text()).toBe(await readFile(fixture('schema/yang/twice-sub@2026-01-01.yang'), 'utf8'));
    const old = await send(s, getSchema('twice', '<version>2025-01-01</version>'));
    expect(old.child('data', NCM)!.text()).toBe(await readFile(fixture('schema/yang/twice@2025-01-01.yang'), 'utf8'));
  });

  it('AC2: without a version, returns the revision the server implements', async () => {
    const { c } = await readsSession();
    const reply = await send(c, getSchema('ietf-netconf-monitoring'));
    expect(reply.child('data', NCM)!.text()).toContain('revision 2010-10-04');
  });

  it('AC3: invalid-value for an identifier or version the server lacks; operation-failed with data-not-unique when several match', async () => {
    const { c } = await readsSession();
    expect(errorTag(await send(c, getSchema('no-such-module')))).toBe('invalid-value');
    expect(errorTag(await send(c, getSchema('reads-test', '<version>1999-01-01</version>')))).toBe('invalid-value');
    const s = await schemaSession();
    const reply = await send(s, getSchema('twice'));
    expect(errorTag(reply)).toBe('operation-failed');
    expect(reply.child('rpc-error', NC)!.child('error-app-tag', NC)!.text()).toBe('data-not-unique');
  });

  it('AC4: returns YIN when asked, and invalid-value for other formats', async () => {
    const { c } = await readsSession();
    const reply = await send(c, getSchema('reads-test', '<format xmlns:ncm="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring">ncm:yin</format>'));
    const module = reply.child('data', NCM)!.elements[0]!;
    expect(module.name).toBe('module');
    expect(module.ns).toBe('urn:ietf:params:xml:ns:yang:yin:1');
    const parsed = parseYin(module.toString());
    expect(parsed.statement.argument).toBe('reads-test');
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(errorTag(await send(c, getSchema('reads-test', '<format>xsd</format>')))).toBe('invalid-value');
    expect(errorTag(await send(c, getSchema('reads-test', '<format xmlns:x="urn:example:other">x:yin</format>')))).toBe('invalid-value');
  });

  it('returns YANG for a module whose source is YIN, and that YIN as it is', async () => {
    const yang = await readFile(fixture('reads/yang/reads-test@2026-11-13.yang'), 'utf8');
    const yin = writeYin(parseModule(yang).statement, { namespaces: { rt: 'urn:example:reads' } });
    const device = await loadDevice(
      { id: 'yin', yang: { modules: ['reads-test'] } },
      { source: { load: (name) => Promise.resolve(name === 'reads-test' ? { text: yin, format: 'yin' as const } : undefined) } },
    );
    const c = await rawOpen(await createServer({ device }));
    const reply = await send(c, getSchema('reads-test'));
    expect(errorTag(reply)).toBeUndefined();
    const text = reply.child('data', NCM)!.text();
    expect(text).toMatch(/^module reads-test \{\n/);
    const read = (s: { keyword: string; argument?: string; substatements: readonly unknown[] }): unknown => [s.keyword, s.argument, s.substatements.map((c) => read(c as never))];
    expect(read(parseModule(text).statement)).toEqual(read(parseModule(yang).statement));
    const asYin = await send(c, getSchema('reads-test', '<format xmlns:ncm="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring">ncm:yin</format>'));
    expect(asYin.child('data', NCM)!.elements[0]!.name).toBe('module');
  });
});
