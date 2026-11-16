// READ-03: read any NMDA datastore with get-data. Origins that providers mark (learned, system) arrive in M3; here they come from the operational file.
import { describe, expect, it } from 'vitest';
import { PT, providersSession } from './providers-helpers.js';
import { readYangLibrary } from '@node-net/yang/core';
import { errorTag } from './helpers.js';
import { dataJson, NMDA, readsSession, send } from './reads-helpers.js';

const DS = 'xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores"';
const getData = (ds: string, body = ''): string => `<get-data xmlns="${NMDA}" ${DS}><datastore>ds:${ds}</datastore>${body}</get-data>`;
const SYSTEM = '<subtree-filter><system xmlns="urn:example:reads"/></subtree-filter>';

describe('READ-03 get-data', () => {
  it('AC1: accepts the datastores the device advertises, and invalid-value for any other', async () => {
    const { c, device } = await readsSession();
    for (const ds of ['running', 'candidate', 'startup', 'intended', 'operational']) {
      const reply = await send(c, getData(ds, SYSTEM));
      expect(errorTag(reply)).toBeUndefined();
      expect(dataJson(device, reply, NMDA)).toHaveProperty(['reads-test:system', 'hostname']);
    }
    expect(errorTag(await send(c, getData('nope')))).toBe('invalid-value');
    expect(errorTag(await send(c, `<get-data xmlns="${NMDA}" xmlns:x="urn:example:reads"><datastore>x:running</datastore></get-data>`))).toBe('invalid-value');
    const plain = await readsSession((def) => ({ ...def, capabilities: {}, data: { running: def.data!.running! } }));
    expect(errorTag(await send(plain.c, getData('candidate')))).toBe('invalid-value');
    expect(errorTag(await send(plain.c, getData('startup')))).toBe('invalid-value');
  });

  it('AC2: get-data of operational returns the configuration in use together with state', async () => {
    const { c, device } = await readsSession();
    const data = dataJson(device, await send(c, getData('operational', SYSTEM)), NMDA);
    expect(data).toEqual({ 'reads-test:system': { hostname: 'r1', mtu: 1500, dns: ['8.8.8.8', '1.1.1.1'], 'uptime-info': { uptime: 1234 } } });
  });

  it('AC3: with-origin returns or:origin annotations: intended for running, and what the operational data marks', async () => {
    const { c, device } = await readsSession();
    const data = dataJson(device, await send(c, getData('operational', '<subtree-filter><interfaces xmlns="urn:example:reads"/></subtree-filter><with-origin/>')), NMDA) as {
      'reads-test:interfaces': { '@': unknown; interface: { name: string; '@'?: unknown }[] };
    };
    expect(data['reads-test:interfaces']['@']).toEqual({ 'ietf-origin:origin': 'ietf-origin:intended' });
    expect(data['reads-test:interfaces'].interface.find((i) => i.name === 'mgmt0')!['@']).toEqual({ 'ietf-origin:origin': 'ietf-origin:system' });
    // Without with-origin, none; and with-origin on a configuration datastore is invalid-value.
    expect((await send(c, getData('operational', SYSTEM))).toString()).not.toContain('origin=');
    expect(errorTag(await send(c, getData('running', '<with-origin/>')))).toBe('invalid-value');
    // origin-filter keeps configuration of a matching origin, and all state.
    const OR = 'xmlns:or="urn:ietf:params:xml:ns:yang:ietf-origin"';
    const sys = dataJson(device, await send(c, getData('operational', `<subtree-filter><interfaces xmlns="urn:example:reads"/></subtree-filter><origin-filter ${OR}>or:system</origin-filter>`)), NMDA);
    expect(sys).toEqual({
      'reads-test:interfaces': {
        interface: [
          { name: 'eth0', stats: { 'in-octets': '100', 'out-octets': '200' } },
          { name: 'lo', stats: { 'in-octets': '1', 'out-octets': '1' } },
          { name: 'mgmt0', type: 'reads-test:ethernet', stats: { 'in-octets': '5', 'out-octets': '6' } },
        ],
      },
    });
    const notSys = dataJson(device, await send(c, getData('operational', `<subtree-filter><interfaces xmlns="urn:example:reads"><interface><name>mgmt0</name></interface></interfaces></subtree-filter><negated-origin-filter ${OR}>or:system</negated-origin-filter>`)), NMDA);
    expect(notSys).toEqual({ 'reads-test:interfaces': { interface: [{ name: 'mgmt0', stats: { 'in-octets': '5', 'out-octets': '6' } }] } });
    expect(errorTag(await send(c, getData('running', `<origin-filter ${OR}>or:system</origin-filter>`)))).toBe('invalid-value');
    expect(errorTag(await send(c, getData('operational', `<origin-filter ${OR}>or:nope</origin-filter>`)))).toBe('invalid-value');
  });

  it('AC3: with-origin shows learned or system for configuration a provider marks so', async () => {
    const p = await providersSession();
    const origin = (o: string): Record<string, string> => ({ 'ietf-origin:origin': `ietf-origin:${o}` });
    await p.srv.provide('/providers-test:interfaces/interface', {
      onRead: () => ({
        'providers-test:interfaces': {
          interface: [
            { name: 'lo', mtu: 9000, '@': origin('system') },
            { name: 'tun0', mtu: 1400, '@': origin('learned') },
          ],
        },
      }),
    });
    const filter = `<subtree-filter><interfaces xmlns="${PT}"/></subtree-filter><with-origin/>`;
    const data = dataJson(p.device, await send(p.c, getData('operational', filter)), NMDA) as {
      'providers-test:interfaces': { '@': unknown; interface: { name: string; '@'?: unknown }[] };
    };
    const byName = new Map(data['providers-test:interfaces'].interface.map((i) => [i.name, i['@']]));
    expect(data['providers-test:interfaces']['@']).toEqual(origin('intended'));
    expect(byName.get('eth0')).toBeUndefined();
    expect(byName.get('lo')).toEqual(origin('system'));
    expect(byName.get('tun0')).toEqual(origin('learned'));
  });

  it('AC4: config-filter, max-depth and with-defaults as RFC 8526 §3.1.1 defines them', async () => {
    const { c, device } = await readsSession();
    expect(dataJson(device, await send(c, getData('operational', `${SYSTEM}<config-filter>false</config-filter>`)), NMDA)).toEqual({
      'reads-test:system': { 'uptime-info': { uptime: 1234 } },
    });
    expect(dataJson(device, await send(c, getData('operational', `${SYSTEM}<config-filter>true</config-filter>`)), NMDA)).toEqual({
      'reads-test:system': { hostname: 'r1', mtu: 1500, dns: ['8.8.8.8', '1.1.1.1'] },
    });
    expect(dataJson(device, await send(c, getData('running', '<max-depth>1</max-depth>')), NMDA)).toEqual({ 'reads-test:system': {}, 'reads-test:interfaces': {} });
    expect(dataJson(device, await send(c, getData('running', '<subtree-filter><interfaces xmlns="urn:example:reads"/></subtree-filter><max-depth>2</max-depth>')), NMDA)).toEqual({
      'reads-test:interfaces': { interface: [{ name: 'eth0' }, { name: 'lo' }] },
    });
    expect(errorTag(await send(c, getData('running', '<max-depth>0</max-depth>')))).toBe('invalid-value');
    expect(errorTag(await send(c, getData('running', '<config-filter>maybe</config-filter>')))).toBe('invalid-value');
    const all = dataJson(device, await send(c, getData('running', `${SYSTEM}<with-defaults>report-all</with-defaults>`)), NMDA);
    expect(all).toEqual({ 'reads-test:system': { hostname: 'r1', mtu: 1500, dns: ['8.8.8.8', '1.1.1.1'], clock: { timezone: 'UTC' } } });
    // RFC 8526: with-defaults on <operational> needs :with-operational-defaults, which the server doesn't advertise.
    expect(errorTag(await send(c, getData('operational', '<with-defaults>report-all</with-defaults>')))).toBe('invalid-value');
  });

  it('AC5: the YANG library lists every datastore the server implements, with its schema', async () => {
    const { c, device } = await readsSession();
    const reply = await send(c, getData('operational', '<subtree-filter><yang-library xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library"/></subtree-filter>'));
    const library = readYangLibrary(dataJson(device, reply, NMDA) as object);
    expect(library.datastores.map((d) => d.name).sort()).toEqual(
      ['candidate', 'intended', 'operational', 'running', 'startup'].map((d) => `ietf-datastores:${d}`),
    );
    expect(new Set(library.datastores.map((d) => d.schema))).toEqual(new Set(['complete']));
  });
});
