#!/usr/bin/env node
/**
 * The NACM read benchmark (NACM design §11 item 4): a read of about 100k
 * configuration nodes, timed end to end over an in-process session, with
 * access control off, with an empty policy, and with a typical policy (reads
 * permitted, two denied subtrees, one keyed rule). The targets: no overhead
 * with the empty policy, and under 15% with the typical one.
 *
 * Runs against dist/: `npm run build`, then `node scripts/nacm-read-bench.mjs`.
 * It prints the medians and exits non-zero when a target is missed.
 */

import { connectionPair } from '@node-net/netconf/core';
import { memorySource } from '@node-net/yang';
import { createServer } from '../dist/index.js';

const ENTRIES = 25_000; // each entry and its three leaves: 100k nodes
const WARMUP = 5;
const RUNS = Number(process.env.RUNS ?? 25);

const BENCH = `module bench {
  yang-version 1.1;
  namespace "urn:example:bench";
  prefix b;
  container system {
    leaf hostname { type string; }
    container secrets { leaf token { type string; } }
  }
  container snmp { leaf community { type string; } }
  container interfaces {
    list interface {
      key name;
      leaf name { type string; }
      leaf enabled { type boolean; }
      leaf description { type string; }
    }
  }
}`;

const DATA = {
  'bench:system': { hostname: 'r1', secrets: { token: 'x' } },
  'bench:snmp': { community: 'public' },
  'bench:interfaces': { interface: Array.from({ length: ENTRIES }, (_, i) => ({ name: `if${i}`, enabled: i % 2 === 0, description: `port ${i}` })) },
};

const TYPICAL = {
  'ietf-netconf-acm:nacm': {
    groups: { group: [{ name: 'ops', 'user-name': ['alice'] }] },
    'rule-list': [
      {
        name: 'ops',
        group: ['ops'],
        rule: [
          { name: 'no-secrets', path: '/bench:system/secrets', 'access-operations': 'read', action: 'deny' },
          { name: 'no-snmp', path: '/bench:snmp', 'access-operations': 'read', action: 'deny' },
          { name: 'no-if7', path: "/bench:interfaces/interface[name='if7']", 'access-operations': 'read', action: 'deny' },
        ],
      },
    ],
  },
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EOM = ']]>]]>';

/** `enforce` false is the baseline: the same device without ietf-netconf-acm, which never checks access. */
async function scenario(enforce, policy) {
  const srv = await createServer({
    device: { id: 'bench', yang: { modules: enforce ? ['bench', 'ietf-netconf-acm'] : ['bench'] } },
    source: memorySource([{ text: BENCH }]),
    control: { enabled: false },
  });
  await srv.running.applyExternal(DATA, { source: 'bench' });
  if (policy !== undefined) await srv.running.applyExternal(policy, { source: 'bench' });
  const [client, serverEnd] = connectionPair();
  srv.serve(serverEnd, { principal: { username: 'alice' }, transport: 'bench' });
  let buffer = '';
  let waiting;
  client.receive({
    data: (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      const end = buffer.indexOf(EOM);
      if (end !== -1 && waiting !== undefined) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + EOM.length);
        const w = waiting;
        waiting = undefined;
        w(text);
      }
    },
    end: () => undefined,
    close: () => undefined,
  });
  const next = () => new Promise((resolve) => (waiting = resolve));
  let reply = next();
  client.write(encoder.encode(`<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities></hello>${EOM}`));
  await reply;
  let id = 0;
  const read = async (op) => {
    reply = next();
    const start = performance.now();
    client.write(encoder.encode(`<rpc xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${++id}">${op}</rpc>${EOM}`));
    const text = await reply;
    return { ms: performance.now() - start, bytes: text.length };
  };
  return { srv, read };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const OPS = { 'get-config': '<get-config><source><running/></source></get-config>', get: '<get/>' };
const SCENARIOS = [
  ['off', false, undefined],
  ['empty policy', true, undefined],
  ['typical policy', true, TYPICAL],
];

const servers = [];
for (const [name, enforce, policy] of SCENARIOS) servers.push({ name, ...(await scenario(enforce, policy)) });

const results = {};
for (const [op, body] of Object.entries(OPS)) {
  const times = Object.fromEntries(servers.map((s) => [s.name, []]));
  const sizes = {};
  for (let i = 0; i < WARMUP; i++) for (const s of servers) await s.read(body);
  // Interleaved, so drift in the machine's load hits every scenario alike.
  for (let i = 0; i < RUNS; i++) {
    for (const s of servers) {
      const r = await s.read(body);
      times[s.name].push(r.ms);
      sizes[s.name] = r.bytes;
    }
  }
  results[op] = Object.fromEntries(servers.map((s) => [s.name, { median: median(times[s.name]), bytes: sizes[s.name] }]));
}
for (const s of servers) await s.srv.close();

let failed = false;
for (const [op, r] of Object.entries(results)) {
  const base = r['off'].median;
  console.log(`${op} (${RUNS} runs, medians):`);
  for (const [name, { median: m, bytes }] of Object.entries(r)) {
    const overhead = ((m - base) / base) * 100;
    console.log(`  ${name.padEnd(15)} ${m.toFixed(1).padStart(8)} ms  ${String(bytes).padStart(9)} bytes  ${name === 'off' ? '' : `${overhead >= 0 ? '+' : ''}${overhead.toFixed(1)}%`}`);
  }
  // "None" with an empty policy, allowing for timing noise; the typical policy under 15%.
  if ((r['empty policy'].median - base) / base > 0.05) failed = true;
  if ((r['typical policy'].median - base) / base > 0.15) failed = true;
}
if (failed) {
  console.log('A target was missed: empty policy within 5% (noise), typical policy under 15%.');
  process.exitCode = 1;
}
