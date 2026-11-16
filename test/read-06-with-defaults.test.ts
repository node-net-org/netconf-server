// READ-06: choose how default values are reported (RFC 6243).
import { describe, expect, it } from 'vitest';
import { NETCONF_NS } from '@node-net/netconf/core';
import { errorTag } from './helpers.js';
import { dataJson, readsSession, send, WD } from './reads-helpers.js';

const getConfig = (mode?: string): string =>
  `<get-config><source><running/></source><filter><system xmlns="urn:example:reads"/></filter>${mode === undefined ? '' : `<with-defaults xmlns="${WD}">${mode}</with-defaults>`}</get-config>`;

describe('READ-06 with-defaults', () => {
  it('AC1: advertises :with-defaults with the basic mode and the supported modes from the definition', async () => {
    const { c } = await readsSession((def) => ({ ...def, capabilities: { ...def.capabilities, withDefaults: { basicMode: 'trim', alsoSupported: ['report-all'] } } }));
    const hello = c.messages[0]!.toString();
    expect(hello).toContain('urn:ietf:params:netconf:capability:with-defaults:1.0?basic-mode=trim&amp;also-supported=report-all');
  });

  it('AC2: report-all, trim, explicit and report-all-tagged return the nodes RFC 6243 §3 defines', async () => {
    const { c, device } = await readsSession();
    const read = async (mode?: string): Promise<unknown> => dataJson(device, await send(c, getConfig(mode)), NETCONF_NS, 'running');
    const base = { hostname: 'r1', dns: ['8.8.8.8', '1.1.1.1'] };
    // explicit (the basic mode here): what was set, including mtu set to its default.
    expect(await read()).toEqual({ 'reads-test:system': { ...base, mtu: 1500 } });
    expect(await read('explicit')).toEqual({ 'reads-test:system': { ...base, mtu: 1500 } });
    expect(await read('trim')).toEqual({ 'reads-test:system': base });
    expect(await read('report-all')).toEqual({ 'reads-test:system': { ...base, mtu: 1500, clock: { timezone: 'UTC' } } });
    expect(await read('report-all-tagged')).toMatchObject({ 'reads-test:system': { ...base, mtu: 1500, clock: { timezone: 'UTC' } } });
    // The snapshot is untouched by those reads.
    expect(await read()).toEqual({ 'reads-test:system': { ...base, mtu: 1500 } });
    // A basic mode other than explicit applies without the parameter.
    const trimmed = await readsSession((def) => ({ ...def, capabilities: { ...def.capabilities, withDefaults: { basicMode: 'trim' } } }));
    expect(dataJson(trimmed.device, await send(trimmed.c, getConfig()), NETCONF_NS, 'running')).toEqual({ 'reads-test:system': base });
  });

  it('AC3: report-all-tagged marks default nodes with the wd:default attribute', async () => {
    const { c } = await readsSession();
    const text = (await send(c, getConfig('report-all-tagged'))).toString();
    expect(text).toMatch(/<mtu [^>]*:default="true"[^>]*>1500<\/mtu>/);
    expect(text).toMatch(/<timezone [^>]*:default="true"[^>]*>UTC<\/timezone>/);
    expect(text).toContain('urn:ietf:params:xml:ns:netconf:default:1.0');
    expect(text).not.toMatch(/<hostname [^>]*default/);
  });

  it('AC4: a mode the device does not support gets invalid-value', async () => {
    const { c } = await readsSession((def) => ({ ...def, capabilities: { ...def.capabilities, withDefaults: { basicMode: 'explicit' } } }));
    expect(errorTag(await send(c, getConfig('report-all')))).toBe('invalid-value');
    expect(errorTag(await send(c, getConfig('everything')))).toBe('invalid-value');
    expect(errorTag(await send(c, getConfig('explicit')))).toBeUndefined();
  });
});
