// READ-02: read configuration and state with get.
import { describe, expect, it } from 'vitest';
import { get as providerGet, PT, providersSession } from './providers-helpers.js';
import { dataJson, readsSession, send } from './reads-helpers.js';

describe('READ-02 get', () => {
  it('AC1: get returns the running configuration merged with operational state (RFC 8342 §5.3)', async () => {
    const { c, device } = await readsSession();
    const data = dataJson(device, await send(c, '<get><filter><system xmlns="urn:example:reads"/><interfaces xmlns="urn:example:reads"/></filter></get>'));
    expect(data).toEqual({
      'reads-test:system': { hostname: 'r1', mtu: 1500, dns: ['8.8.8.8', '1.1.1.1'], 'uptime-info': { uptime: 1234 } },
      'reads-test:interfaces': {
        interface: [
          { name: 'eth0', type: 'reads-test:ethernet', enabled: false, description: 'uplink', stats: { 'in-octets': '100', 'out-octets': '200' } },
          { name: 'lo', type: 'reads-test:loopback', stats: { 'in-octets': '1', 'out-octets': '1' } },
          { name: 'mgmt0', type: 'reads-test:ethernet', stats: { 'in-octets': '5', 'out-octets': '6' } },
        ],
      },
    });
    // Legacy clients see no origin annotations.
    expect((await send(c, '<get/>')).toString()).not.toContain('origin=');
  });

  it('AC2: state-only nodes appear in get but not in get-config', async () => {
    const { c } = await readsSession();
    const get = (await send(c, '<get/>')).toString();
    const config = (await send(c, '<get-config><source><running/></source></get-config>')).toString();
    for (const state of ['<uptime-info>', '<stats>', '<netconf-state', '<yang-library']) {
      expect(get).toContain(state);
      expect(config).not.toContain(state);
    }
  });

  it('AC3: read hooks run only for the providers whose subtrees the filter selects', async () => {
    const p = await providersSession();
    const calls: string[] = [];
    await p.srv.provide('/providers-test:interfaces/interface', { onRead: () => void calls.push('interfaces') });
    await p.srv.provide('/providers-test:system/clock', { onRead: () => void calls.push('clock') });
    await send(p.c, providerGet(`<interfaces xmlns="${PT}"><interface><name>eth0</name></interface></interfaces>`));
    expect(calls).toEqual(['interfaces']);
    calls.length = 0;
    await send(p.c, `<get><filter type="xpath" select="/pt:system/pt:clock" xmlns:pt="${PT}"/></get>`);
    expect(calls).toEqual(['clock']);
    calls.length = 0;
    await send(p.c, `<get><filter type="xpath" select="/pt:routes" xmlns:pt="${PT}"/></get>`);
    expect(calls).toEqual([]);
    await send(p.c, providerGet(''));
    expect(calls.sort()).toEqual(['clock', 'interfaces']);
  });
});
