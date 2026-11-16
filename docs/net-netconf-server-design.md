# @node-net/netconf-server: design

> **Status: agreed; being implemented.** The decisions below were settled in a design review on 2026-11-13. Milestone M0 is implemented. Section 16 lists the roadmap and what was deliberately deferred.

## 1. Why build it

@node-net/netconf's `FakeServer` is a scripted test double. It runs in-process, each test supplies the replies, and it can misbehave on cue (`sendRaw()`, a bad hello, no reply). That is what the library's own tests need, and it stays as it is.

It is not a NETCONF server. It has no datastores, no locking, no validation and no listener. The lab's defect server (`scripts/defect-server.mjs`) puts SSH around it, but each scenario is still scripted by hand. The open-source servers used for interop testing (netopeer2, yuma123, Clixon) are written in C, run in containers, and each has its own deviations from the RFCs.

@node-net/netconf-server is a NETCONF **server framework**. It is pure TypeScript and handles the protocol, the datastores and their semantics. Data sources plug in through a defined provider interface: the first is simulated data, and later ones can front a container runtime, a server OS or any other system. It runs:

- in-process, for behavioural tests of @node-net/netconf and nnc, and as the simulated device of the browser tutorial;
- standalone as `nncd`, or in a container, for general testing, demos and CI of any NETCONF client;
- embedded in other programs, as a NETCONF front end for the system they manage.

## 2. Package boundaries

- **Its own package and repository**, [node-net-org/netconf-server](https://github.com/node-net-org/netconf-server), versioned and released separately from the client library. The CLI is `nncd`, to pair with `nnc`.
- **Dependency direction:** the server depends on `@node-net/netconf` and `@node-net/yang`. Neither of them ever depends on the server. Lint forbids importing either one's sources; only their package exports are allowed.
- **Shared protocol primitives** (framing, hello negotiation, capabilities, XML, the connection interface) come from @node-net/netconf's Node-free `@node-net/netconf/core` entry. There is no separate core package unless a third consumer needs one.
- **A browser-safe core.** The protocol and datastore core uses no Node built-ins (`ssh2`, `net`, `tls`, `fs`), enforced the way `@node-net/netconf/core` is (dependency-cruiser, ESLint and a portability check). It offers `transport(): ConnectionFactory` for in-process clients, takes the device as data, and has an injectable clock. SSH, TLS, `nncd` and file loading are a Node-only layer around it.
- **`FakeServer` stays** in `@node-net/netconf/testing`, small and dependency-free.
- **Cross-tests** that run the client against this server live in this package, never in @node-net/netconf, because that would make a dependency cycle.

## 3. Principles

- **A framework, not only a simulator.** Every backend, including the simulator, goes through the same provider interface. The simulator gets no special treatment.
- **Config over code.** A device is data: a YANG module set with features and deviations, initial datastore contents, a capability list and quirks. A deployment is data too. Providers are code, but wiring them into a server is configuration.
- **The schema is enforced in every direction.** NETCONF edits, changes from backends, notifications and start-up data are all validated. Nothing that breaks the schema enters a datastore (section 16 records the deferred lenient option).
- **@node-net/yang does the YANG work.** Schema compilation, validation, edit application with error options, and tree diffs come from @node-net/yang. If the server needs a YANG behaviour @node-net/yang lacks, @node-net/yang gains it. Mapping @node-net/yang's issue codes to NETCONF error-tags is the server's job.
- **Async functions for what the server waits on; events for what it reports.** Hooks the server must await (reads, prepare, commit, authentication) are registered async functions. Events (`sessionStart`, `commit`, `lockChanged`, `stateChanged`, `outOfSync`) only report. No listener-less `'error'` events.
- **Correct by default, wrong on purpose.** The default behaviour follows the RFCs. Deviations that copy real devices are explicit, named quirks in a device definition.
- **Same conventions as @node-net/netconf and @node-net/yang:** ESM-only, promises, Node ≥ 22.12, @node-net/netconf's `Logger` interface.

## 4. Providers

Backends plug in as providers registered on subtrees:

```ts
server.provide('/ietf-interfaces:interfaces', {
  // refresh state before a read
  onRead,
  maxAge,
  onReadTimeout: 'stale',
  // two-phase apply of the changes under this subtree
  prepare: async (changes) => txn,
  // start-up mode, overriding the server's
  startup: 'adopt',
  load,
  // commit after these providers
  after: ['/ietf-system:system'],
  // custom RPCs and actions in this subtree
  actions,
});
```

Every member is optional. The deepest registration owns a node, and overlapping registrations at the same path are rejected.

**As built in M3:**

- **Registration.** `server.provide(path, provider)` resolves with a handle once the provider is in step with running (section 9), and `createServer({ providers })` registers providers before start-up. `path` is a schema data path without keys (`/module:top/child`). A path not in the schema, a duplicate, `adopt` without `load`, an `after` cycle (the error names the providers), an unknown `after` path, and an RPC or action handler outside the subtree are rejected. `handle.unregister()` makes the subtree unclaimed.
- **Splitting changes.** One `diffTrees` of old and new running. Each change goes to the provider owning its node. A created or deleted node that holds registered subtrees also gives each of those providers a create or delete of its own instances. A change to unclaimed configuration counts only if it holds a leaf, a leaf-list or list entry, a presence container or anydata; non-presence containers are structure.
- **RPCs and actions.** `rpcs` are keyed by `module:name` and must be in the module of the provider's path. `actions` are keyed by schema path and must be inside its subtree. The YANG 1.1 `<action>` element goes to the server's action handler. Input is decoded and validated against the schema and the current `<operational>` (@node-net/yang's `validate` with `operational`), so a missing parent instance is `missing-parent`, sent as data-missing. Handlers get RFC 7951 JSON input and the instance path; their output is validated before it is sent. `server.handle()` stays internal.
- **Hook timeouts** (section 8) default to 10 s for read and prepare, 30 s for commit and 60 s for load. They are set server-wide with `providerTimeouts` and per provider with `timeouts`, and run on the injectable clock.

### 4.1 Providers compared with net-snmp's

The model follows net-snmp's agent providers. The difference is in what a provider is for. A net-snmp provider does three jobs at once, because the SNMP agent has no schema of its own at run time: an OID that no provider registered does not exist, and answers `noSuchObject`. Here the three jobs belong to different parts:

| Job | net-snmp | @node-net/netconf-server |
|---|---|---|
| Schema: what exists, its types and constraints | the provider | compiled YANG (@node-net/yang), for the whole module set |
| Storage | the provider's scalar or table | the server's datastores, which hold every node (they must anyway, for candidate, rollback, diffs and validation) |
| Behaviour | the provider's handler | the provider, which is optional |

So a provider only adds behaviour to a subtree that the schema and the datastores already cover. Data that no provider claims is simply stored, which is what the simulator wants: the simulator is the server with no providers, plus data files.

The cost is that a real backend could accept configuration that nothing applies. Two guards cover it. First, a deployment advertises only the modules it backs, and uses `deviate not-supported` for the parts it doesn't. Second, a server policy, `unclaimed: 'store' | 'reject'`, rejects edits that no provider claims with `operation-not-supported`.

## 5. Datastores

- **NMDA inside, both operation sets outside.** The server keeps `<running>`, `<candidate>`, `<startup>`, `<intended>` and `<operational>` as separate @node-net/yang trees, and serves both the legacy operations (`<get>`, `<get-config>`, `<edit-config>`) and the NMDA ones (`<get-data>`, `<edit-data>`, RFC 8526). Legacy `<get>` is a view: `<running>` plus state (RFC 8342 §5.3). `<intended>` is an alias of `<running>` until something needs them to differ.
- **The server owns the configuration datastores.** Providers apply validated changes (section 6); they never hold the configuration.
- **The server holds the `<operational>` tree.** Providers keep it current in two ways:
  - **Pull:** an async `onRead` hook, called before a read whose filter touches the provider's subtree. Hooks for different subtrees run concurrently; concurrent calls for the same provider are merged into one; `maxAge` rate-limits expensive hooks.
  - **Push:** the provider updates the tree whenever the backend reports a change (`server.operational.update(edit)`).
  - The held tree is also what on-change subscriptions (RFC 8641) will diff against.
- **Configuration datastores have no read hooks.** If a read could change `<running>`, configuration would change under a lock, skip validation, break candidate and confirmed-commit, and send no `<netconf-config-change>`. Configuration changes on the backend arrive through `applyExternal` (section 7).

| Read | Answered from | Hooks run? |
|---|---|---|
| `<get-config>` of running, candidate or startup | the server's configuration tree | no |
| `<get>` | `<running>` plus the state part of `<operational>` | yes, for the state the filter covers |
| `<get-data>` of `<operational>` | the operational tree | yes, for what the filter covers |


**As built in M1** (no providers yet):

- **Snapshots.** The configuration datastores are immutable @node-net/yang trees. A read uses the snapshot it starts with. Any step that changes a tree (defaults, filtering, pruning) works on a copy, or on a tree built for that read.
- **Initial data.** Initial data is read from the device's data files through a `readData` hook, so the core needs no filesystem. It is validated at load.
- **Building `<operational>`.** Until providers hold it, `<operational>` is built for each read: `mergeTrees` of running's configuration (tagged `or:origin intended`), the device's operational file, the YANG library and NETCONF monitoring. M3's read hooks and pushed updates replace the file's part, and the server keeps the tree.
- **with-defaults on `<operational>`.** The server doesn't advertise `:with-operational-defaults`, so `<get-data>` of `<operational>` refuses with-defaults with invalid-value (RFC 8526 §3.1.1).
- **Origin filters.** `origin-filter` and `negated-origin-filter` select configuration by effective origin, with no origin counting as `or:unknown`, and leave state alone.
- **Sessions without a network transport.** Monitoring reports their transport as `net-netconf-server-monitoring:in-process`, an identity in the server's own small module.

**As built in M2:**

- **The candidate is running until it changes.** An unchanged candidate is running's snapshot itself, so it follows every change to running. The first change gives it its own tree, records the running snapshot it was made against (its base) and the sessions that made it. A `<commit>` or `<discard-changes>` makes it running again, and so does releasing a lock on it while it holds uncommitted changes (`<unlock>`, or the end of the holding session).
- **Commit against running as it is now.** When running hasn't changed since the candidate's base, the candidate's tree becomes running. When it has, the candidate's own changes (@node-net/yang `diffEdit` from base to candidate) are applied to the current running, so a write to running in between isn't lost.
- **Validation.** Every write to running and startup is validated, so nothing that breaks the schema enters them. `test-option set` on running still validates. The candidate is validated under `test-then-set` (the default, RFC 6241 §8.6.4) and not under `set`, which leaves validation for `<commit>` or `<validate>`. netopeer2 doesn't validate the candidate until commit whatever the test-option. That deviation is listed in the interop allowlist, and a quirk can copy netopeer2's behaviour (M4).
- **Error-tags.** @node-net/yang reports issues with its own codes and leaves the protocol mapping to NETCONF. The server maps them to RFC 6241 Appendix A's error-tags and RFC 7950 §15's error-app-tags, one `<rpc-error>` per issue. `error-path` is every step prefixed with its module's name, declared on the element. A wrong-typed value is invalid-value where netopeer2 says operation-failed (allowlisted).
- **Locks.** Global locks on running, candidate and startup, kept in a table published as `server.locks` and the `lockChanged` event, and in monitoring's `datastores/datastore/locks/global-lock`. A candidate lock is denied while another session (or an ended one) has uncommitted changes in it.
- **Persistence.** `Store` (`load`, `save`, optional `open` and `describe`) keeps RFC 7951 JSON text; the server decodes and validates it. `memoryStore()` is the default and portable; `fileStore(dir)` is Node-only (src/store/file.ts), writes a temporary file and renames it, and is checked for writability when the server starts. A save happens inside the write before the snapshot is swapped, so a failed save changes nothing. `startup: 'push' | 'adopt'` is accepted and has no effect until providers exist.

**As built in M3:**

- **The held state.** The server holds the state part of `<operational>` (datastore/operational.ts): it starts as the device's operational file and is changed by `server.operational.update(edit)` and by read hooks, each validated, emitting `stateChanged`. A read still merges running (tagged `intended`), the held state and the state the server produces (YANG library, monitoring, `net-netconf-server-monitoring:providers`). The configuration part is running itself, so only the state needs holding, and that is what on-change subscriptions will diff. Configuration nodes may appear in the held state only as structure (containers, list entries and their keys) or with an `or:origin` of `system` or `learned`; anything else goes through `applyExternal`.
- **Read hooks.** Which providers a read selects is worked out from the schema, since their data isn't there until the hooks run. A provider is selected when its path and a path the filter names are one inside the other. Content-match nodes narrow entries, not hooks. An XPath expression other than plain absolute child paths (with `|`) selects every provider. A hook's returned data replaces what it owns in the held state, leaving deeper providers' nodes alone. A late result after a timeout is dropped.

## 6. Transactions

A write to `<running>` (an edit, a `<commit>` of the candidate, a confirmed-commit rollback) runs one coordinated transaction:

1. Apply the edit to a copy (@node-net/yang `applyEdit`/`tryApplyEdit`, honouring `<error-option>`) and validate the result.
2. Diff the old and new `<running>` and split the changes by owning provider.
3. Call `prepare(changes)` on every provider involved, concurrently. If one refuses, `abort` the ones that prepared and reply with its `<rpc-error>`.
4. Call `commit` on each, in registration order, or after the providers each one names in `after`.
5. Swap in the new `<running>`, update `<operational>`, emit `commit` and send `<netconf-config-change>`.

**The provider contract:** `prepare` does everything that can fail (checks resources, stages files, reserves). `commit` only switches over to what was staged. Under the `'adopt'` start-up mode (section 9), `commit` must also make the change permanent on the backend.

**When a `commit` throws anyway:** the providers that already committed are rolled back with a compensating transaction (the inverse diff, through `prepare` and `commit`), `<running>` keeps its old value, and the client gets `operation-failed`. If the compensation fails too, the affected subtrees are marked out of sync, which emits `outOfSync` and is reported in `<operational>`. There is no provider `undo()`.

**As built in M2** (no providers, so steps 2 to 4 are empty): a write applies or copies its tree, validates it, saves it if it is the saved datastore, swaps the snapshot, and emits `commit` with its cause (`edit`, `commit`, `copy` or `rollback`). `<netconf-config-change>` arrives with notifications (M4). A pending confirmed commit keeps the running snapshot from before the first confirmed commit; a rollback restores that snapshot through the write queue and ignores locks, since the server is undoing its own change. The confirm timer runs on the injectable clock. Without persist, follow-ups must come from the confirming session, and others get operation-failed. With persist, they need the matching persist-id, and others get invalid-value.

**As built in M3:** steps 2 to 4 run in `Writer.#replaceRunning` (provider/transaction.ts), before the save. A failed save undoes the providers' commits like a failed commit. Commit order is a topological sort of `after`, ties by registration order. A refusal's rpc-errors go to the client as they are; any other error becomes operation-failed with the provider's message. The failing provider and those after it are aborted; only those that committed are compensated. Rollback of a confirmed commit goes through the providers but not the unclaimed check. If it is refused or fails, running keeps the confirmed configuration and the providers at fault are marked out of sync. The `commit` event now carries the changes, the user and, for outside changes, the source. Locks carry the user too (`server.locks.get()`, `lockChanged`).

## 7. Changes from outside NETCONF

A provider calls `server.running.applyExternal(changes, { source })` when the backend's configuration changes by another route: a hand edit of a file, another management tool, a reconnect after an outage.

- The change is validated. **Invalid changes are rejected**: `applyExternal` throws a `YangDataError` with @node-net/yang's issues, and `<running>` stays as it was. Mapping the backend's state to valid configuration is the provider's job. The change is atomic.
- A valid change updates `<running>` and `<operational>`, sends `<netconf-config-change>` with the provider as its source, and does **not** call providers' `prepare`/`commit`, since it is already applied.
- **NETCONF locks don't apply to it.** Whether the backend can be held back while a session holds a lock is outside the library's remit. The server publishes its lock state (`server.locks.holder(datastore)` and `lockChanged`) for consumers who can enforce it themselves (RFC 6241 §7.5).
- A provider whose backend has drifted and can't be reconciled marks its subtree out of sync, the same mechanism as a failed compensation.

**As built in M3:** `applyExternal` takes an edit (a @node-net/yang edit tree, or RFC 7951 JSON with NETCONF edit annotations) and resolves with the changes. It emits `commit` with cause `external` and the source; `<netconf-config-change>` follows with notifications (M4). A candidate edited before it commits against the new running through the M2 rebase. The registration handle's `markOutOfSync(reason)` covers a backend that drifted and can't be reconciled.

## 8. Concurrency

- **Reads use snapshots.** @node-net/yang's edits return new trees, so every committed datastore is an immutable value. A read works from the reference it took, with no locks and no torn reads.
- **Writes are serialized** in one FIFO queue, server-wide: edits, commits, confirmed-commit rollbacks and `applyExternal`. Validation is whole-tree, so two commits can't be validated independently.
- **Every hook has a timeout** (`onRead`, `prepare`, `commit`, `load`). A late `onRead` serves the last data with a warning, or fails the read (`onReadTimeout: 'stale' | 'error'`); a late `prepare` aborts the transaction; a late `commit` is a failed commit (section 6).
- **v1 targets** 100 concurrent sessions and configuration of about 100k nodes, guarded by a benchmark test.

## 9. Persistence and start-up

- A `Store` interface (`load(datastore)`, `save(datastore, tree)`) with two built-in stores: memory (the browser, tests, throwaway simulators) and file (one RFC 7951 JSON file per datastore in a state directory, written atomically).
- RFC 6241 decides what is saved: `<startup>` with `:startup`, otherwise `<running>`. `<candidate>` is never saved.
- **Start-up is an explicit choice**, `startup: 'push' | 'adopt'` for the server, which each provider can override:
  - `'push'` (the default): the saved configuration wins and is pushed to the provider through `prepare`/`commit`, as a router applies its startup config at boot.
  - `'adopt'`: the backend wins. The provider's `load()` is validated and replaces the saved copy for its subtree. `'adopt'` without `load()` is an error at registration.
  - Unclaimed subtrees use the saved data, or the device definition's initial data on the first run.
- Start-up data is validated like everything else. If the combined configuration is invalid, the server refuses to start and lists the issues.

**As built in M3:** providers given to `createServer` start before it resolves. Adopting providers' `load()` results replace their subtrees of the saved configuration (and of startup with `:startup`), are written back to the store, and the combined configuration is validated. Each violation is prefixed with its source: the provider (`load`), the saved file, or the device definition. Then the push providers get creates of everything in their subtrees through prepare and commit; a refusal makes `createServer` reject with a `DeviceError` holding the provider's errors. `provide()` after start-up does the same for one provider through the write queue (an adopted subtree becomes running with cause `startup`), and unregisters it again if it fails.

## 10. Protocol coverage

**v1:**

- `base:1.0`, `base:1.1` and both framings;
- `:writable-running`, `:candidate`, `:confirmed-commit:1.1`, `:rollback-on-error`, `:validate:1.1`, `:startup`;
- subtree filters and `:xpath`;
- `:with-defaults` (RFC 6243), NMDA (RFC 8526), the YANG library (RFC 8525);
- monitoring with `<get-schema>` (RFC 6022);
- RFC 5277 notifications with `:interleave`, and the RFC 6470 base notifications.

**v1.x:** subscribed notifications (RFC 8639/8640), then YANG-Push (RFC 8641); compare (RFC 9144); notification replay.

**NACM** (RFC 8341) is built, as [nacm-design.md](nacm-design.md) describes (agreed 2026-11-15, delivered in its four changes NACM-1 to NACM-4). It fills the two seams v1 kept for it: every session carries an authenticated principal (`{ username, groups? }`), and every operation passes through one authorization point. A device that implements `ietf-netconf-acm` enforces it whenever `enable-nacm` is true: operations, reads, writes, actions, notifications and error replies. A device without the module behaves as before. **Later**, on demand: `:url` and partial-lock (RFC 5717).

**As built in M4:** RFC 5277 and `:interleave` are in place without replay: `startTime` gets operation-not-supported, and `stopTime`, which RFC 5277 §2.1.1 allows only with `startTime`, gets missing-element naming it, as netopeer2 answers. One subscription per session; a second gets in-use (netopeer2 answers operation-failed, allowlisted). Without `:interleave` a subscribed session can only close (operation-not-supported for the rest, through a dispatcher gate). `netconf/streams` lists the `NETCONF` stream with `replaySupport` false. RFC 6470 `<netconf-capability-change>` isn't sent: nothing changes the capabilities at run time yet (NOTIF-05).

## 11. Transports and authentication

- **v1:** SSH (RFC 6242, the `netconf` subsystem, port 830), with host keys from files or generated once and saved in the state directory; and in-process `transport()`.
- **v1.x:** TLS (RFC 7589) with certificate-to-name mapping (`ietf-x509-cert-to-name`, as data), and call home (RFC 8071).
- **Authentication** is an async hook, `authenticate(attempt) → principal | undefined`, where an attempt is a password, a public key or (with TLS) a certificate. The built-in implementation reads static users from the deployment config, with scrypt password hashes and authorized keys. PAM, LDAP and RADIUS are for consumers to write. Keyboard-interactive authentication isn't planned.
- **Static users** are always given a password hash, which `nncd` generates from a password typed at a prompt. A plain-text password is accepted only for a user marked as a lab user (such as `netconf`/`netconf` on the lab defect server), and start-up then logs a warning. Failed logins don't say which part was wrong, and the password is never logged.

**As built in M5:**

- **Core and Node.** The hook types (`Authenticate`, `AuthAttempt`, `ServeOptions`, `Listener`) are in `@node-net/netconf-server/core`. Everything that needs Node is in `src/node/` (both NODE_ONLY lists name the directory) and reached only from the root entry: `sshListener()`, `loadHostKeys()`, `staticUsers()`, `hashPassword()`, the deployment config and nncd. `server.listen(listener)` starts a listener and `server.close()` closes it.
- **The listener** is ssh2's `Server`. Each `netconf` subsystem channel goes through @node-net/netconf's `duplexConnection()` into `server.serve()` with `transport: 'ssh'` and `sourceHost`. Other subsystems, shell and exec are refused without dropping the connection, and the connection is ended when its last NETCONF channel closes. It is named `sshListener()`, not `ssh()`, so it doesn't clash with @node-net/netconf's client `ssh()` when both are imported.
- **Public keys.** A key query without a signature is accepted whatever the key, so a client can't probe which keys are authorized. The signature is verified with ssh2's `parseKey().verify()`, and only then is the hook called, once per real attempt. Hooks get `authTimeout` (10 s); after `maxAuthTries` (6) failures the connection is dropped.
- **Static users.** Hashes are PHC-style `$scrypt$ln=15,r=8,p=1$salt$hash`, checked with `timingSafeEqual`. An unknown user's password still goes through scrypt, so timing doesn't reveal which users exist. Lab users' plain-text passwords are compared by SHA-256 digest.
- **Host keys** are generated by retrying ssh2's generator until its own parser accepts the key (it sometimes doesn't). The key is written to a temporary file with mode 0600 and renamed into place.

**As built (TLS):**

- **The listener.** `tlsListener()` (src/node/tls.ts) is Node's `tls.createServer` with `requestCert`, `rejectUnauthorized` and `minVersion: 'TLSv1.2'`, on port 6513. Chain validation is OpenSSL's against `ca`, which replaces Node's root store. A self-signed client certificate is trusted by listing it in `ca`. A missing or untrusted certificate fails the handshake (logged at debug as `tlsClientError`). Each TLS connection is one session, served with `transport: 'tls'`, so monitoring reports `ncm:netconf-tls`. A refusal destroys the socket, since RFC 7589 has none in band, and logs `Login refused` at info with the leaf's SHA-256 fingerprint, subject and source host.
- **Cert-to-name.** `certToName(entries)` (src/node/cert-to-name.ts) follows RFC 7407:
  - entries are tried in ascending id order;
  - an entry applies when its fingerprint is the leaf's or that of any certificate in the validated chain, including the trust anchor. The listener builds that chain itself, from the leaf through issuers among the configured trust anchors (checkIssued and signature verification). Node doesn't expose the intermediates a client sends to a TLS server, so an intermediate, and the anchor above it, can be matched only when the intermediate is listed in `ca` too. This is a deviation from RFC 7589's "any certificate in the chain";
  - its map type (`specified`, `san-rfc822-name`, `san-dns-name`, `san-ip-address`, `san-any`, `common-name`) names the user, normalised as RFC 7407 says;
  - an entry whose map type finds nothing lets the next one try.
  
  Fingerprints are tls-fingerprints (03 to 06 only: MD5 and SHA-1 are refused) or `SHA256:<base64>`, compared with `timingSafeEqual` against every certificate in the chain. SANs come from `X509Certificate#subjectAltName`, whose JSON-quoted values are parsed as JSON, so `evil@example.com, DNS:admin` in an email SAN stays one email address. A subject with two CNs gives no common name.
- **The hook.** A `CertificateAttempt` (`method: 'certificate'`, the mapped `username`, and the leaf's fingerprint, subject and DER) goes through the same `decide()` as SSH, with the same timeout and error logging (src/node/decide.ts, shared by both listeners). `staticUsers()` accepts it when the name is a listed user, with that user's groups.
- **nncd.** `listen` holds `ssh` and `tls`, and nncd starts exactly those named. Without `listen`, SSH runs on 830. `prepareServer()` returns `listeners: { ssh?, tls? }`. It reads the certificate, key and trust anchor files, checks that the key fits the certificate with `createSecureContext`, and checks the cert-to-name entries; each failure is a `StartError` naming the file or entry, under `--check` too. The JSON Schema can't say that ids are unique, so the hand-written validator adds that.

## 12. Notifications and logging

- Providers send notifications with `server.notify(path, data)`. Notifications are validated against the schema.
- The server generates `<netconf-config-change>`, `<netconf-session-start>`, `<netconf-session-end>` and `<netconf-confirmed-commit>` (RFC 6470) itself.
- Logging uses @node-net/netconf's `Logger` interface and levels. The context carries session id, username and message-id. `nncd` logs to stderr, with `--log-level`.

**As built in M4:**

- **Order.** A session writes a notification only between replies: one raised while it answers a request waits for that reply (session.ts). Publishing (notify/bus.ts) is synchronous fan-out, so one caller's notifications keep their order. A subscription's filter is a `<get>` filter (rpc/reads.ts `Reader.filter`); a notification is sent when the filter selects anything of it, and the whole notification goes.
- **`server.notify(path, content)`.** Content is RFC 7951 JSON (or a @node-net/yang tree), decoded with the `operation` option and type `notification` (which reads notifications too), so `path` names a nested notification by its instance. It is validated with the current `<operational>` data; a missing instance is missing-parent. Invalid content throws `YangDataError` and nothing is sent; a device without `:notification` throws `TypeError`.
- **RFC 6470.** Built as JSON from the server's own events and decoded, but not validated against data: `<netconf-config-change>`'s edit targets are instance-identifiers, and a deleted node's no longer exists. changed-by is the session, or `server` for a change from outside NETCONF (whose source stays on the `commit` event, since RFC 6470 has no field for it), a confirm-timeout rollback, a provider adopting its backend, or a reset or restore. A write that changed nothing sends none. Past 1000 changes the edit list is left out, as RFC 6470 allows. `<netconf-confirmed-commit>` comes from a writer callback (start, extend, complete, cancel, and timeout without session parameters); netopeer2 sends none (allowlisted). netopeer2 names sysrepo's system user in changed-by; the interop set drops the user there.
- **Monitoring.** `out-notifications` counts per session and in total; `out-rpc-errors` is now counted when a reply is written, so injected errors and quirk replies count too.

## 13. Devices and quirks

A **device definition** (`devices/*.json`, with its own JSON Schema, in this package) says what to emulate:

- identity: `id`, `description`, and `emulates`, the id of the @node-net/netconf client profile it should be detected as;
- schema: YANG module sources, features and deviations;
- capabilities: extras and overrides, so a device advertises exactly what the real one does;
- data: initial `<running>` and `<startup>`, and `<operational>` state, as XML or RFC 7951 JSON files;
- quirks: misbehaviours to emulate.

Client quirks are tolerances (how the client copes with a device); server quirks are the misbehaviours they exist for. Each server quirk names the client quirk it exercises, and a test checks that every client quirk has a server counterpart. Every client profile can then be tested end to end against an emulated device, without the real hardware. Quirks that need behaviour rather than a flag (such as rejecting subtree filters below a depth with a particular device's error text) are server code configured by data.

The package ships a device definition for each client profile @node-net/netconf ships, starting with the Nokia 7210 SAS and netopeer2. A test fails if the client no longer detects an emulated device as the profile it `emulates`.

Listeners, users, host keys and the state directory are not part of a device: they belong to the deployment (section 14).

**As built in M4:**

- **The catalogue** (src/quirks/catalogue.ts) has eight quirks: `replyWithoutMessageId`, `invalidXmlChars`, `paddedEmptyElements`, `chunkedFramingBroken` (the design's "base 1.0 only": it advertises base:1.1 with broken chunk headers, so only a client forcing base:1.0 copes), `noPipelining`, `slowCloseSession`, `subtreeFilterLimit` (depth and the device's error text) and `candidateUnvalidated` (netopeer2's candidate, validated only at commit; it names no client quirk and the M2 allowlist entry points at it). Each names the client quirks it exercises; `test/device-06-quirk-pairing.test.ts` fails when a @node-net/netconf client quirk has none, and connects @node-net/netconf with and without each tolerance.
- **Settings** are `true` or an object, checked by the catalogue at load (unknown names and bad settings are rejected with their JSON path) and described in the JSON Schema. Element-level quirks change the reply element and text-level ones its serialized text, after the server answered correctly (quirks/apply.ts), so nothing else knows about them.
- **In force.** A session takes the device's quirks and the run-time new-session layer when it opens; a change for one session applies from its next message, except `chunkedFramingBroken`, which acts on framing and reaches only sessions opened later. Control sessions get none.
- **Emulated devices** ship in `devices/` for every @node-net/netconf client profile: `nokia-7210-sas`, `nokia-sros-md` and `sysrepo-netopeer2`. Detection is from the hello, so each advertises the module its profile matches (the netopeer2 one with an `extra` capability for `sysrepo-plugind`). The Nokia modules aren't published, so those devices have stand-in modules with the profiles' namespaces and only the nodes their `paths` read; the netopeer2 one uses NACM, the bundled module its paths use.

## 14. Running it

**The library API comes first.** Everything is possible from code, and embedders (tests, the browser, other daemons) use only this:

```ts
const server = await createServer({ device, store, startup: 'push' });
server.provide('/ietf-interfaces:interfaces', linuxInterfaces());
await server.listen(sshListener({ port: 830, hostKeys, authenticate }));
```

**`nncd`** is a thin `main` over that API, driven by a deployment config (`server.json`, with a JSON Schema):

- `device` (a path to a device definition) and `store` (`memory`, or `file` with `stateDir`);
- `startup`, `unclaimed`, and `control` (enabled, and which users may use it);
- `listen` (`ssh` with its address, port and host keys; `tls` with its address, port, certificate, key, trust anchors and cert-to-name entries) and `users` (the static-user authenticator);
- `providers`: a list of `{ module, path?, startup?, options }`. Each module's default export is a factory, imported at start-up and given its options.

Because it names modules to import, the deployment config is trusted like code: whoever can edit it can run code as the server.

`nncd` checks everything before it listens:

- A config that breaks the schema exits with status 2, listing each problem by JSON path.
- A problem with something the config names (a missing device file, a bad host key, invalid start-up data) exits with status 1 and names the item.
- `nncd --check` runs both checks and exits without listening.

On `SIGINT` or `SIGTERM` it stops accepting connections and lets a write in progress finish. It rolls back confirmed commits that have no `persist`, as if their sessions had ended, closes every session and exits with status 0. A second signal exits at once with status 130.

A **container image** (`nncd`, with the config, devices and state directory mounted) is a later milestone.

**As built in M5:**

- **The config** is `schemas/server.schema.json`. nncd checks it with a hand-written validator (src/node/config-validate.ts) that reports every problem by JSON path, as the device definition's does, and a test keeps the two in agreement through ajv, so ajv stays a dev dependency. The config adds `stateDir` (for the file store and a generated host key) and `logLevel` to the list above, and `store` is `memory` or `file`.
- **Mapping.** `readServerConfig()` and `prepareServer()` turn the config into `createServer()` options and the listener's: `loadDeviceFile()` with the control setting, `fileStore()` or `memoryStore()`, the providers, and `startup`, `unclaimed` and `control` passed through unchanged.
- **Providers.** A provider module starting `.` or `/` is a file relative to the config; anything else is a package resolved from the config's directory. The default export is called as `factory(options, { logger, configDir })` and returns the provider, or, when the entry has no `path`, `{ path, provider }` or a list of them. An entry's `startup` is applied through a proxy whose methods stay bound to the provider, so providers with private fields work.
- **`--check`** loads the device, reads existing host keys (it generates none), checks the users, imports the provider modules and checks their default exports, and validates the saved start-up data. It doesn't call factories, since they may open real backends.
- **Exit statuses.** 2 for usage and schema errors (`ConfigError`); 1 for anything the config names (`StartError`, whose message names the item, including a port that can't be bound); 0 after a clean shutdown; 130 for a second signal.
- **Logging.** One logfmt-like line per entry on stderr: the time, the level, the message, then the context. The server's log context gives `sessionId`, `username` and `messageId`. Every request is logged at debug from the single authorization point, with its operation and target datastore. Sessions log each message in and out at trace, through @node-net/netconf's `redactXml()`. The logger defines methods only for enabled levels, so nothing is redacted for a level nobody reads.
- **Graceful `server.close()`.** It closes the listeners, waits for the write queue and for each session's requests already received to be answered, then ends the sessions (reason `closed`). The writer's `sessionEnded()` queues the rollback of a confirmed commit without persist, and close() awaits the queue again before stopping the confirm timer. nncd's signal handler is just `await server.close()`.

### 14.1 The control module

Tests and the browser tutorial change a running server through a YANG module served over NETCONF itself (working name `net-netconf-server-control`), with RPCs such as `reset`, `inject-fault`, `set-quirk`, `send-notification`, `set-state`, `snapshot` and `restore`. The same operations are on the in-process API.

- It is advertised only when the deployment enables it: on for simulators and CI, off by default when real providers are in use.
- It is implemented as an ordinary provider, so it exercises the provider interface.
- Control sessions are exempt from quirks, so a server whose quirks break framing can still be controlled. Faults are scoped to their target session.
- NACM protects it like any other module: its RPCs are `nacm:default-deny-all` ([nacm-design.md](nacm-design.md) §4).

**As built in M4:**

- **Enabling.** `createServer({ control: { enabled, users } })`; enabled by default when `createServer()` is given no providers. The module is compiled into the schema only when enabled: `loadDevice(def, { control: true })` adds it, `Device.control` records it, and createServer recompiles a device loaded the other way (`withControl`, carrying its initial data over). So disabled means absent everywhere (hello, YANG library, monitoring, get-schema), and its RPCs get unknown-namespace.
- **A provider.** It is registered on `/net-netconf-server-control:control` through `server.provide()`, with `rpcs` and an `onRead` for its state (faults, run-time quirk changes, snapshots), and `startup: 'push'` since it holds no configuration. `server.control` is the same operations in process; the RPC handlers call them.
- **Control sessions.** With `users`, other users get access-denied and those users' sessions are exempt from quirks and faults from the hello on; without, anyone may use it and a session is exempt after its first control RPC.
- **Faults** (control/faults.ts) target a session by id, a user, or the next session to open; fire on the next RPC, the next of a named operation, or at once; and reply with rpc-errors, send no reply, delay on the server's clock, drop the connection, send no hello, send unsolicited messages first, or write raw bytes instead of the reply. Settings with their own shape (quirk settings, notification content, state edits) are JSON text in the module.
- **reset and restore** go through the write queue (`Writer.restore`) without providers, with cause `restore`, so `<netconf-config-change>` reports the difference with changed-by `server`. reset also releases every lock, drops a pending confirmed commit without a rollback, and clears faults, run-time quirks and snapshots. `set-state` refuses an edit with configuration leaves (invalid-value), unlike `server.operational.update()`.

## 15. Testing

1. **Unit and in-process tests** over `transport()`: datastore semantics, the transaction pipeline and compensation, error options, hook timeouts. The bulk of the suite.
2. **Differential tests against netopeer2** (and Clixon for compare, later): the same NETCONF exchanges against netopeer2 and `nncd` with the same YANG modules, comparing the replies after normalisation (message-ids, session ids, timestamps, system-ordered lists). Known netopeer2 deviations are listed in an explicit allowlist. These need Docker and run as `test:interop`, outside `check`. A small smoke set runs from M1; the full suite comes with M6. They matter because @node-net/netconf and the server share `@node-net/netconf/core` and @node-net/yang: a shared misreading of an RFC would otherwise pass every test.
3. **RFC examples** from RFC 6241, 6243, 8526 and 6022 as fixtures.
4. **Client suites** (@node-net/netconf's integration tests and nnc's) against `nncd`, and the quirk pairing tests of section 13.

### 15.1 The lab's defect server

After the v1 core, the defect server is rebuilt as a `lab-def` device definition plus fault scenarios, each a named list of control-module RPCs applied at start-up. Port 18500, the `netconf`/`netconf` user, the scenario names and the `lab-def` and `lab-def-quirks` targets stay the same, so the manual-testing tables stay valid, and scenarios can be switched without a restart. Its device-like scenarios become quirks, its timing scenarios become faults, its framing scenarios become raw-bytes faults, and its large-reply scenarios become device data. `scripts/defect-server.mjs` is retired once its scenarios pass.

## 16. Roadmap

| Milestone | Contents | Unblocks |
|---|---|---|
| M0 Sessions | Server core on `@node-net/netconf/core`: hello, framing, RPC dispatch, close-session and kill-session; `transport()`; device definition loader and schema compile; capabilities; the browser-safe guardrail | the first in-process client |
| M1 Reads | NMDA trees; `<get>`, `<get-config>`, `<get-data>`; subtree and XPath filters; with-defaults; YANG library; monitoring and `<get-schema>`; interop smoke test | a read-only browser tutorial; nnc browsing and completion |
| M2 Writes | `<edit-config>`/`<edit-data>` with error options; `<validate>`; locks; candidate, commit, discard-changes, confirmed-commit; copy-config, delete-config, startup; stores; start-up modes | a full simulator |
| M3 Providers | `provide()`; `onRead`, `maxAge`, merged calls; prepare, commit, abort, ordering, compensation; out of sync; `applyExternal`; `unclaimed`; timeouts; custom RPCs and actions | real backends |
| M4 Notifications and control | RFC 5277 and `:interleave`; RFC 6470; `server.notify`; the control module; faults; quirks and the pairing test | testing through the control module; client quirk tests |
| M5 `nncd` and SSH | deployment config and schema; SSH listener; host keys; static users; provider loading | **v0.1 published**: CI and standalone use |
| M6 Lab and interop | the `lab-def` migration; `test:interop` against netopeer2; RFC example fixtures | the old defect server retired |
| v1.x | TLS (done) and call home; RFC 8639/8640, then 8641; RFC 9144; replay; container image; NACM (done: [nacm-design.md](nacm-design.md), four changes) | access control for servers fronting real systems |

**Deferred, by decision:**

- A lenient-schema option that lets configuration breaking the schema into the datastores and tracks the violations. Strict is v1's only mode.
- Notification replay, `:url`, partial-lock and keyboard-interactive authentication. (NACM was deferred here too, and is now built: [nacm-design.md](nacm-design.md).)
- A provider-level `validate(fullDiff)` hook for checks across subtrees. YANG `must` and leafref validation cover most cases.
- Proxying to another NETCONF or gNMI device, which would favour a backend that owns the configuration over this design's server-owned datastores.

**Risks:**

- **Drift between the server's configuration and the backend.** This comes from the server owning the configuration. It is mitigated by `applyExternal`, the `'adopt'` start-up mode and the out-of-sync mark, but a provider that misses an outside change leaves `<running>` wrong until something reconciles it.
- **Not truly atomic across providers.** Compensation can itself fail.
- **A shared misreading of an RFC** by the client and server, because both are built on `@node-net/netconf/core` and @node-net/yang. The interop tests are the guard.
- **One slow `prepare` holds up every write behind it,** up to its timeout.
- **Access control depends on the device.** NACM is built ([nacm-design.md](nacm-design.md)), but it applies only to a device whose schema implements `ietf-netconf-acm`. A server fronting a real OS without the module, or with `enable-nacm` false, is still a root shell over NETCONF to anyone who can authenticate. A deployment that enforces it also needs a recovery user (`nncd --check` warns when none is named).
