// CONTROL-01: enable the control module per deployment.

import { serializeXml } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { CTL, NC, notificationsDevice, notifySession } from './notify-helpers.js';
import { errorTags, isOk } from './writes-helpers.js';

const LIBRARY = `<get><filter type="subtree"><yang-library xmlns="urn:ietf:params:xml:ns:yang:ietf-yang-library"/></filter></get>`;
const SNAPSHOT = `<snapshot xmlns="${CTL}"><name>s</name></snapshot>`;
const caps = (hello: { child: (n: string, ns: string) => { childrenNamed: (n: string, ns: string) => { text(): string }[] } | undefined }): string[] =>
  hello.child('capabilities', NC)!.childrenNamed('capability', NC).map((e) => e.text());

describe('CONTROL-01 enable the control module per deployment', () => {
  it('AC1: the control module is advertised and usable only when enabled', async () => {
    // A YANG 1.1 module is advertised in the YANG library, not the hello (RFC 7950 §5.6.4).
    const on = await notifySession({ control: { enabled: true } });
    expect(serializeXml(await on.c.call(LIBRARY))).toContain('net-netconf-server-control');
    expect(isOk(await on.c.call(SNAPSHOT))).toBe(true);
    expect(on.srv.control).toBeDefined();

    const off = await notifySession({ control: { enabled: false } });
    expect(caps(off.c.raw.messages[0]!).some((c) => c.includes('net-netconf-server-control'))).toBe(false);
    expect(serializeXml(await off.c.call(LIBRARY))).not.toContain('net-netconf-server-control');
    expect(off.srv.control).toBeUndefined();
  });

  it('AC2: on by default with no providers, off by default with any', async () => {
    const plain = await notifySession();
    expect(plain.srv.control).toBeDefined();
    const withProvider = await notifySession({ providers: [{ path: '/notif-test:servers', provider: {} }] });
    expect(withProvider.srv.control).toBeUndefined();
    // Providers registered later don't change it.
    await plain.srv.provide('/notif-test:servers', {});
    expect(plain.srv.control).toBeDefined();
  });

  it('AC3: the deployment can restrict control operations to named users; others get access-denied', async () => {
    const { c, open } = await notifySession({ control: { users: ['admin'] } });
    expect(errorTags(await c.call(SNAPSHOT))).toEqual(['access-denied']);
    const admin = await open('admin');
    expect(isOk(await admin.call(SNAPSHOT))).toBe(true);
  });

  it('AC4: when disabled, control RPCs get unknown-namespace, and the module is absent from the YANG library and get-schema', async () => {
    const { c } = await notifySession({ control: { enabled: false } });
    expect(errorTags(await c.call(SNAPSHOT))).toEqual(['unknown-namespace']);
    const lib = await c.call(LIBRARY);
    expect(serializeXml(lib)).not.toContain('net-netconf-server-control');
    const schema = await c.call(`<get-schema xmlns="urn:ietf:params:xml:ns:yang:ietf-netconf-monitoring"><identifier>net-netconf-server-control</identifier></get-schema>`);
    expect(errorTags(schema)).toEqual(['invalid-value']);
    // A device loaded with the control module is recompiled without it.
    expect((await notificationsDevice()).control).toBe(true);
  });
});
