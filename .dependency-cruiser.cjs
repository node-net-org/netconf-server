/**
 * Dependency rules for @node-net/netconf-server (design §2): the core is
 * browser-safe, and @node-net/netconf and @node-net/yang are used only through their
 * package exports, their Node-free entries in the core.
 */

/**
 * The modules only the Node entry reaches. Everything else in src is
 * @node-net/netconf-server/core and runs in any JavaScript runtime. Kept in step
 * with eslint.config.js.
 */
const NODE_ONLY = ['^src/index\\.ts$', '^src/device/file\\.ts$', '^src/store/file\\.ts$', '^src/node/'];

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'portable-core-no-node-builtins',
      comment: '@node-net/netconf-server/core runs in any JavaScript runtime, so portable modules import no Node built-in (src/core.ts).',
      severity: 'error',
      from: { path: '^src/', pathNot: NODE_ONLY },
      to: { dependencyTypes: ['core'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'portable-core-no-node-only-modules',
      comment: 'Portable modules never load the Node-only ones (types are fine: they cost nothing at run time).',
      severity: 'error',
      from: { path: '^src/', pathNot: NODE_ONLY },
      to: { path: NODE_ONLY, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'portable-core-uses-node-free-entries',
      comment: 'Portable modules use @node-net/netconf/core and @node-net/yang/core, never the Node entries of either, nor ssh2.',
      severity: 'error',
      from: { path: '^src/', pathNot: NODE_ONLY },
      to: {
        path: ['(^|/)node_modules/ssh2/', '(^|/)@node-net/yang/dist/index\\.js$', '(^|/)@node-net/netconf/dist/index\\.js$'],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'only-package-exports',
      comment: '@node-net/netconf and @node-net/yang are imported through their package exports, never their sources or other dist files.',
      severity: 'error',
      from: { path: '^src/' },
      to: {
        path: '(^|/)(@node-net/netconf|@node-net/yang)/(src/|dist/)',
        pathNot: '(^|/)(@node-net/netconf|@node-net/yang)/dist/(index|core)\\.(js|d\\.ts)$',
      },
    },
    {
      name: 'src-does-not-import-tests',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-runtime-deps',
      comment: 'Runtime code may only use node builtins and declared dependencies.',
      severity: 'error',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev', 'npm-no-pkg', 'npm-unknown', 'undetermined'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // @node-net/netconf and @node-net/yang may be workspace links: keep their node_modules paths, so they count as the declared dependencies they are.
    preserveSymlinks: true,
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js'],
    },
  },
};
