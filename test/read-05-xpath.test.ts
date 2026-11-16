// READ-05: narrow reads with XPath filters (RFC 6241 §8.9).
import { describe, expect, it } from 'vitest';
import { errorInfo, errorTag } from './helpers.js';
import { dataJson, NMDA, readsSession, send } from './reads-helpers.js';

const xpath = (select: string, ns = 'xmlns:rt="urn:example:reads"'): string => `<get><filter type="xpath" ${ns} select="${select}"/></get>`;

describe('READ-05 XPath filters', () => {
  it('AC1: returns the selected nodes with their ancestors and list keys', async () => {
    const { c, device } = await readsSession();
    expect(dataJson(device, await send(c, xpath("/rt:interfaces/rt:interface[rt:enabled='false']/rt:description")))).toEqual({
      'reads-test:interfaces': { interface: [{ name: 'eth0', description: 'uplink' }] },
    });
    expect(dataJson(device, await send(c, xpath('//rt:uptime')))).toEqual({ 'reads-test:system': { 'uptime-info': { uptime: 1234 } } });
    // get-data's xpath-filter.
    const data = dataJson(
      device,
      await send(c, `<get-data xmlns="${NMDA}" xmlns:ds="urn:ietf:params:xml:ns:yang:ietf-datastores"><datastore>ds:running</datastore><xpath-filter xmlns:r="urn:example:reads">/r:system/r:hostname</xpath-filter></get-data>`),
      NMDA,
    );
    expect(data).toEqual({ 'reads-test:system': { hostname: 'r1' } });
  });

  it('AC2: prefixes in the expression resolve through the namespace declarations on the filter element', async () => {
    const { c, device } = await readsSession();
    expect(dataJson(device, await send(c, xpath('/q:system/q:hostname', 'xmlns:q="urn:example:reads"')))).toEqual({ 'reads-test:system': { hostname: 'r1' } });
    // The module's own prefix is not in scope unless declared.
    expect(errorTag(await send(c, xpath('/rt:system', '')))).toBe('invalid-value');
  });

  it('AC3: an expression that does not parse, or uses an unknown prefix, gets invalid-value', async () => {
    const { c } = await readsSession();
    for (const select of ['/rt:system[', '/zz:system', 'count(/rt:system)']) {
      const reply = await send(c, xpath(select));
      expect(errorTag(reply)).toBe('invalid-value');
      expect(errorInfo(reply, 'bad-element')).toBe('filter');
    }
    expect(errorTag(await send(c, '<get><filter type="xpath"/></get>'))).toBe('missing-attribute');
    expect(errorTag(await send(c, '<get><filter type="regex" select="x"/></get>'))).toBe('bad-attribute');
  });

  it('AC4: without :xpath advertised, an xpath filter gets operation-not-supported', async () => {
    const { c } = await readsSession((def) => ({ ...def, capabilities: { ...def.capabilities, xpath: false } }));
    expect(errorTag(await send(c, xpath('/rt:system')))).toBe('operation-not-supported');
  });
});
