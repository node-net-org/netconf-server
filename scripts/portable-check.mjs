// @node-net/netconf-server/core must run in any JavaScript runtime (PKG-02). After
// a build, this:
//
// 1. bundles it for the browser platform with no aliases or externals, and
//    fails on any import that can't be resolved or loaded there (a Node
//    built-in, ssh2's native code);
// 2. runs the bundle in a context with only web-platform globals (no Buffer,
//    process or require), creates a server from a device definition object,
//    connects @node-net/netconf's client to it over the in-process transport, and
//    edits the candidate and commits it (the memory store, no filesystem).
//
//   npm run build && node scripts/portable-check.mjs

import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const entry = fileURLToPath(new URL('./portable-smoke.mjs', import.meta.url));

const problems = [];
let output;
try {
  const bundle = await rolldown({
    input: entry,
    platform: 'browser',
    onLog(level, log) {
      // An import that can't be resolved for the browser is left external with a warning: that is a failure here.
      if (level === 'warn' || log.code === 'UNRESOLVED_IMPORT') problems.push(`${log.code ?? level}: ${log.message}`);
    },
  });
  ({ output } = await bundle.generate({ format: 'iife' }));
  await bundle.close();
} catch (err) {
  problems.push(`bundle failed: ${err.message}`);
}
if (problems.length > 0) fail('@node-net/netconf-server/core does not bundle for the browser', problems);

const code = output[0].code;
const leftovers = [...code.matchAll(/(?:require\(|from\s*)["'](node:[\w/]+|ssh2)["']/g)].map((m) => m[1]);
if (leftovers.length > 0) fail('the browser bundle still imports Node modules', leftovers);

// Web-platform globals only. The JavaScript built-ins (Promise, Map, Uint8Array, …) come with the context itself.
const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  AbortController,
  AbortSignal,
  Event,
  EventTarget,
  DOMException,
  performance,
  atob,
  btoa,
});
vm.runInContext(code, context, { filename: 'portable-bundle.js' });
for (const name of ['Buffer', 'process', 'require']) {
  if (vm.runInContext(`typeof ${name}`, context) !== 'undefined') fail(`the check context has ${name}`, []);
}

let result;
try {
  result = await vm.runInContext('portableSmoke()', context);
} catch (err) {
  fail('the smoke run failed without Node globals', [err.stack ?? String(err)]);
}
const expect = (ok, what) => {
  if (!ok) fail(`smoke: ${what}`, [JSON.stringify(result)]);
};
expect(result.capabilities >= 8, 'the server hello was read');
expect(result.version === '1.1', 'base:1.1 was negotiated (chunked framing)');
expect(typeof result.getConfig === 'string' && result.getConfig.includes('hello from the browser'), 'get-config returned the initial data');
expect(typeof result.committed === 'string' && result.committed.includes('committed in the browser'), 'an edit-config to the candidate and a commit reached running');
expect(result.subscribed === 'ok', 'create-subscription was answered ok');
expect(result.notifications.includes('netconf-config-change'), 'the commit sent netconf-config-change to the subscribed session');
expect(result.control === 'browser', 'the control module took a snapshot over NETCONF');
expect(typeof result.state === 'string' && result.state.includes('42') && result.hooks.reads === 1, 'a provider read hook supplied the state a get read');
expect(result.hooks.prepared.includes('/smoke:settings/greeting') && result.hooks.commits >= 2, 'a provider prepared and committed the start-up push and the commit');
expect(result.unsupported === 'operation-not-supported', 'an operation the device lacks got operation-not-supported');
expect(result.started === 2, 'two sessions started');
expect(result.open === 0, 'kill-session, close and server.close() left no session open');

const kib = (Buffer.byteLength(code) / 1024).toFixed(0);
console.log(`portable:check ok: @node-net/netconf-server/core bundles for the browser (${kib} KiB unminified) and runs without Node globals`);

function fail(message, details) {
  console.error(`portable:check: ${message}`);
  for (const d of details) console.error(`  ${d}`);
  process.exit(1);
}
