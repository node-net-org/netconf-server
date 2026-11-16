# @node-net/netconf-server

A NETCONF server framework for Node.js and the browser, written in TypeScript and built on [@node-net/netconf](https://github.com/node-net-org/netconf) and [@node-net/yang](https://github.com/node-net-org/yang). A device is data: its YANG modules, capabilities, initial data and quirks.

> **Status: 0.1.0, prepared for its first publish.** Milestones M0 to M5 are in place: sessions, the in-process transport, device loading with initial data, the NMDA datastores and reads, the writes and saving configuration across restarts, providers, notifications and the control module, and now `nncd` with NETCONF over SSH. The lab defect server's migration and the full interop suite follow (see the roadmap in [docs/net-netconf-server-design.md](./docs/net-netconf-server-design.md) §16).

```ts
import { connect } from '@node-net/netconf';
import { createServer } from '@node-net/netconf-server';

const server = await createServer({
  device: { id: 'example', yang: { modules: [] }, capabilities: { candidate: true } },
});
server.on('sessionStart', (e) => console.log(`session ${e.sessionId} for ${e.username}`));

const client = await connect({ transport: server.transport() });
console.log(client.session.serverCapabilities.toArray());
await client.close();
await server.close();
```

## Entries

- `@node-net/netconf-server`: everything, including `loadDeviceFile()` for device definitions on disk, `fileStore()` for a state directory, the SSH listener (`sshListener()`, `loadHostKeys()`, `staticUsers()`, `hashPassword()`) and the TLS listener (`tlsListener()`, `certToName()`).
- `@node-net/netconf-server/core`: the same without anything from Node.js, for browsers and workers. Devices are given as objects, and modules as a @node-net/yang `ModuleSource`.

## Device definitions

A device definition is a JSON file checked by [schemas/device.schema.json](./schemas/device.schema.json) (point `$schema` at it for editor help), or the same object in code:

```json
{
  "$schema": "../node_modules/net-netconf-server/schemas/device.schema.json",
  "id": "my-router",
  "emulates": "sysrepo-netopeer2",
  "yang": {
    "directories": ["yang"],
    "modules": ["ietf-interfaces", "ietf-ip"],
    "features": { "ietf-interfaces": ["if-mib"] },
    "deviations": ["my-router-deviations"]
  },
  "capabilities": { "candidate": true, "confirmedCommit": true, "startup": true },
  "data": { "running": "data/running.xml", "operational": "data/state.json" }
}
```

The NETCONF base modules the server needs (ietf-netconf, the YANG library, NMDA, monitoring, with-defaults, and the notification modules when notifications are on) are added automatically. Paths are relative to the file. An invalid definition, or modules that don't compile, throw a `DeviceError` listing every problem with its location.

## Initial data and reads

`data` names the files the device starts with: `running`, `startup` (with the `:startup` capability) and `operational`, each XML or RFC 7951 JSON by its extension. They are validated against the device's schema when it loads, and invalid data stops the load with every violation and its line and column. Without `startup`, the startup datastore starts as a copy of running. The operational file holds state data (and system configuration, marked with `or:origin`); reads merge it with running's configuration. In code, pass a `readData` option to `loadDevice()` to supply the files from memory:

```ts
const device = await loadDevice(
  { id: 'demo', yang: { modules: ['demo'] }, data: { running: 'running.json' } },
  { source: memorySource([{ text: demoYang }]), readData: (path) => Promise.resolve(files[path]) },
);
```

The server answers `<get-config>`, `<get>` and `<get-data>` (RFC 8526) on running, candidate, startup, intended (running, for now) and operational, with subtree filters, XPath filters when the device has `:xpath`, with-defaults, and get-data's `config-filter`, `max-depth`, `with-origin` and origin filters. `<operational>` carries the YANG library (RFC 8525, and RFC 7895's `modules-state` when the definition sets `yangLibrary.modulesState`) and NETCONF monitoring (RFC 6022); `<get-schema>` returns each module's source as YANG or YIN.

## Writes

The server answers `<edit-config>` and `<edit-data>` (RFC 8526) with every operation, `default-operation` and `yang:insert`, and `<edit-config>`'s `error-option` (`rollback-on-error` with `:rollback-on-error`) and `test-option` (with `:validate`). Writing running needs `:writable-running`, and the candidate needs `:candidate`. Nothing that breaks the schema enters running: every edit to it is validated, whatever the test-option. The candidate is validated under `test-then-set` (the default) and left for `<commit>` or `<validate>` under `set`. A violation is answered with the error-tag of RFC 6241 Appendix A and the error-app-tag of RFC 7950 §15, one `<rpc-error>` for each, with `error-path` naming the node.

It also has `<validate>`, `<lock>` and `<unlock>` on running, candidate and startup, and `<commit>` and `<discard-changes>`. With `:confirmed-commit`, it has confirm-timeout, persist and persist-id, and `<cancel-commit>`. A confirmed commit that isn't confirmed is rolled back when its timer (on the server's clock) runs out, or when its session ends if it has no persist. `<copy-config>` and `<delete-config>` work on the configuration datastores, and on startup with `:startup`. Writes from every session are applied one at a time, in arrival order, and a read always sees the configuration either before or after a write, never part-way through.

Embedding code sees the locks and the changes:

```ts
server.on('lockChanged', (e) => console.log(`${e.datastore} ${e.sessionId === undefined ? 'unlocked' : `locked by ${e.sessionId}`}`));
server.on('commit', (e) => console.log(`running changed: ${e.cause} by ${e.username ?? e.source}`));
console.log(server.locks.get('running')); // { sessionId, username, lockedAt }
```

## Saving configuration

A store keeps the datastore that RFC 6241 says survives a restart: startup with `:startup`, otherwise running (the candidate is never saved). The default is `memoryStore()`, which starts from the device's initial data each time; pass the same one to a new server to simulate a restart. In Node, `fileStore(dir)` writes one RFC 7951 JSON file per datastore in `dir`, atomically:

```ts
import { createServer, fileStore, loadDeviceFile } from '@node-net/netconf-server';

const server = await createServer({ device: await loadDeviceFile('device.json'), store: fileStore('./state') });
```

A saved datastore wins over the device's initial data, and with `:startup` the server boots running from it. Saved data is validated at start-up: if it can't be parsed or breaks the schema, `createServer()` throws a `DeviceError` naming the file and every violation. A state directory that can't be written throws a `StoreError`. The `startup: 'push' | 'adopt'` option chooses how saved configuration meets providers (see below).

## Providers

A provider adds behaviour to one subtree of the schema; the server still holds every node, validates every change and runs the protocol. Every member is optional, and data no provider claims is simply stored, which is all a simulator needs.

```ts
const server = await createServer({
  device,
  providers: [{
    path: '/ex:interfaces/interface',
    provider: {
      // Refresh state before a <get> or <get-data> that selects it.
      onRead: async () => ({ 'ex:interfaces': { interface: await backend.status() } }),
      maxAge: 1000,
      // Check and stage the validated changes; throw to refuse.
      prepare: async (changes) => {
        const staged = await backend.stage(changes);
        return { commit: () => staged.apply(), abort: () => staged.drop() };
      },
      // Actions in the subtree, by schema path.
      actions: { '/ex:interfaces/interface/reset': ({ path }) => backend.reset(path) },
    },
  }],
});
```

- **Registration.** `createServer({ providers })` registers providers before the server starts, and `server.provide(path, provider)` registers more later; both resolve once the provider is in step with running. The deepest registration owns a node. A path that isn't in the schema, a path already registered, `adopt` without `load`, a cycle in `after`, or an RPC or action outside the subtree is rejected. `handle.unregister()` makes the subtree unclaimed again.
- **Reads.** `onRead` runs before `<get>` and `<get-data>` of operational, only for the providers whose subtree the filter selects, all at once; never for `<get-config>`. Concurrent reads share one run, and `maxAge` answers from the last data for a while. The hook returns its subtree's new state, or pushes updates itself with `server.operational.update(edit)`, which emits `stateChanged`. State is validated. Configuration may appear in it only as structure (containers, list entries and their keys), or with an `or:origin` of `system` or `learned`.
- **Writes.** A change to running (an edit, a commit, copy-config, a confirmed commit rolled back) is diffed and split by provider. The providers involved `prepare` concurrently; a refusal aborts those that prepared, and the client gets its rpc-errors. Then each commits, in registration order or after the providers named in `after`. If a commit fails, the providers that committed are given the inverse changes, in reverse order, and running stays as it was. If that fails too, the subtree is marked out of sync: the `outOfSync` event, `handle.outOfSync`, and `net-netconf-server-monitoring:providers` in `<operational>`. The provider clears it with `handle.clearOutOfSync()`. Edits to the candidate and `<validate>` never call providers.
- **Changes from outside NETCONF.** `server.running.applyExternal(edit, { source })` applies a change the backend made by another route. It is validated and applied whole, after any write in progress, whatever the locks. It calls no provider hooks. A candidate edited before it is committed against the new running.
- **Unclaimed configuration.** `unclaimed: 'reject'` refuses changes to running that no provider claims with operation-not-supported. Edits to the candidate are still accepted, and the commit is refused.
- **Timeouts.** Every hook has a timeout on the server's clock (`providerTimeouts`, or the provider's `timeouts`). Read and prepare default to 10 s, commit to 30 s and load to 60 s. A late read hook serves the last data with a warning (`onReadTimeout: 'stale'`, the default) or fails the read (`'error'`). A late prepare aborts the transaction. A late commit counts as a failed commit.
- **Start-up.** Under `push` (the default), each provider's saved configuration goes through `prepare` and `commit` before the server accepts sessions, and a refusal stops it starting. Under `adopt`, the provider's `load()` replaces the saved copy of its subtree and is not pushed back. Under `adopt`, a provider's `commit` must make changes permanent on the backend for them to survive a restart. The combined configuration is validated, and each violation names the provider, the saved file or the device definition it came from.
- **RPCs and actions.** `rpcs` (by `module:name`, in the subtree's module) and `actions` (by schema path, in the subtree) get validated input as RFC 7951 JSON, and an action gets its instance's `path`. An action on a node that doesn't exist gets data-missing. A handler returns the output parameters, or nothing for `<ok/>`; the output is validated. Throw an `RpcFailure` for specific rpc-errors; anything else thrown gives operation-failed with its message.

## Notifications

A device with `:notification` (and `:interleave`, for RPCs on a subscribed session) takes RFC 5277 `<create-subscription>` on the `NETCONF` stream. The server sends the RFC 6470 base notifications itself, and providers or embedding code send the device's own:

```ts
// A top-level notification, by its schema path, with RFC 7951 content.
server.notify('/ex:alarm', { severity: 'major', text: 'fan failed' });

// A YANG 1.1 notification nested in data: the path of its instance.
server.notify("/ex:interfaces/interface[name='eth0']/link-down", {});
```

- **Subscriptions.** One per session, on the `NETCONF` stream, with an optional subtree or XPath filter; a second gets in-use. Replay isn't supported: `startTime` gets operation-not-supported, and `stopTime`, which RFC 5277 allows only with `startTime`, gets missing-element. `netconf/streams` lists the stream.
- **Order.** A notification is never written inside a reply: one raised while a session's request is answered goes out after that reply. One caller's notifications reach each subscriber in the order they were sent. Without `:interleave`, a subscribed session can only close.
- **Base notifications.** `<netconf-config-change>` for every change to running, with the session or `server` as changed-by (a change from outside NETCONF, a rollback after a confirm timeout, a reset) and one edit per change. `<netconf-session-start>` and `<netconf-session-end>`, with the end reason and killed-by. `<netconf-confirmed-commit>` for start, extend, complete, cancel and timeout.
- **Validation.** `server.notify()` decodes the content with @node-net/yang and validates it against the schema and the current `<operational>` data, so a nested notification's instance must exist. Invalid content throws a `YangDataError` and nothing is sent. NETCONF monitoring counts `out-notifications` per session and in total.

## Control module

Tests and tutorials change a running server through `net-netconf-server-control`, a YANG module served over NETCONF, or the same operations in process on `server.control`:

```ts
const server = await createServer({
  device,
  control: { users: ['admin'] },
});
// Undefined when the deployment doesn't enable the control module.
const control = server.control!;
await control.reset();
control.injectFault({
  target: { kind: 'user', username: 'tester' },
  trigger: { kind: 'operation', name: 'get-config' },
  action: { kind: 'delay', ms: 5000 },
});
control.setQuirk('replyWithoutMessageId', true);
```

- **Enabling it.** It is on by default when `createServer()` is given no providers, and off when it is given any; `control.enabled` says otherwise. Off, the module is absent from the schema, the YANG library and `<get-schema>`, and its RPCs get unknown-namespace. It is an ordinary provider on `/net-netconf-server-control:control`, whose state lists faults, run-time quirk changes and snapshots.
- **Control users.** With `control.users`, only those users may use it (others get access-denied), and their sessions are exempt from every quirk and fault, so a server whose quirks break framing can still be controlled. Without a list anyone may use it, and a session becomes exempt with its first control RPC.
- **Operations.** `reset` puts every datastore back to the device's initial data and clears locks, a pending confirmed commit, faults, run-time quirks and snapshots, optionally ending the other sessions. `inject-fault` makes a session (by id, by user, or the next to open) reply with rpc-errors, send no reply, reply late on the server's clock, drop the connection, send no hello, send unsolicited messages, or send raw bytes, on its next RPC, the next of a named operation, or at once, once or `count` times. `set-quirk` switches a quirk for new sessions or one session. `send-notification`, `set-state` (state data only) and `snapshot` and `restore` (no providers called; a config change is reported) do what they say.

## Access control (NACM)

The policy is the device's own `ietf-netconf-acm` configuration (RFC 8341), edited over NETCONF like any other data. A device that doesn't implement the module has no access control. The design is in [docs/nacm-design.md](./docs/nacm-design.md).

```ts
const server = await createServer({
  device,
  // Recovery sessions bypass NACM, to write the first policy or repair a broken one.
  nacm: { recovery: (principal) => principal.username === 'root' },
});
server.on('accessDenied', (e) => console.log('denied', e.username, e.operation));
```

- **Recovery.** `nacm.recovery` is asked once, when a session starts. No session is a recovery session by default, in-process ones included. Monitoring shows which sessions are, in a `recovery` leaf on each session (`net-netconf-server-monitoring`).
- **What is checked.** Each operation is checked as RFC 8341 §3.4.4 says. A refusal is `access-denied`, with an error-path such as `/nc:rpc/nc:delete-config`. `close-session` is always permitted. `kill-session`, `delete-config` and every control-module operation need a rule that permits them.
- **Reads.** `<get>`, `<get-config>`, `<get-data>` and `<copy-config>`'s source leave out what the user may not read, silently, as RFC 8341 §3.2.4 says. Filters and `with-defaults` see only readable data. `/nacm` is hidden unless a rule permits reading it. A provider's read hook isn't run for a user who may read none of its subtree. A policy that restricts little costs little: in the 100k-node benchmark (`scripts/nacm-read-bench.mjs`), a typical policy adds 5–7%.
- **Errors.** An rpc-error whose error-path names a node the user may not read has its path cut back to a readable ancestor, a generic error-message, and no error-info naming the node. The error-tag and error-app-tag stay.
- **Writes.** A write is checked on what it changes, not on the edit as sent (RFC 8341 §3.2.5–§3.2.8). A node created needs create access, one deleted needs delete, and a changed value or a moved entry needs update. Nodes left as they were need nothing. `<commit>` is checked on what it changes in running, so the committing user needs access to all of it, whoever edited the candidate. `<copy-config>` is checked on what it changes in its target, except from running to startup, which needs only exec access. A refusal is one `access-denied` (error-type application) for the first refused node, it fails the whole operation whatever the `<error-option>`, and nothing reaches a provider. Rolling back a confirmed commit, `<cancel-commit>`, `<discard-changes>` and the server's own changes (`applyExternal`, start-up, `server.control`) aren't checked. One known deviation: changes an edit makes implicitly (a `when` turning false, another `choice` case) are checked like explicit ones, which RFC 8341 doesn't require.
- **Actions.** An `<action>` needs read access to every instance on its path and exec access to the action. A refusal names the deepest instance the user may read.
- **Notifications.** Each notification is checked for each subscription, with the policy in running when it is sent, before the subscription's filter (RFC 8341 §3.4.6). A notification type the user may not receive isn't sent to them. A notification nested in data also needs read access to every instance above it. `<replayComplete>` and `<notificationComplete>` always go. `<netconf-config-change>` goes further than the RFC: the `edit` entries naming data the user may not read are left out, and one left with none isn't sent.
- **Counting.** Every refusal raises `accessDenied` (`kind` operation, write, action or notification), is logged at info, and is counted in `/nacm/denied-operations`, `denied-data-writes` or `denied-notifications` (once per subscription) in `<operational>`.
- **Enforced whenever the device implements the module.** With `enable-nacm` true, its default, access is checked; there is no other switch. A device with the module and no `/nacm` data gets RFC 8341's defaults, so only a recovery session can write. The bundled `sysrepo-netopeer2` device permits everything to its `admin` group, as netopeer2's set-up does for its admin user, and refuses writes by anyone else.
- **Tested against netopeer2.** `npm run test:interop` compares reads, writes and refused operations with netopeer2's, as an admin user and as a user in no group. The known differences are listed with the tests: the operation error-path, and the `<netconf-config-change>` edits this server leaves out.

## Quirks and emulated devices

A device definition lists the misbehaviours of the real device it emulates, each set to `true` or its settings. With none, the server follows the RFCs.

```json
"quirks": {
  "invalidXmlChars": true,
  "paddedEmptyElements": { "indent": 20 },
  "subtreeFilterLimit": { "depth": 2, "message": "Leaf element specified which is not a key" }
}
```

| Quirk | The device… | @node-net/netconf tolerance |
|---|---|---|
| `replyWithoutMessageId` | leaves the message-id off error replies (or all) | `replyWithoutMessageId` |
| `invalidXmlChars` | puts a BEL in error messages | `invalidXmlChars` |
| `paddedEmptyElements` | writes empty elements across two lines | `paddedEmptyElements` |
| `chunkedFramingBroken` | breaks chunked framing, so works only with base:1.0 | `forceBaseVersion` |
| `noPipelining` | refuses a request sent before the last was answered | `maxInFlight` |
| `slowCloseSession` | answers close-session late, or never | `closeTimeout` |
| `subtreeFilterLimit` | refuses deep subtree filters with its own error text | `subtreeFilter`, `subtreeFilterDepth` |
| `candidateUnvalidated` | validates the candidate only at commit (netopeer2) | none |

Quirks act on sessions of the device, never on control sessions, and `set-quirk` changes them at run time; `chunkedFramingBroken` reaches only sessions opened afterwards. A test connects @node-net/netconf with and without each tolerance and fails when a client quirk has no server quirk naming it.

The package ships a device definition for each client profile @node-net/netconf ships, in `devices/` (`@node-net/netconf-server/devices/<id>/device.json`): `nokia-7210-sas`, `nokia-sros-md` and `sysrepo-netopeer2`. Each names the profile it `emulates`, and a test checks that @node-net/netconf's automatic detection picks that profile. The Nokia modules aren't published openly, so those devices use small stand-in modules with only the nodes the profiles read.

It also ships `lab`, the device behind the docs site's terminals: a small switch with ietf-interfaces and ietf-system and a starter OpenConfig set (interfaces, Ethernet, aggregates, VLANs, LACP, LLDP and platform, with ports and transceivers), following the RFCs with the candidate, startup, confirmed commit and notifications. It emulates no client profile. Its modules' sources and licences are in [devices/lab/yang/README.md](./devices/lab/yang/README.md).

## nncd

`nncd` runs a server from a deployment config, with no code:

```sh
npx nncd --config server.json
```

```json
{
  "$schema": "./node_modules/net-netconf-server/schemas/server.schema.json",
  "device": "devices/router.json",
  "stateDir": "state",
  "store": "file",
  "listen": { "ssh": { "port": 830 } },
  "users": [
    { "username": "admin", "passwordHash": "$scrypt$ln=15,r=8,p=1$…$…" },
    { "username": "netconf", "password": "netconf", "lab": true },
    { "username": "ops", "authorizedKeys": ["ssh-ed25519 AAAA… ops@example"] }
  ],
  "providers": [
    { "module": "./providers/interfaces.js", "path": "/ietf-interfaces:interfaces", "options": { "poll": 5 } }
  ],
  "logLevel": "info"
}
```

The config is checked by [schemas/server.schema.json](./schemas/server.schema.json) (exported as `@node-net/netconf-server/schemas/server.schema.json`). Paths in it are relative to the config file. Its properties:

- `device`: the device definition file.
- `stateDir` and `store`: `memory` (the default) or `file`, which saves configuration in `stateDir`.
- `startup` (`push` or `adopt`), `unclaimed` (`store` or `reject`) and `control` (`{ "enabled", "users" }`): as for `createServer()`.
- `listen`: the listeners to run, `ssh`, `tls` or both, and only those. Without it, SSH runs on port 830.
  - `ssh`: `address`, `port` (830 by default) and `hostKeys`, a list of private key files.
  - `tls`: `address`, `port` (6513 by default), `cert` and `key` (the server's certificate and unencrypted private key, PEM), `ca` (trust anchor files) and `certToName` (below).
- `users`: who may log in (below).
- `nacm`: `{ "recoveryUsers": [...] }`, the users whose sessions are NACM recovery sessions, whichever authenticator produced them (see [Access control](#access-control-nacm)). `nncd --check` warns when the device implements `ietf-netconf-acm` and this names no one.
- `providers`: each a `module` (a file starting `.` or `/`, or a package name found from the config's directory), an optional `path` to register it on, an optional `startup` mode and `options`. The module's default export is a factory, called as `factory(options, { logger, configDir })`. It returns the provider, or, when the entry has no `path`, `{ path, provider }` or a list of them.
- `logLevel`: `trace`, `debug`, `info` (the default), `warn`, `error` or `silent`.

**The config is trusted like code.** It names modules for nncd to import, so whoever can edit it can run code as the server. Keep it, and the directories it names, writable only by whoever runs the server.

nncd checks everything before it listens. A config that breaks the schema exits with status 2 and lists each problem by JSON path. Something the config names that can't be used (a missing device file, a bad host key, TLS certificate or user, invalid saved configuration, a provider module that won't import or whose factory throws, a port in use) exits with status 1 and names it. `nncd --check` runs the same checks and exits without listening; it doesn't call provider factories, since they may open real backends, or generate a host key.

`--log-level` (or `-l`) overrides the config's `logLevel`. Logs go to stderr, one line per entry: the time, the level, the message, then `key=value` context such as `sessionId`, `username` and `messageId`. `trace` logs every message received and sent, with password-like elements redacted; passwords and private keys are never logged.

On SIGINT or SIGTERM nncd stops accepting connections, lets a write in progress finish, rolls back a confirmed commit that has no `persist` (as if its session had ended), closes every session and exits with status 0. A second signal exits at once with status 130.

## SSH and users

NETCONF over SSH (RFC 6242) is the `netconf` subsystem, port 830 by default. Shell, exec and other subsystems are refused, and each `netconf` channel is one session. Only password and public-key logins are offered; keyboard-interactive isn't.

**Host keys** come from `listen.ssh.hostKeys`. Without them, an ed25519 key is generated on the first run, saved as `ssh_host_ed25519_key` in `stateDir` (readable only by its owner) and reused after that. With no `stateDir` either, a key is made for the run and a warning says it will change. Each key's SHA-256 fingerprint is logged at start-up.

**Users** each have a `username`, and any of a `passwordHash`, `authorizedKeys` (authorized_keys lines) and `groups`. Make a hash with:

```sh
npx nncd hash-password          # prompts twice, without echo
echo -n 'secret' | npx nncd hash-password
```

It prints `$scrypt$ln=15,r=8,p=1$<salt>$<hash>`. A plain-text `password` is allowed only for a user marked `"lab": true`, such as `netconf`/`netconf` on a lab server, and start-up logs a warning for each. A failed login doesn't say whether the user, the password or the key was wrong, and is logged at info with the username and method only.

**In code**, the same pieces are the library's:

```ts
import { createServer, loadDeviceFile, loadHostKeys, sshListener, staticUsers } from '@node-net/netconf-server';

const server = await createServer({ device: await loadDeviceFile('device.json') });
await server.listen(
  sshListener({
    port: 830,
    hostKeys: await loadHostKeys({ stateDir: './state' }),
    authenticate: staticUsers([{ username: 'admin', passwordHash: '$scrypt$…' }]),
  }),
);
```

`authenticate` is any async function from a login attempt to a principal: `{ method: 'password', username, password }`, `{ method: 'publickey', username, key: { algorithm, data } }` or, over TLS, `{ method: 'certificate', … }` in, `{ username, groups? }` or `undefined` out. Use it for PAM, LDAP, RADIUS or your own system. A public key reaches it only after the listener has checked the client's signature. A hook that throws, or doesn't answer within `authTimeout` (10 s), refuses the attempt and the error is logged. The principal is the session's user in monitoring, locks, `<netconf-config-change>` and logs. `server.close()` closes the listener; `listener.close({ endSessions: true })` also drops its connections.

`server.close()` is a graceful shutdown in code too. It resolves once the write in progress has finished, the sessions have ended and their unpersisted confirmed commits have been rolled back.

## TLS and certificates

NETCONF over TLS (RFC 7589) runs on port 6513 by default, TLS 1.2 or later, with mutual X.509 authentication. Every client must present a certificate that chains to one of the trust anchors in `ca`; Node's public root store is never used. A self-signed client certificate is trusted by listing it in `ca`. Each TLS connection is one session, and monitoring reports its transport as `netconf-tls`.

```json
"listen": {
  "ssh": {},
  "tls": {
    "cert": "tls/server.pem",
    "key": "tls/server.key",
    "ca": ["tls/clients-ca.pem"],
    "certToName": [
      { "id": 1, "fingerprint": "04:8a:…:3f", "mapType": "san-rfc822-name" },
      { "id": 2, "fingerprint": "04:8a:…:3f", "mapType": "common-name" }
    ]
  }
}
```

**Cert-to-name** maps a client certificate to a username, as RFC 7407's `ietf-x509-cert-to-name` does:

- Entries are tried in ascending `id` order.
- An entry applies when its `fingerprint` is that of the client's certificate or of any certificate in its chain, including the trust anchor. A CA's fingerprint therefore covers every certificate it issued. A TLS server in Node can't see the intermediate CAs a client sends, so to match an intermediate, or the anchor above it, list the intermediate in `ca` too.
- The `mapType` says where the name comes from:
  - `specified`: the entry's own `name`;
  - `san-rfc822-name`: the first email address, host part lowercased;
  - `san-dns-name`: the first DNS name, lowercased;
  - `san-ip-address`: the first IP address, IPv6 as 32 lowercase hex digits;
  - `san-any`: the first of those three kinds;
  - `common-name`: the subject's CN.
- When an applicable entry finds no name, the next entry is tried. When no entry finds one, the client is refused.

Fingerprints are RFC 7407 tls-fingerprints: `04:` then the SHA-256 as colon-separated hex (or `03`, `05`, `06` for SHA-224, SHA-384, SHA-512). `SHA256:<base64>` works too. MD5 and SHA-1 aren't accepted. For a CA:

```sh
openssl x509 -in clients-ca.pem -noout -fingerprint -sha256 | sed 's/.*=/04:/'
```

The mapped name then goes to `authenticate` like any other login. The static users accept it when it's a listed user, with that user's groups; a certificate that maps to a name nobody listed is refused. A refused connection is closed without a NETCONF reply and logged at info with the certificate's fingerprint, subject and the client's address.

**In code:**

```ts
import { readFile } from 'node:fs/promises';
import { tlsListener, staticUsers } from '@node-net/netconf-server';

await server.listen(
  tlsListener({
    cert: await readFile('server.pem'),
    key: await readFile('server.key'),
    ca: await readFile('clients-ca.pem'),
    certToName: [{ id: 1, fingerprint: '04:8a:…:3f', mapType: 'common-name' }],
    authenticate: staticUsers([{ username: 'ops', groups: ['admin'] }]),
  }),
);
```

A custom `authenticate` sees `{ method: 'certificate', username, certificate: { fingerprint, subject, der } }`, only after the chain has been validated and the name mapped, and can still refuse it. `mapCertificateToName(chain, entries)` runs the mapping on its own.

## Interop

`npm run test:interop` (Docker) starts a netopeer2 container and checks that both servers give the same answers to the same filters, that the same edits leave the same configuration or fail with the same error-tags, and that subscriptions and the RFC 6470 notifications agree. The deviations it allows are listed, each with its reason, in test/interop.

For scripted, in-process test doubles, use `FakeServer` from `@node-net/netconf/testing` instead.

The interop tests use netopeer2's setup from [@node-net/netconf](https://github.com/node-net-org/netconf): `scripts/netopeer2.sh` and its test-only TLS certificates. Clone that repository beside this one (`../netconf`) to run them.

## Development

```sh
npm install
npm run check
```

There is no CI for changes: what gates a change is these checks, run locally before it lands. Only releases run on GitHub (below).

- **`npm run check` runs before every landing:** lint, typecheck, layer rules, build, tests, the CommonJS, portability and pack checks, and last the runtime audit. `npm audit --omit=dev` fails the check on any known vulnerability in the runtime dependencies. If the registry can't be reached, the audit is skipped with a loud warning and the check still passes, so it works offline. `NN_REQUIRE_AUDIT=1` makes that skip a failure.
- **`npm run check:full`** (`scripts/check-full.sh`) runs `check` with the audit required, then `scripts/check-node.sh 22 24 26` (Docker required), and the full `npm audit`, which is reported but never fails. `--quick` skips the Node.js lines. Run it before landing any change to dependencies or these scripts, and whenever unsure. `npm run test:interop` is separate, and worth running for any change to what the server answers.
- **Every Node.js LTS line that `engines` allows must pass the whole check.** `scripts/check-node.sh` runs `npm install` and `npm run check` for each line in a clean `node:<line>` container, with a copy of the working tree. When a new line is promoted to LTS, add it to the script's default lines; when one reaches end of life, drop it and raise `engines`.
- **Updates:** `npm run deps:report` lists outdated dependencies, with in-range updates apart from those needing a range change, and summarises the runtime and full audits.
- `scripts/install-hooks.sh` installs an opt-in git pre-push hook that runs `npm run check` (`--uninstall` removes it).
- **Releases:** `npm version patch` (or `minor`, `major`), then `git push --follow-tags`. The tag starts `.github/workflows/release.yml`, which runs `check` and publishes to npm through trusted publishing, so no npm token exists anywhere. Each version carries a provenance statement linking it to its commit. `prepublishOnly` refuses to publish while a `@node-net/` version this depends on isn't on npm yet.
- [docs/](docs/) holds the maintainer notes: the [design](docs/net-netconf-server-design.md) and the [NACM design](docs/nacm-design.md).

## Licence

MIT
