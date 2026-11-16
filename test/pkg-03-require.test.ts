// PKG-03: load the package from CommonJS with require().
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PKG_DIR } from './ssh-helpers.js';

/** Each await (or for await) in a file that isn't inside a function. */
function topLevelAwaits(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined)) {
      found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

describe('PKG-03 require()', { timeout: 60_000 }, () => {
  it("require('@node-net/netconf-server') works on Node 22.12 or later, checked by the smoke test npm run check runs", async () => {
    const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8')) as { engines: { node: string }; scripts: Record<string, string> };
    expect(pkg.engines.node).toBe('>=22.12');
    expect(pkg.scripts['check']).toContain('npm run smoke:require');
    const out = execFileSync(process.execPath, ['scripts/require-smoke.cjs'], { cwd: PKG_DIR, encoding: 'utf8' });
    expect(out).toContain('ok   @node-net/netconf-server (');
    expect(out).toContain('ok   @node-net/netconf-server/core (');
    // And from a CommonJS program, the SSH listener is there.
    const names = execFileSync(process.execPath, ['-e', "const s = require('@node-net/netconf-server'); console.log(typeof s.createServer, typeof s.sshListener)"], { cwd: PKG_DIR, encoding: 'utf8' });
    expect(names.trim()).toBe('function function');
  });

  it('uses no top-level await in any module', async () => {
    // The check finds one when there is one.
    expect(topLevelAwaits('x.ts', 'const a = await f();\nasync function g() { await h(); }')).toEqual(['x.ts:1']);
    for (const file of [...(await sources(join(PKG_DIR, 'src'))), join(PKG_DIR, 'bin/nncd.js')]) {
      expect(topLevelAwaits(file, await readFile(file, 'utf8'))).toEqual([]);
    }
  });

  it('publishes only the built files, the schemas and the documentation, checked by a pack test', async () => {
    const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check']).toContain('npm run pack:check');
    const out = execFileSync(process.execPath, ['scripts/pack-check.cjs'], { cwd: PKG_DIR, encoding: 'utf8' });
    expect(out).toMatch(/^ok {3}npm pack: \d+ files/);
  });
});
