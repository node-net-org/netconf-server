// STORE-01: keep configuration across restarts with a file store (design §9).
import { chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, fileStore, StoreError } from '../src/index.js';
import { config, editConfig, errorTags, isOk, send, WT, writesDevice, writesSession, writesVariant } from './writes-helpers.js';

const sys = (body: string): string => `<system xmlns="${WT}">${body}</system>`;
const dirs: string[] = [];

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nnc-store-'));
  dirs.push(dir);
  return dir;
}

/** The writes device without :startup, so running is what gets saved. */
const runningSaved = (): ReturnType<typeof writesVariant> => writesVariant((d) => ({ ...d, capabilities: { ...d.capabilities, startup: false } }));

afterEach(async () => {
  for (const d of dirs.splice(0)) await chmod(d, 0o700).catch(() => undefined);
});

describe('STORE-01 file store', () => {
  it('writes each saved datastore as an RFC 7951 JSON file in the state directory', async () => {
    const dir = await stateDir();
    const { c } = await writesSession({ device: await runningSaved(), store: fileStore(dir) });
    await send(c, editConfig('running', sys('<hostname>on-disk</hostname>')));
    expect(await readdir(dir)).toEqual(['running.json']);
    const json = JSON.parse(await readFile(join(dir, 'running.json'), 'utf8')) as Record<string, unknown>;
    expect(json['writes-test:system']).toMatchObject({ hostname: 'on-disk' });
  });

  it('saves startup when it changes and boots from it with :startup; without it, saves running after every change', async () => {
    const dir = await stateDir();
    const device = await writesDevice();
    const first = await writesSession({ device, store: fileStore(dir) });
    await send(first.c, editConfig('running', sys('<hostname>not-saved</hostname>')));
    expect(await readdir(dir)).toEqual([]);
    await send(first.c, '<copy-config><target><startup/></target><source><running/></source></copy-config>');
    await send(first.c, editConfig('running', sys('<hostname>lost-on-restart</hostname>')));
    await first.srv.close();
    const second = await writesSession({ device, store: fileStore(dir) });
    expect(await config(second.c, device)).toMatchObject({ 'writes-test:system': { hostname: 'not-saved' } });

    const dir2 = await stateDir();
    const plain = await runningSaved();
    const a = await writesSession({ device: plain, store: fileStore(dir2) });
    await send(a.c, editConfig('running', sys('<hostname>kept</hostname>')));
    await a.srv.close();
    const b = await writesSession({ device: plain, store: fileStore(dir2) });
    expect(await config(b.c, plain)).toMatchObject({ 'writes-test:system': { hostname: 'kept' } });
  });

  it('never saves the candidate; after a restart it equals running', async () => {
    const dir = await stateDir();
    const device = await runningSaved();
    const a = await writesSession({ device, store: fileStore(dir) });
    await send(a.c, editConfig('candidate', sys('<hostname>uncommitted</hostname>')));
    expect(await readdir(dir)).toEqual([]);
    await a.srv.close();
    const b = await writesSession({ device, store: fileStore(dir) });
    expect(await config(b.c, device, 'candidate')).toEqual(await config(b.c, device));
  });

  it('writes each file atomically, so a failed save leaves the previous file and the datastore intact', async () => {
    const dir = await stateDir();
    const device = await runningSaved();
    const { c } = await writesSession({ device, store: fileStore(dir) });
    expect(isOk(await send(c, editConfig('running', sys('<hostname>first</hostname>'))))).toBe(true);
    const saved = await readFile(join(dir, 'running.json'), 'utf8');
    await chmod(dir, 0o500);
    expect(errorTags(await send(c, editConfig('running', sys('<hostname>second</hostname>'))))).toEqual(['operation-failed']);
    await chmod(dir, 0o700);
    expect(await readFile(join(dir, 'running.json'), 'utf8')).toBe(saved);
    expect(await readdir(dir)).toEqual(['running.json']);
    expect(await config(c, device)).toMatchObject({ 'writes-test:system': { hostname: 'first' } });
  });

  it('stops the server at start-up when the state directory cannot be created or written, naming it', async () => {
    const parent = await stateDir();
    await writeFile(join(parent, 'a-file'), 'x');
    const bad = join(parent, 'a-file', 'state');
    const failure = createServer({ device: await writesDevice(), store: fileStore(bad) });
    await expect(failure).rejects.toThrow(StoreError);
    await expect(failure).rejects.toThrow(bad);
  });
});
