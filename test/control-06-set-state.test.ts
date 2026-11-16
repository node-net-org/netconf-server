// CONTROL-06: set operational state on demand.

import type { XmlElement } from '@node-net/netconf/core';
import { describe, expect, it } from 'vitest';
import { CTL, NC, notifySession } from './notify-helpers.js';
import { errorTags, isOk } from './writes-helpers.js';

const setState = (json: string): string => `<set-state xmlns="${CTL}"><edit>${json}</edit></set-state>`;
const STATUS = '<get><filter type="subtree"><servers xmlns="urn:example:notif"><server><name>a</name><status/></server></servers></filter></get>';

function status(reply: XmlElement): string | undefined {
  return reply.child('data', NC)!.elements[0]?.elements[0]?.elements.find((e) => e.name === 'status')?.text();
}

describe('CONTROL-06 set operational state on demand', () => {
  it('AC1: applies an edit to state data in operational, validated against the schema', async () => {
    const { c } = await notifySession();
    expect(isOk(await c.call(setState('{"notif-test:servers":{"server":[{"name":"a","status":"down"}]}}')))).toBe(true);
    expect(status(await c.call(STATUS))).toBe('down');
    expect(errorTags(await c.call(setState('{"notif-test:servers":{"server":[{"name":"a","status":"sideways"}]}}')))).toEqual(['invalid-value']);
  });

  it('AC2: the change is visible to the next read from any session', async () => {
    const { srv, open } = await notifySession();
    srv.control!.setState({ 'notif-test:servers': { server: [{ name: 'a', status: 'down' }] } });
    const other = await open('other');
    expect(status(await other.call(STATUS))).toBe('down');
  });

  it('AC3: an edit that touches configuration nodes gets invalid-value', async () => {
    const { c } = await notifySession();
    expect(errorTags(await c.call(setState('{"notif-test:servers":{"server":[{"name":"a","port":1}]}}')))).toEqual(['invalid-value']);
    const config = await c.call('<get-config><source><running/></source></get-config>');
    expect(config.child('data', NC)!.elements[0]!.elements[0]!.elements.find((e) => e.name === 'port')!.text()).toBe('8080');
  });
});
