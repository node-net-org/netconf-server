// NACM-08 AC3: the write check visits only decision points inside a created
// or deleted subtree, and must still refuse exactly what a check of every
// node would. Each policy below is crossed with created and deleted trees,
// and firstDeniedWrite's answer compared with a walk of every node.
import { beforeAll, describe, expect, it } from 'vitest';
import { DataTree, decodeJson, diffTrees, type InstanceNode } from '@node-net/yang/core';
import { loadDevice, type Device } from '../src/core.js';
import { decideChain, type Subject } from '../src/nacm/decide.js';
import { Nacm } from '../src/nacm/engine.js';
import { chainOf } from '../src/nacm/path.js';
import { firstDeniedWrite, type WriteAccess } from '../src/nacm/write-check.js';
import { nacm } from './nacm-helpers.js';
import { policy, rule, WRITE_DEVICE, WRITE_SOURCE, type Json } from './nacm-write-helpers.js';

let device: Device;
let engine: Nacm;

beforeAll(async () => {
  device = await loadDevice(WRITE_DEVICE, { source: WRITE_SOURCE });
  engine = new Nacm(device.schema, { warn: () => undefined });
});

const ITEM = '/acme-w:top/item';
const modRule = (name: string, module: string, ops: string, action: 'permit' | 'deny'): Json => ({ name, 'module-name': module, 'access-operations': ops, action });

/** Policies that put decision points at different depths and of every kind. */
const POLICIES: Record<string, Json> = {
  'no rules, write-default deny': policy([]),
  'no rules, write-default permit': policy([], { 'write-default': 'permit' }),
  'rule on the item': policy([rule('items', ITEM, '*')]),
  'rule on the item, default permit': policy([rule('items', ITEM, 'create')], { 'write-default': 'permit' }),
  'deny a leaf, permit the item': policy([rule('no-colour', `${ITEM}/colour`, '*', 'deny'), rule('items', ITEM, '*')]),
  'keyed deny on a descendant': policy([rule('no-x', `${ITEM}[name='x']/colour`, 'create delete', 'deny'), rule('items', ITEM, '*')]),
  'keyed deny on an entry, default permit': policy([rule('no-y', `${ITEM}[name='y']`, '*', 'deny')], { 'write-default': 'permit' }),
  'keyed permit on a secret': policy([rule('x-secret', `${ITEM}[name='x']/secret`, '*')], { 'write-default': 'permit' }),
  'module permit for acme-w only': policy([modRule('w', 'acme-w', '*', 'permit')]),
  'module deny for the augmenting module': policy([modRule('wa', 'acme-w-aug', '*', 'deny')], { 'write-default': 'permit' }),
  'module permit, path deny below': policy([rule('no-code', `${ITEM}/secret/code`, 'delete create', 'deny'), modRule('w', 'acme-w', '*', 'permit')]),
  'permit guarded explicitly': policy([rule('guarded', '/acme-w:top/guarded', '*')], { 'write-default': 'permit' }),
  'create only, default deny': policy([rule('top', '/acme-w:top', 'create')]),
  'update only on top': policy([rule('top', '/acme-w:top', 'update')], { 'write-default': 'permit' }),
};

/** Configuration to create or delete whole. */
const TREES: Record<string, Json> = {
  'items with secrets and an augmented leaf': {
    'acme-w:top': {
      speed: 's',
      item: [
        { name: 'w', colour: 'c', secret: { code: '1' } },
        { name: 'x', colour: 'c', 'acme-w-aug:extra': 'e', secret: { code: '2' } },
        { name: 'y', colour: 'c' },
      ],
      guarded: { value: 'g' },
      ordered: [{ name: 'o1' }, { name: 'o2' }],
    },
  },
  'one plain item': { 'acme-w:top': { item: [{ name: 'z' }] } },
  'only the guarded container': { 'acme-w:top': { guarded: { value: 'g' } } },
  'an item with only a secret': { 'acme-w:top': { item: [{ name: 'x', secret: { code: '3' } }] } },
};

/** The first refused node, checking every node in preorder: what firstDeniedWrite must agree with. */
function naive(subject: Subject, roots: readonly InstanceNode[], access: WriteAccess): InstanceNode | undefined {
  const visit = (n: InstanceNode): InstanceNode | undefined => {
    const npContainer = n.kind === 'container' && n.schema.kind === 'container' && n.schema.presence === undefined;
    if (!npContainer && !decideChain(subject, chainOf(n), access).permit) return n;
    for (const c of 'children' in n ? n.children : []) {
      const d = visit(c);
      if (d !== undefined) return d;
    }
    return undefined;
  };
  for (const r of roots) {
    const d = visit(r);
    if (d !== undefined) return d;
  }
  return undefined;
}

describe('NACM-08 the write check agrees with a check of every node', () => {
  for (const [policyName, p] of Object.entries(POLICIES)) {
    it(policyName, () => {
      for (const [treeName, data] of Object.entries(TREES)) {
        const running = decodeJson(device.schema.forDatastore('running'), nacm(p));
        const subject = engine.subject(running, { username: 'alice' }, false)!;
        const full = decodeJson(device.schema.forDatastore('running'), data);
        const empty = new DataTree(full.schema);
        for (const [access, changes] of [
          ['create', diffTrees(empty, full)],
          ['delete', diffTrees(full, empty)],
        ] as const) {
          const expected = naive(subject, changes.map((c) => c.node), access);
          const got = firstDeniedWrite(subject, changes);
          expect(got?.node.path, `${treeName}, ${access}`).toBe(expected?.path);
        }
      }
    });
  }
});
