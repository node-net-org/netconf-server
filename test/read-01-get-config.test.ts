// READ-01: read configuration with get-config.
import { describe, expect, it } from 'vitest';
import { providersSession } from './providers-helpers.js';
import { NETCONF_NS } from '@node-net/netconf/core';
import { errorInfo, errorTag } from './helpers.js';
import { dataJson, readsSession, send } from './reads-helpers.js';

const RUNNING = {
  'reads-test:system': { hostname: 'r1', mtu: 1500, dns: ['8.8.8.8', '1.1.1.1'] },
  'reads-test:interfaces': {
    interface: [
      { name: 'eth0', type: 'reads-test:ethernet', enabled: false, description: 'uplink' },
      { name: 'lo', type: 'reads-test:loopback' },
    ],
  },
};

describe('READ-01 get-config', () => {
  it('AC1: get-config of running returns exactly the running configuration, in <data>', async () => {
    const { c, device } = await readsSession();
    const reply = await send(c, '<get-config><source><running/></source></get-config>');
    expect(reply.child('data', NETCONF_NS)).toBeDefined();
    expect(dataJson(device, reply, NETCONF_NS, 'running')).toEqual(RUNNING);
  });

  it('AC2: get-config of candidate returns the candidate, and of startup the saved startup configuration', async () => {
    // Unedited, the candidate is running; edited, it shows the uncommitted edits while running doesn't.
    const { c, device } = await readsSession();
    expect(dataJson(device, await send(c, '<get-config><source><candidate/></source></get-config>'), NETCONF_NS, 'candidate')).toEqual(RUNNING);
    await send(c, '<edit-config><target><candidate/></target><config><system xmlns="urn:example:reads"><hostname>uncommitted</hostname></system></config></edit-config>');
    const candidate = dataJson(device, await send(c, '<get-config><source><candidate/></source></get-config>'), NETCONF_NS, 'candidate');
    expect(candidate).toEqual({ ...RUNNING, 'reads-test:system': { ...RUNNING['reads-test:system'], hostname: 'uncommitted' } });
    expect(dataJson(device, await send(c, '<get-config><source><running/></source></get-config>'), NETCONF_NS, 'running')).toEqual(RUNNING);
    expect(dataJson(device, await send(c, '<get-config><source><startup/></source></get-config>'), NETCONF_NS, 'startup')).toEqual({
      'reads-test:system': { hostname: 'r1-startup' },
    });
  });

  it('AC3: a datastore the device does not advertise gets invalid-value', async () => {
    const { c } = await readsSession((def) => ({ ...def, capabilities: {}, data: { running: def.data!.running! } }));
    for (const ds of ['candidate', 'startup']) {
      const reply = await send(c, `<get-config><source><${ds}/></source></get-config>`);
      expect(errorTag(reply)).toBe('invalid-value');
      expect(errorInfo(reply, 'bad-element')).toBe(ds);
    }
    expect(errorTag(await send(c, '<get-config><source><url>x</url></source></get-config>'))).toBe('invalid-value');
    expect(errorTag(await send(c, '<get-config/>'))).toBe('missing-element');
  });

  it('AC4: get-config never returns state data', async () => {
    const { c } = await readsSession();
    const text = (await send(c, '<get-config><source><running/></source></get-config>')).toString();
    for (const state of ['uptime-info', 'stats', 'mgmt0', 'netconf-state', 'yang-library']) expect(text).not.toContain(state);
  });

  it('AC5: get-config never calls a provider’s read hook', async () => {
    const p = await providersSession();
    let calls = 0;
    await p.srv.provide('/providers-test:interfaces/interface', { onRead: () => void calls++ });
    for (const ds of ['running', 'candidate']) await send(p.c, `<get-config><source><${ds}/></source></get-config>`);
    const running = '<datastore xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores">ds:running</datastore>';
    await send(p.c, `<get-data xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-nmda">${running}</get-data>`);
    expect(calls).toBe(0);
  });
});
