// What portable:check runs, bundled for the browser platform, in a context
// with only web-platform globals (scripts/portable-check.mjs). It imports
// the Node-free entries only: @node-net/netconf-server/core and @node-net/netconf/core.

import { connect } from '@node-net/netconf/core';
import { createServer, loadDevice } from '../dist/core.js';

// A device with its own module and initial data, all in memory: no filesystem.
const MODULE = `module smoke {
  yang-version 1.1;
  namespace "urn:example:smoke";
  prefix s;
  container settings { leaf greeting { type string; } leaf count { type uint8; default 3; } }
  container status { config false; leaf uptime { type uint32; } }
}`;
const FILES = { 'running.json': JSON.stringify({ 'smoke:settings': { greeting: 'hello from the browser' } }) };

globalThis.portableSmoke = async () => {
  const device = await loadDevice(
    { id: 'portable', yang: { modules: ['smoke'] }, capabilities: { candidate: true, notification: true, interleave: true }, data: { running: 'running.json' } },
    {
      source: { load: (name) => Promise.resolve(name === 'smoke' ? { text: MODULE } : undefined) },
      readData: (path) => Promise.resolve(FILES[path]),
    },
  );
  const server = await createServer({ device });
  // Providers: a read hook for the state, and a two-phase apply for the settings.
  const hooks = { reads: 0, prepared: [], commits: 0 };
  await server.provide('/smoke:status', {
    onRead: () => {
      hooks.reads++;
      return { 'smoke:status': { uptime: 42 } };
    },
  });
  await server.provide('/smoke:settings', {
    prepare: (changes) => {
      hooks.prepared.push(...changes.map((c) => c.path));
      return { commit: () => void hooks.commits++ };
    },
  });
  const started = [];
  server.on('sessionStart', (e) => started.push(e.sessionId));

  const a = await connect({ transport: server.transport() });
  const b = await connect({ transport: server.transport() });
  const capabilities = a.session.serverCapabilities.size;
  const version = a.session.baseVersion;
  let getConfig;
  try {
    getConfig = (await a.ops.getConfig()).toString();
  } catch (err) {
    getConfig = `failed: ${err.tag ?? String(err)}`;
  }
  // A write through the candidate: edit-config, then commit, then read running back (the memory store needs no filesystem).
  const NC = 'urn:ietf:params:xml:ns:netconf:base:1.0';
  // Subscribed first (RFC 5277), so the commit sends a netconf-config-change.
  const notifications = [];
  a.session.onNotification((n) => notifications.push(n.event?.name));
  let subscribed;
  try {
    await a.session.rpc(`<create-subscription xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"/>`);
    subscribed = 'ok';
  } catch (err) {
    subscribed = `failed: ${err.tag ?? String(err)}`;
  }
  let committed;
  try {
    await a.session.rpc(`<edit-config xmlns="${NC}"><target><candidate/></target><config><settings xmlns="urn:example:smoke"><greeting>committed in the browser</greeting></settings></config></edit-config>`);
    await a.session.rpc(`<commit xmlns="${NC}"/>`);
    committed = (await a.ops.getConfig()).toString();
  } catch (err) {
    committed = `failed: ${err.tag ?? String(err)}`;
  }
  // A <get> of the state runs the read hook.
  let state;
  try {
    state = (await a.session.rpc(`<get xmlns="${NC}"><filter><status xmlns="urn:example:smoke"/></filter></get>`)).element.toString();
  } catch (err) {
    state = `failed: ${err.tag ?? String(err)}`;
  }
  // The control module (on by default: createServer() was given no providers) takes a snapshot.
  let control;
  try {
    await a.session.rpc(`<snapshot xmlns="urn:node-net:yang:net-netconf-server-control"><name>browser</name></snapshot>`);
    control = server.control.snapshots().join(',');
  } catch (err) {
    control = `failed: ${err.tag ?? String(err)}`;
  }
  // cancel-commit is a standard operation behind :confirmed-commit, which this device lacks.
  let unsupported = 'answered';
  try {
    await a.session.rpc(`<cancel-commit xmlns="${NC}"/>`);
  } catch (err) {
    unsupported = err.tag ?? String(err);
  }
  await a.ops.killSession(b.session.sessionId);
  await a.close();
  await server.close();

  return { capabilities, version, getConfig, subscribed, committed, notifications, state, hooks, control, unsupported, started: started.length, open: server.sessions.length };
};
