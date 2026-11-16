// WRITE-01: edit-config with every operation, default-operation, insert and test-option (RFC 6241 §7.2, §8.6).
import { describe, expect, it } from 'vitest';
import { errorInfo, rpc } from './helpers.js';
import { config, editConfig, errorTags, isOk, rpcErrors, send, WT, writesSession, writesVariant } from './writes-helpers.js';

const NC_ATTR = 'xmlns:nc="urn:ietf:params:xml:ns:netconf:base:1.0"';
const sys = (body: string, attrs = ''): string => `<system xmlns="${WT}" ${NC_ATTR} ${attrs}>${body}</system>`;
const ifs = (body: string): string => `<interfaces xmlns="${WT}" ${NC_ATTR}>${body}</interfaces>`;

describe('WRITE-01 edit-config', () => {
  it('applies merge, replace, create, delete and remove to running and to the candidate', async () => {
    for (const target of ['running', 'candidate']) {
      const { c, device } = await writesSession();
      expect(isOk(await send(c, editConfig(target, sys('<hostname>merged</hostname>'))))).toBe(true);
      expect(isOk(await send(c, editConfig(target, ifs('<interface nc:operation="create"><name>eth1</name><type>ethernet</type></interface>'))))).toBe(true);
      expect(isOk(await send(c, editConfig(target, sys('<dns>9.9.9.9</dns>', 'nc:operation="replace"'))))).toBe(true);
      expect(isOk(await send(c, editConfig(target, ifs('<interface nc:operation="delete"><name>eth0</name></interface>'))))).toBe(true);
      expect(isOk(await send(c, editConfig(target, ifs('<interface nc:operation="remove"><name>nope</name></interface>'))))).toBe(true);
      expect(await config(c, device, target)).toEqual({
        'writes-test:system': { dns: ['9.9.9.9'] },
        'writes-test:interfaces': { interface: [{ name: 'eth1', type: 'ethernet' }] },
      });
    }
  });

  it('honours default-operation merge, replace and none, with none creating only what an operation creates', async () => {
    const { c, device } = await writesSession();
    await send(c, editConfig('running', sys('<hostname>m</hostname>'), '<default-operation>merge</default-operation>'));
    expect(await config(c, device)).toMatchObject({ 'writes-test:system': { hostname: 'm', dns: ['8.8.8.8'] } });

    // none: <system> and <hostname> only lead the way; nothing without an operation is created or changed.
    await send(c, editConfig('running', sys('<hostname>ignored</hostname><min-mtu nc:operation="create">100</min-mtu>'), '<default-operation>none</default-operation>'));
    expect(await config(c, device)).toMatchObject({ 'writes-test:system': { hostname: 'm', 'min-mtu': 100 } });
    await send(c, editConfig('running', `<routing xmlns="${WT}"><route><prefix>10/8</prefix></route></routing>`, '<default-operation>none</default-operation>'));
    expect(await config(c, device)).not.toHaveProperty('writes-test:routing');

    // replace: the whole configuration becomes the edit's.
    await send(c, editConfig('running', sys('<hostname>only</hostname>'), '<default-operation>replace</default-operation>'));
    expect(await config(c, device)).toEqual({ 'writes-test:system': { hostname: 'only' } });
  });

  it('answers create of an existing node with data-exists and delete of a missing one with data-missing', async () => {
    const { c } = await writesSession();
    const exists = await send(c, editConfig('running', ifs('<interface nc:operation="create"><name>eth0</name><type>x</type></interface>')));
    expect(errorTags(exists)).toEqual(['data-exists']);
    const missing = await send(c, editConfig('running', ifs('<interface nc:operation="delete"><name>eth9</name></interface>')));
    expect(errorTags(missing)).toEqual(['data-missing']);
    expect(rpcErrors(missing)[0]!.path).toBe("/writes-test:interfaces/writes-test:interface[writes-test:name='eth9']");
  });

  it('positions ordered-by-user entries with yang:insert first, last, before and after', async () => {
    const { c, device } = await writesSession();
    const route = (prefix: string, insert = ''): string => `<route ${insert}><prefix>${prefix}</prefix></route>`;
    const routing = (body: string): string => `<routing xmlns="${WT}" xmlns:yang="urn:ietf:params:xml:ns:yang:1" xmlns:wt="${WT}">${body}</routing>`;
    await send(c, editConfig('running', routing(route('b') + route('d'))));
    await send(c, editConfig('running', routing(route('a', 'yang:insert="first"'))));
    await send(c, editConfig('running', routing(route('e', 'yang:insert="last"'))));
    await send(c, editConfig('running', routing(route('c', `yang:insert="before" yang:key="[wt:prefix='d']"`))));
    await send(c, editConfig('running', routing(route('bb', `yang:insert="after" yang:key="[wt:prefix='b']"`))));
    const dns = `<system xmlns="${WT}" xmlns:yang="urn:ietf:params:xml:ns:yang:1"><dns yang:insert="first">1.1.1.1</dns></system>`;
    await send(c, editConfig('running', dns));
    const json = (await config(c, device)) as { 'writes-test:routing': { route: { prefix: string }[] }; 'writes-test:system': { dns: string[] } };
    expect(json['writes-test:routing'].route.map((r) => r.prefix)).toEqual(['a', 'b', 'bb', 'c', 'd', 'e']);
    expect(json['writes-test:system'].dns).toEqual(['1.1.1.1', '8.8.8.8']);

    // Prefixes declared outside <config>, on the <rpc> itself, still resolve.
    const outer = `message-id="900" xmlns:yang="urn:ietf:params:xml:ns:yang:1" xmlns:w="${WT}"`;
    const reply = await c.request(rpc(editConfig('running', `<routing xmlns="${WT}"><route yang:insert="first"><prefix>0</prefix></route><route yang:insert="after" yang:key="[w:prefix='e']"><prefix>f</prefix></route></routing>`), outer));
    expect(isOk(reply)).toBe(true);
    const after = (await config(c, device)) as typeof json;
    expect(after['writes-test:routing'].route.map((r) => r.prefix)).toEqual(['0', 'a', 'b', 'bb', 'c', 'd', 'e', 'f']);
  });

  it('honours test-option test-then-set, set and test-only', async () => {
    const { c, device } = await writesSession();
    const before = await config(c, device);
    // test-only: checked, nothing stored, and an invalid result is still reported.
    expect(isOk(await send(c, editConfig('running', sys('<hostname>t</hostname>'), '<test-option>test-only</test-option>')))).toBe(true);
    expect(await config(c, device)).toEqual(before);
    const leafref = sys('<admin-interface>nope</admin-interface>');
    expect(errorTags(await send(c, editConfig('candidate', leafref, '<test-option>test-only</test-option>')))).toEqual(['data-missing']);
    // test-then-set (the default) validates the candidate; set leaves validation to commit.
    expect(errorTags(await send(c, editConfig('candidate', leafref)))).toEqual(['data-missing']);
    expect(isOk(await send(c, editConfig('candidate', leafref, '<test-option>set</test-option>')))).toBe(true);
    expect(await config(c, device, 'candidate')).toMatchObject({ 'writes-test:system': { 'admin-interface': 'nope' } });
    // Running is always validated, whatever the test-option: nothing that breaks the schema enters it.
    expect(errorTags(await send(c, editConfig('running', leafref, '<test-option>set</test-option>')))).toEqual(['data-missing']);
  });

  it('answers ok to a successful edit, which every session sees on its next read', async () => {
    const { c, device, open } = await writesSession();
    const other = await open();
    expect(isOk(await send(c, editConfig('running', sys('<hostname>seen</hostname>'))))).toBe(true);
    expect(await config(other, device)).toMatchObject({ 'writes-test:system': { hostname: 'seen' } });
  });

  it('refuses running without :writable-running, and datastores the device does not have', async () => {
    const device = await writesVariant((d) => ({ ...d, capabilities: { candidate: true } }));
    const { c } = await writesSession({ device });
    const reply = await send(c, editConfig('running', sys('<hostname>x</hostname>')));
    expect(errorTags(reply)).toEqual(['operation-not-supported']);
    expect(errorTags(await send(c, editConfig('startup', sys('<hostname>x</hostname>'))))).toEqual(['invalid-value']);
    const noCandidate = await writesSession({ device: await writesVariant((d) => ({ ...d, capabilities: {} })) });
    const r = await send(noCandidate.c, editConfig('candidate', sys('<hostname>x</hostname>')));
    expect(errorTags(r)).toEqual(['invalid-value']);
    expect(errorInfo(r, 'bad-element')).toBe('candidate');
  });
});
