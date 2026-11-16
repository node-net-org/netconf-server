/**
 * Checks what `npm pack` would publish (PKG-03): the compiled library, the
 * nncd bin, the schemas, the YANG modules, the device definitions, the
 * README and the LICENSE, and nothing else (no sources, tests, scripts or
 * build-info files). Run after `npm run build`.
 */
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts=false'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
// npm prints the prepack/postpack script lines before the JSON on some versions.
const files = JSON.parse(out.slice(out.indexOf('['))).flatMap((p) => p.files.map((f) => f.path));

const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'bin/nncd.js',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/core.js',
  'dist/node/nncd.js',
  'schemas/device.schema.json',
  'schemas/server.schema.json',
];
const allowed = [/^(package\.json|README\.md|LICENSE)$/, /^bin\/nncd\.js$/, /^dist\//, /^schemas\/[\w-]+\.schema\.json$/, /^modules\//, /^devices\//];
const forbidden = [/\.test\.(js|d\.ts)$/, /\.tsbuildinfo$/, /(^|\/)node_modules\//];

const missing = required.filter((f) => !files.includes(f));
const unexpected = files.filter((f) => !allowed.some((re) => re.test(f)) || forbidden.some((re) => re.test(f)));
if (!files.some((f) => f.startsWith('devices/') && f.endsWith('/device.json'))) missing.push('devices/*/device.json');
if (!files.some((f) => f.startsWith('modules/') && f.endsWith('.yang'))) missing.push('modules/*.yang');

if (missing.length > 0 || unexpected.length > 0) {
  for (const f of missing) console.error(`missing    ${f}`);
  for (const f of unexpected) console.error(`unexpected ${f}`);
  process.exit(1);
}
console.log(`ok   npm pack: ${files.length} files`);
