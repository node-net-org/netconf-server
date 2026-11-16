import { describe, expect, it } from 'vitest';
import { RpcFailure, type OperationCall } from '../src/core.js';
import { errorTags, isOk, rpcErrors, send } from './writes-helpers.js';
import { PT, providersSession } from './providers-helpers.js';

const IF = '/providers-test:interfaces/interface';
const YANG = 'urn:ietf:params:xml:ns:yang:1';
const restart = (inner: string): string => `<restart xmlns="${PT}">${inner}</restart>`;
const reset = (name: string, inner = ''): string => `<action xmlns="${YANG}"><interfaces xmlns="${PT}"><interface><name>${name}</name><reset>${inner}</reset></interface></interfaces></action>`;

describe('PROVIDER-11 implement custom RPCs and actions', () => {
  it('calls an RPC handler with the decoded, validated input', async () => {
    const { srv, c } = await providersSession();
    const calls: OperationCall[] = [];
    await srv.provide('/providers-test:system', {
      rpcs: { 'providers-test:restart': (call) => (calls.push(call), { when: 'now' }) },
    });
    await send(c, restart('<after>5</after><interface>eth1</interface>'));
    expect(calls.map((x) => [x.input, x.username, x.path])).toEqual([[{ after: 5, interface: 'eth1' }, 'tester', undefined]]);
  });

  it('validates the output and returns it in the reply; a handler with no output gets ok', async () => {
    const { srv, c } = await providersSession();
    let output: Record<string, unknown> | undefined = { when: 'in five seconds' };
    await srv.provide('/providers-test:system', {
      rpcs: { 'providers-test:restart': () => output as never, 'providers-test:ping': () => undefined },
    });
    const reply = await send(c, restart(''));
    expect(reply.child('when', PT)?.text()).toBe('in five seconds');
    expect(isOk(await send(c, `<ping xmlns="${PT}"/>`))).toBe(true);
    output = { wen: 'typo' };
    expect(errorTags(await send(c, restart('')))).toEqual(['operation-failed']);
    output = {};
    // restart's output has a mandatory leaf, so empty output is not valid either: but no output at all is ok.
    expect(isOk(await send(c, restart('')))).toBe(true);
  });

  it('rejects input that breaks the schema with its violations, before the handler', async () => {
    const { srv, c } = await providersSession();
    let called = 0;
    await srv.provide('/providers-test:system', { rpcs: { 'providers-test:restart': () => (called++, { when: 'now' }) } });
    expect(errorTags(await send(c, restart('<after>99</after>')))).toEqual(['invalid-value']);
    expect(errorTags(await send(c, restart('<interface>eth9</interface>')))).toEqual(['data-missing']);
    expect(called).toBe(0);
  });

  it('gives an action handler the instance path, and answers data-missing for an action on a node that doesn’t exist', async () => {
    const { srv, c } = await providersSession();
    const calls: OperationCall[] = [];
    await srv.provide(IF, { actions: { [`${IF}/reset`]: (call) => (calls.push(call), { result: `reset ${call.path}` }) } });
    const reply = await send(c, reset('eth1', '<delay>3</delay>'));
    expect(reply.child('result', PT)?.text()).toBe("reset /providers-test:interfaces/interface[name='eth1']");
    expect(calls.map((x) => [x.path, x.input])).toEqual([["/providers-test:interfaces/interface[name='eth1']", { delay: 3 }]]);
    expect(errorTags(await send(c, reset('eth9')))).toEqual(['data-missing']);
    expect(calls).toHaveLength(1);
  });

  it('answers operation-failed with the message of a handler that throws, or the rpc-errors it gives', async () => {
    const { srv, c } = await providersSession();
    let failure: Error = new Error('the watchdog said no');
    await srv.provide('/providers-test:system', {
      rpcs: {
        'providers-test:restart': () => {
          throw failure;
        },
      },
    });
    let errors = rpcErrors(await send(c, restart('')));
    expect(errors.map((e) => [e.tag, e.message])).toEqual([['operation-failed', 'the watchdog said no']]);
    failure = new RpcFailure({ type: 'application', tag: 'resource-denied', message: 'Too soon after the last restart' });
    errors = rpcErrors(await send(c, restart('')));
    expect(errors.map((e) => [e.tag, e.message])).toEqual([['resource-denied', 'Too soon after the last restart']]);
  });

  it('answers operation-not-supported for an RPC or action in the schema with no handler', async () => {
    const { srv, c } = await providersSession();
    expect(errorTags(await send(c, restart('')))).toEqual(['operation-not-supported']);
    expect(errorTags(await send(c, reset('eth0')))).toEqual(['operation-not-supported']);
    const handle = await srv.provide('/providers-test:system', { rpcs: { 'providers-test:restart': () => ({ when: 'now' }) } });
    expect(rpcErrors(await send(c, restart('')))).toEqual([]);
    handle.unregister();
    expect(errorTags(await send(c, restart('')))).toEqual(['operation-not-supported']);
  });
});
