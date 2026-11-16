// npm run test:interop: start (or reuse) a netopeer2 container and run the
// differential tests in test/interop against it (design §15.2). Not part of
// `check`: it needs Docker.
//
//   NETOPEER2_NAME  container name   (default nn-netopeer2-server)
//   NETOPEER2_PORT  SSH port         (default 18310)
//   NETOPEER2_KEEP=1  leave the container running afterwards

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// netopeer2.sh (and the TLS fixtures its endpoint trusts) belong to the
// @node-net/netconf checkout beside this one: git clone
// https://github.com/node-net-org/netconf next to this repository.
const root = fileURLToPath(new URL('../../netconf/', import.meta.url));
if (!existsSync(`${root}scripts/netopeer2.sh`)) {
  console.error(`test:interop needs the @node-net/netconf checkout beside this one, at ${root}`);
  process.exit(1);
}
const env = { ...process.env, NETOPEER2_NAME: process.env.NETOPEER2_NAME ?? 'nn-netopeer2-server', NETOPEER2_PORT: process.env.NETOPEER2_PORT ?? '18310' };
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { stdio: 'inherit', env, ...options }).status ?? 1;

const running = spawnSync('docker', ['ps', '-q', '-f', `name=^${env.NETOPEER2_NAME}$`], { encoding: 'utf8' }).stdout.trim() !== '';
if (!running && run(`${root}scripts/netopeer2.sh`, ['start']) !== 0) process.exit(1);
const status = run('npx', ['vitest', 'run', '--config', 'vitest.interop.config.ts'], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
if (!running && env.NETOPEER2_KEEP !== '1') run(`${root}scripts/netopeer2.sh`, ['stop']);
process.exit(status);
