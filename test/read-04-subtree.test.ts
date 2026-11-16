// READ-04: narrow reads with subtree filters (RFC 6241 §6). AC5 (agreement with netopeer2) is checked by test:interop.
import { describe, expect, it } from 'vitest';
import { NETCONF_NS } from '@node-net/netconf/core';
import { errorTag } from './helpers.js';
import { dataJson, NMDA, readsSession, send } from './reads-helpers.js';

const get = (filter: string): string => `<get><filter type="subtree">${filter}</filter></get>`;

describe('READ-04 subtree filters', () => {
  it('AC1: containment, selection and content-match nodes as RFC 6241 §6.2 defines them, with list keys', async () => {
    const { c, device } = await readsSession();
    // Containment narrows, selection takes the subtree, content match picks the entry; the key comes back.
    const one = dataJson(device, await send(c, get('<interfaces xmlns="urn:example:reads"><interface><enabled>false</enabled><description/></interface></interfaces>')));
    expect(one).toEqual({ 'reads-test:interfaces': { interface: [{ name: 'eth0', enabled: false, description: 'uplink' }] } });
    // Only content matches: the whole entry.
    const whole = dataJson(device, await send(c, get('<interfaces xmlns="urn:example:reads"><interface><name>lo</name></interface></interfaces>')));
    expect(whole).toEqual({ 'reads-test:interfaces': { interface: [{ name: 'lo', type: 'reads-test:loopback', stats: { 'in-octets': '1', 'out-octets': '1' } }] } });
    // Typed content match, and identityrefs with the filter's own prefix.
    const typed = dataJson(device, await send(c, get('<interfaces xmlns="urn:example:reads" xmlns:x="urn:example:reads"><interface><type>x:ethernet</type><name/></interface></interfaces>')));
    expect(typed).toEqual({ 'reads-test:interfaces': { interface: [{ name: 'eth0', type: 'reads-test:ethernet' }, { name: 'mgmt0', type: 'reads-test:ethernet' }] } });
    // get-data's subtree-filter is the same.
    const data = dataJson(device, await send(c, `<get-data xmlns="${NMDA}" xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores"><datastore>ds:running</datastore><subtree-filter><system xmlns="urn:example:reads"><dns/></system></subtree-filter></get-data>`), NMDA);
    expect(data).toEqual({ 'reads-test:system': { dns: ['8.8.8.8', '1.1.1.1'] } });
  });

  it('AC2: attribute match expressions are honoured', async () => {
    const { c, device } = await readsSession();
    const OR = 'xmlns:or="urn:ietf:params:xml:ns:yang:ietf-origin"';
    const reply = await send(
      c,
      `<get-data xmlns="${NMDA}" xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores"><datastore>ds:operational</datastore><subtree-filter><interfaces xmlns="urn:example:reads"><interface ${OR} or:origin="or:system"><name/></interface></interfaces></subtree-filter></get-data>`,
    );
    expect(dataJson(device, reply, NMDA)).toEqual({ 'reads-test:interfaces': { interface: [{ name: 'mgmt0' }] } });
  });

  it('AC3: an empty filter returns no data; no filter returns everything', async () => {
    const { c } = await readsSession();
    const empty = await send(c, '<get><filter type="subtree"/></get>');
    expect(empty.child('data', NETCONF_NS)!.children).toEqual([]);
    const all = (await send(c, '<get/>')).child('data', NETCONF_NS)!.elements.map((e) => e.name);
    expect(all).toEqual(expect.arrayContaining(['system', 'interfaces', 'yang-library', 'netconf-state']));
  });

  it('AC4: a filter naming nodes that are not in the schema returns an empty data element, not an error', async () => {
    const { c } = await readsSession();
    for (const filter of ['<nothing xmlns="urn:example:reads"/>', '<system xmlns="urn:example:elsewhere"/>', '<system xmlns="urn:example:reads"><nope/></system>']) {
      const reply = await send(c, get(filter));
      expect(errorTag(reply)).toBeUndefined();
      expect(reply.child('data', NETCONF_NS)!.elements).toEqual([]);
    }
  });
});
