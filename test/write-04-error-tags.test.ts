// WRITE-04: schema violations get the error-tags of RFC 6241 Appendix A and the error-app-tags of RFC 7950 §15.
import { describe, expect, it } from 'vitest';
import { NC } from './helpers.js';
import { editConfig, rpcErrors, send, WT, writesSession, YANG } from './writes-helpers.js';

const sys = (body: string): string => `<system xmlns="${WT}">${body}</system>`;
const ifs = (body: string): string => `<interfaces xmlns="${WT}">${body}</interfaces>`;

describe('WRITE-04 error-tags for schema violations', () => {
  it('answers a value of the wrong type or outside its range, length or pattern with invalid-value naming the leaf', async () => {
    const { c } = await writesSession();
    for (const [body, leaf] of [
      ['<mtu>big</mtu>', 'mtu'],
      ['<mtu>10</mtu>', 'mtu'],
      ['<hostname></hostname>', 'hostname'],
    ] as const) {
      const [e] = rpcErrors(await send(c, editConfig('running', sys(body))));
      expect(e?.tag, body).toBe('invalid-value');
      expect(e?.path, body).toBe(`/writes-test:system/writes-test:${leaf}`);
    }
  });

  it('answers an unknown element with unknown-element and an unknown namespace with unknown-namespace', async () => {
    const { c } = await writesSession();
    const [unknown] = rpcErrors(await send(c, editConfig('running', sys('<colour>red</colour>'))));
    expect(unknown?.tag).toBe('unknown-element');
    expect(unknown?.element.child('error-info', NC)?.child('bad-element', NC)?.text()).toBe('colour');
    const [ns] = rpcErrors(await send(c, editConfig('running', '<system xmlns="urn:example:nothing"><hostname>x</hostname></system>')));
    expect(ns?.tag).toBe('unknown-namespace');
  });

  it('answers a broken must with operation-failed, its error-app-tag and its error-message', async () => {
    const { c } = await writesSession();
    const [e] = rpcErrors(await send(c, editConfig('running', sys('<mtu>1400</mtu><min-mtu>1500</min-mtu>'))));
    expect(e).toMatchObject({ tag: 'operation-failed', appTag: 'mtu-too-small', message: 'mtu is below min-mtu' });
  });

  it('answers a broken leafref with data-missing and instance-required', async () => {
    const { c } = await writesSession();
    const [e] = rpcErrors(await send(c, editConfig('running', sys('<admin-interface>eth7</admin-interface>'))));
    expect(e).toMatchObject({ tag: 'data-missing', appTag: 'instance-required', path: '/writes-test:system/writes-test:admin-interface' });
  });

  it('maps mandatory, unique, element counts and a missing choice as RFC 7950 §15 does', async () => {
    const { c } = await writesSession();
    const mandatory = rpcErrors(await send(c, editConfig('running', ifs('<interface><name>e1</name></interface>'))));
    expect(mandatory.map((e) => e.tag)).toEqual(['data-missing']);

    const unique = rpcErrors(await send(c, editConfig('running', ifs('<interface><name>e1</name><type>t</type><address>10.0.0.1</address></interface>'))));
    expect(unique[0]).toMatchObject({ tag: 'operation-failed', appTag: 'data-not-unique' });
    expect(unique[0]!.element.child('error-info', NC)?.childrenNamed('non-unique', YANG).length).toBeGreaterThan(0);

    const five = ['a', 'b', 'c', 'd'].map((n) => `<interface><name>${n}</name><type>t</type></interface>`).join('');
    const many = rpcErrors(await send(c, editConfig('running', ifs(five))));
    expect(many[0]).toMatchObject({ tag: 'operation-failed', appTag: 'too-many-elements' });

    const few = rpcErrors(await send(c, editConfig('running', `<ntp xmlns="${WT}"/>`)));
    expect(few[0]).toMatchObject({ tag: 'operation-failed', appTag: 'too-few-elements' });

    const choice = rpcErrors(await send(c, editConfig('running', `<transport xmlns="${WT}"/>`)));
    expect(choice[0]).toMatchObject({ tag: 'data-missing', appTag: 'missing-choice' });
    expect(choice[0]!.element.child('error-info', NC)?.child('missing-choice', YANG)?.text()).toBe('protocol');
  });

  it('reports every violation, each as its own rpc-error, in one reply', async () => {
    const { c } = await writesSession();
    const edit = sys('<admin-interface>eth7</admin-interface><mtu>1400</mtu><min-mtu>1500</min-mtu>') + ifs('<interface><name>e1</name></interface>');
    const errors = rpcErrors(await send(c, editConfig('running', edit)));
    expect(errors.map((e) => e.tag).sort()).toEqual(['data-missing', 'data-missing', 'operation-failed']);
  });

  // AC7 (agreement with netopeer2's error-tags) is checked by the interop write set, test/interop/writes.test.ts.
});
