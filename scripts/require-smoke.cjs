/**
 * CommonJS smoke test (PKG-03): every JavaScript entry point must load with
 * require() on Node 22.12 or later (require(esm)). This fails with
 * ERR_REQUIRE_ASYNC_MODULE if any module in the graph uses top-level await.
 * Run after `npm run build`.
 */
'use strict';
const path = require('node:path');
const pkg = require('../package.json');

let failed = 0;
for (const [subpath, target] of Object.entries(pkg.exports)) {
  // Data files (schemas, device definitions) aren't modules.
  if (subpath === './package.json' || subpath.endsWith('.json') || subpath.includes('*')) continue;
  const specifier = path.posix.join(pkg.name, subpath);
  try {
    const mod = require(specifier);
    const names = Object.keys(mod);
    if (names.length === 0) throw new Error('no exports');
    console.log(`ok   ${specifier} (${names.length} exports)`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${specifier} -> ${JSON.stringify(target)}: ${err.code ?? ''} ${err.message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
