#!/usr/bin/env node
// nncd: run a NETCONF server from a deployment config (see the README).
import { main } from '../dist/node/nncd.js';

// Exit with the status once output has drained; if anything still holds the
// process open a moment later (a client that won't hang up), exit anyway.
const finish = (code) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
};

main(process.argv.slice(2)).then(finish, (err) => {
  process.stderr.write(`nncd: ${err?.stack ?? err}\n`);
  finish(1);
});
