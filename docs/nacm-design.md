# @node-net/netconf-server: NACM design

> **Status: agreed 2026-11-15; built (NACM-1 to NACM-4, 2026-11-16).** Section 12 records the five decisions settled in review, and the amendments made while it was built. The main design (net-netconf-server-design.md §10 and §16) points here. Section 13 lists the changes that deliver it, and the "As built" notes in each section record how.

NACM is the NETCONF Access Control Model, RFC 8341. The main design deferred it but kept two places for it to plug in, and both are already built:

- every session carries an authenticated principal, `{ username, groups? }`, from SSH, TLS cert-to-name or `transport({ principal })`;
- every operation passes through one authorization point, `authorize()` in src/rpc/dispatch.ts, which today only logs.

This document says how NACM fills them, and where else it has to reach: reads, writes, notifications and error replies.

## 1. Scope

**In:** all of RFC 8341 for NETCONF:

- operation (exec) access, including the built-in denials of `<kill-session>` and `<delete-config>`;
- data node read, create, update and delete access on every datastore: `<running>`, `<candidate>`, `<startup>`, `<intended>` and `<operational>`;
- action and nested notification access, which need read access to the ancestors;
- notification access for RFC 5277 subscriptions;
- `nacm:default-deny-write` and `nacm:default-deny-all`;
- groups from `/nacm/groups` and from the transport (`enable-external-groups`);
- the emergency recovery session;
- the three counters: `denied-operations`, `denied-data-writes` and `denied-notifications`.

**Out:** RESTCONF's method mapping (no RESTCONF server), `:url` (not supported), partial-lock (not supported). RFC 8639/8641 subscriptions will use the same notification and read checks when they arrive (section 8).

## 2. Principles

- **Config over code.** The policy is data: the `ietf-netconf-acm` tree in `<running>`, edited over NETCONF like any other configuration and validated by @node-net/yang. Embedders write no policy code.
- **Browser-safe core.** The policy engine is pure TypeScript in the core, with no Node built-ins, so the browser tutorial can demonstrate NACM.
- **One engine, several call sites.** The engine compiles the policy and answers "may this session do X to Y". The dispatcher, the reader, the writer and the notification bus each call it, and none of them knows the rules.
- **The NACM tree is the only source of truth.** No parallel policy in `server.json`. The deployment config only names recovery users, which RFC 8341 leaves to the implementation (§3.3.3).
- **Fast when the policy is simple.** Most deployments permit reads by default and deny a few subtrees. A read the policy doesn't restrict costs nothing extra.

## 3. When NACM is enforced

**NACM is enforced when the device's schema implements `ietf-netconf-acm`, and `enable-nacm` is true** (its default).

- A device without the module behaves exactly as today. Every existing simulator, test and the browser tutorial are unaffected, and there's no `/nacm` to configure anyway.
- A device that implements the module and has no `/nacm` data gets RFC 8341's defaults: `write-default deny`, `read-default permit` and `exec-default permit`. That is exactly §3.4.1's rule for first start-up: nobody but a recovery session may write. Nothing needs special-casing.
- `sysrepo-netopeer2` already implements the module and ships an `admin` group. Once NACM lands it enforces, as netopeer2 does. The tests that write to it then connect as `admin` or as a recovery user (section 4).

There is no separate `nacm: { enabled }` server option. Implementing the module is the switch, and `enable-nacm` is the run-time switch, as RFC 8341 says.

## 4. Recovery sessions

RFC 8341 §3.3.3 lets a server have a recovery session that bypasses NACM. It is needed to repair a broken policy, and to write the first one.

- **Library:** `createServer({ nacm: { recovery } })`, where `recovery(principal) → boolean` is decided once, when the session starts, and recorded on the session. The default is no recovery sessions.
- **nncd:** `nacm: { recoveryUsers: [...] }` in `server.json`, a list of usernames, whichever authenticator produced them (static users, cert-to-name, and later PAM).
- **In-process sessions aren't special.** `transport()` sessions are `local` by default, and NACM applies to them like any other session. A test that wants to bypass NACM names a recovery user.
- **Outside NACM:** server-initiated changes are never checked (§3.4.1). That covers start-up loading, `applyExternal`, provider `load()`, confirmed-commit timeouts, and the in-process `server.control` and `server.operational` APIs.
- **The control module** keeps its own `control.users` gate. Its RPCs also gain `nacm:default-deny-all`, so with NACM enforced a control user also needs a rule that permits them, or must be a recovery user. Main design §14.1 promised this ("NACM will protect it like any other module").
- Monitoring adds a `recovery` leaf to the server's own session entries (`net-netconf-server-monitoring`), so an operator can see which sessions bypass NACM.

## 5. The policy engine

src/nacm/ in the core, in three parts.

**Compile.** The engine compiles a `Policy` from the `/nacm` subtree of a `<running>` snapshot:

- Group membership is indexed by user.
- Rule-lists stay in configuration order, and rules in order within them.
- Each `path` (a `node-instance-identifier`, kept by @node-net/yang in its JSON form with module names) is resolved against the schema into schema steps with optional key predicates. A path the schema can't resolve never matches. It is logged as a warning once per compile, and isn't an error: RFC 8341 lets a rule name a module the server doesn't have.
- The `nacm:default-deny-write` and `nacm:default-deny-all` statements are read from @node-net/yang's `extensions` on each schema node, rpc and notification. They are collected once per schema, not per policy.

**Cache.** A `Policy` is cached by the identity of the `/nacm` instance node. @node-net/yang trees are immutable and share structure, so a commit that doesn't touch `/nacm` keeps the same node, and the cache holds. Per session, the engine derives a `SessionPolicy`: the user's groups (local, plus external ones when `enable-external-groups` is true) and the rule-lists that apply to them. It is cached by policy and group set.

**Decide.** The engine has four questions, each following its RFC 8341 procedure exactly:

| Question | RFC 8341 | Used by |
|---|---|---|
| `exec(rpc)` | §3.4.4 steps 1–12 | the dispatcher |
| `data(node, access)` for read, create, update, delete, exec | §3.4.5 steps 1–13 | the reader, the writer, actions |
| `notification(type, instance?)` | §3.4.6 steps 1–11 | the notification bus |
| `readPlan()`: a pruning plan for a whole tree | §3.4.5 for read, schema-indexed | the reader |

**The read plan** keeps reads fast. For each schema node, the engine works out, for this session, whether the whole subtree is permitted, denied, or mixed:

- **Permitted** means no read rule and no `default-deny-all` applies at or below it, and the defaults permit it.
- **Denied** means a rule or default denies the node, and nothing below can permit it again. A matching rule covers the node's descendants (§3.4.5 step 6), so a denial at a node is final.
- **Mixed** means rules with key predicates, or rules on descendants, decide per instance.

Pruning walks only the mixed nodes. A keyed rule is resolved at the list entry its key names: below that entry the rule either applies outright or not at all, so the subtree under it gets a plan of its own, shared by every entry that resolves the same way. The walk uses @node-net/yang's `pruneTree`, which gains a `keep(node) → 'keep' | 'drop' | 'descend'` option for this (@node-net/yang design: the server's YANG needs are met in @node-net/yang).

With `read-default permit` and no read rules, the plan is "everything permitted except the `default-deny-all` subtrees". On a device that enforces, that always includes `/nacm` itself (section 7.1). A read whose tree has nothing to drop keeps it as it is, and a tree built for the read has the denied nodes removed in place. Either way such a read copies nothing (section 7.1, amended 2026-11-16).

**The rules in effect for a message** are those of the running snapshot when the dispatcher takes the message (§3.4: "the same access control rules MUST stay in effect for the processing of the entire message"). An edit to `/nacm` applies from the next message, on every session. Edits to `/nacm` in `<candidate>` apply only once committed.

## 6. Operations

`authorize()` in the dispatcher becomes the operation check. It runs after the operation is known and its parameters are checked, exactly where the log line is now:

1. If the check permits, the operation runs.
2. If it denies, the reply is `access-denied`, with error-type `protocol` and error-path `/nc:rpc/nc:<operation>` (the RFC's own example). `denied-operations` is counted, and the denial is logged at info.
3. `<close-session>` is always permitted (§3.4.4 step 3).
4. `<kill-session>` and `<delete-config>` are denied unless a rule permits them (step 11). `exec-default` doesn't apply to them.
5. Provider RPCs and the control module's RPCs go through the same check. Their `nacm:default-deny-all` statements come from their YANG.

**Actions** (`<action>`) need read access to every instance on the path to the action and exec access to the action node itself (§3.1.3). The action handler checks both, after it has decoded the instance path and before validation. A denial is `access-denied` with error-path set to the deepest instance the user can read, so the reply doesn't confirm that an unreadable instance exists.

**As built in NACM-3:** the handler decodes the `<action>` without validation, checks read access on each instance from the top down and then exec on the action, and only then validates against `<operational>`. So an action on an instance the user can't read gets `access-denied`, never `data-missing`. The error-type is `protocol`, as for an operation, and the error-path is the deepest readable instance: the action's parent when every instance on the path is readable. RFC 8341 §3.4.5 has no `default-deny-all` step for exec, so the engine adds none. A refused action counts in `denied-operations`, since an action is a protocol operation, and raises `accessDenied` with kind `action`, the action's name and its instance path.

**Operations whose only access is exec** get no data check: `<lock>`, `<unlock>`, `<discard-changes>`, `<cancel-commit>`, `<close-session>`, `<kill-session>`, `<delete-config>`, `<get-schema>`, `<create-subscription>`, and `<copy-config>` from running to startup (§3.2.6).

## 7. Data

### 7.1 Reads

Every read prunes its tree with the session's read plan **after** `with-defaults` and **before** filtering, origin filters and `max-depth`. Filters then select only from what the user may read, as §3.2.4 requires, and subtree filters, XPath filters, content-match nodes and `with-defaults` need no NACM code of their own. Pruning comes after defaults because `report-all` would otherwise put back the default of a leaf the user can't read, which is both a leak and a wrong value (amended 2026-11-16; the original order put pruning first).

- **Where:** `Reader.retrieve()` is the single place, so `<get>`, `<get-config>` and `<get-data>` are covered. `<copy-config>` reads its source datastore through it too, except from running to startup (§3.2.6).
- **Copies:** the walk first finds the nodes to drop, visiting only mixed nodes. If there are none, the read keeps its tree. A tree built for this read (`owned`, such as `<get>`'s) has them removed in place. A snapshot that goes straight into the reply, with no filter, origin filter or `max-depth` after the prune, isn't copied either: @node-net/yang's `encodeXml` leaves the dropped nodes out as it writes (its `skip` option). Otherwise a snapshot is copied with `pruneTree`, and the copy is owned, as it is for `<copy-config>`'s source.
- **Read hooks:** a provider whose whole subtree the plan denies isn't refreshed for that read. This saves backend work and stops a read hook from running on behalf of a user who can't see its result.
- **Monitoring, the YANG library and server state** are ordinary data. `/nacm` itself is `default-deny-all` in its module, so only a permitting rule or a recovery session can read the policy.

### 7.2 Writes

Writes are checked on the **changes they make**, not on the edit as sent. The writer already diffs old and new trees for providers (`diffTrees`), and RFC 8341 asks for exactly that set:

- **`<commit>`** (§3.2.8): "only check create, update, and delete access permissions for this set of nodes".
- **`<edit-config>` and `<edit-data>`** (§3.2.5): unaltered nodes in a merge or replace need no access. Nodes with effective operation `none` need none either.
- **`<copy-config>`** (§3.2.6): "the client needs access to the modified nodes".

**Mapping changes to access.** A diff `create` needs create access, `delete` needs delete, and `replace` and `move` need update. A created or deleted subtree is checked at its root and at every node inside it where a rule or `default-deny-*` statement could decide differently. That set comes from the compiled policy, so the walk doesn't visit every node.

**Where.** The check runs in the writer after the edit is applied and validated and before providers' `prepare`. A denial is just another refusal at that point, so nothing reaches a backend. It runs on the target datastore's diff:

- a candidate edit is checked against the candidate's change;
- a commit is checked against running's change, so the committing user needs rights to everything the commit changes, whoever edited the candidate;
- a confirmed-commit rollback on timeout, and `<cancel-commit>`, are server undo and aren't checked.

**Reply.** One `access-denied` error, error-type `application`, for the first denied node in document order. Its error-path is that node's path if the user can read it, or the deepest ancestor they can read if not. `denied-data-writes` is counted once per refused operation.

**error-option.** A denied write fails the whole operation whatever the `<error-option>`, including `continue-on-error`. Access is checked on the result, not node by node. Skipping denied nodes would need the edit replayed without them, which is a second, subtler write semantics for little gain. netopeer2 also refuses the whole edit.

**One known deviation.** §3.2.5 says nodes changed implicitly, by a `when` turning false or by another case of a `choice` being chosen, need no access. A diff can't tell those changes from explicit ones, so they are checked too. The result is stricter, never more permissive, and the case is rare. If it matters, @node-net/yang's `applyEdit` can report which changes it made implicitly, and the writer can skip them. This is recorded with the interop allowlist entries.

**As built in NACM-3:** src/nacm/write-check.ts.

- **The check.** `firstDeniedWrite(subject, changes)` walks diffTrees' changes in order. A `replace` or `move` is decided at its node. A `create` or `delete` is decided at its root, then inside only at decision points. A decision point is a node with a `default-deny-*` statement, a node that an applicable rule's path names for that access, or, when some rule names a module, a node in a different module from its parent. Only those can decide differently from their parent. The walk goes down only into schema subtrees that contain one. The points are memoised per schema node and cached by the session's rule-lists, as the read plan is.
- **The cross-check.** A test crosses 14 policies with created and deleted trees and compares the answer with a check of every node (test/nacm-08-write-check.test.ts).
- **Non-presence containers.** A non-presence container's own creation or deletion needs no access: its children are checked in its place (section 12, amendment 9).
- **Where it runs.** The writer runs it with the dispatcher's subject, the rules in effect when the message was taken. That holds for edits to running and the candidate, for every `<test-option>` including `test-only`, for `<commit>` against running's change, and for `<copy-config>` against the target's change.
  - The check comes after `tryApplyEdit` and validation, so a refused edit that also has a validation error reports the validation error. That is the order this section gives.
  - Under `stop-on-error`, an edit that fails before anything is applied is refused for that failure, with no access check.
  - Calls that pass no subject aren't checked. These are rollback, `<cancel-commit>`, `<discard-changes>`, `<delete-config>`, `applyExternal`, provider start-up, `server.control` reset and restore, recovery sessions, and `<copy-config>` from running to startup.
  - `<edit-config>` and `<edit-data>` can't write startup on this server, so startup is written, and checked, only through `<copy-config>`.
- **The reply.** The writer's error-path names the refused node. The dispatcher's error sanitiser (section 7.3) cuts it back to a readable ancestor and makes the message generic when the user can't read it. There is no second cut in the writer.
- **Reporting.** The server counts `denied-data-writes`, logs at info with the access, path, rule and step, and emits `accessDenied` with kind `write` and the path.
- **A consequence.** `<copy-config>` from running to the candidate or startup by a user who can't read `/nacm` would delete `/nacm` from the target, which `default-deny-all` refuses. Such a user can only copy from running to startup.

### 7.3 Errors don't leak

§3.4.3 says an rpc-error must not include "any information the client is not allowed to read", and §3.2.5 says the same for edits. Validation errors are the risk: a `must`, `unique`, leafref or `mandatory` failure can name a node the user can't read.

So every reply's rpc-errors pass through a filter when NACM is enforced and the session isn't a recovery session:

- an `error-path` pointing at a node the user can't read is cut back to the deepest readable ancestor;
- the `error-message` of such an error is replaced with a generic one for its error-tag;
- `error-info` entries naming the node (`bad-element`, @node-net/yang's issue details) are dropped.

The error-tag and error-app-tag stay, so a client still learns the kind of failure. That `data-exists` on a create reveals that an unreadable node exists is inherent to NETCONF. RFC 8341 accepts it, and so does this design.

## 8. Notifications

The bus (notify/bus.ts) checks each notification per subscription before its filter, with the policy of the running snapshot at publish time:

- a top-level notification needs read access to its type (§3.4.6);
- a nested notification also needs read access to every ancestor instance;
- `<replayComplete>` and `<notificationComplete>` always pass;
- a dropped notification counts in `denied-notifications`.

**`<netconf-config-change>`** is the one notification that carries other data's paths: each `edit` names a changed node. RFC 8341 lets a user who may receive a notification type read all its content, which would tell a user the paths of configuration they can't read. This design goes further than the RFC: **`edit` entries whose target the user can't read are dropped**, and a notification left with none isn't sent. This is a per-subscription copy of an already-built notification. The server builds the notification, so this needs no general "content rules", which RFC 8341 leaves out of scope.

Subscribed notifications and YANG-Push (RFC 8639/8641) will reuse this: the same type check, and for on-change and periodic updates, the read plan on the pushed data.

**As built in NACM-4:** src/nacm/notify-check.ts, called by the bus (src/notify/bus.ts) through a `NotificationGuard` that server.ts gives it only when the device enforces NACM.

- **The subject.** For each subscription, the session's view of the policy in running when `publish()` runs, so a change to `/nacm` applies from the next notification. A recovery session, or `enable-nacm` false, sends everything unchanged, as does a device without the module (no guard).
- **The type check.** A top-level notification goes through `decideNotification` (§3.4.6 steps 1–11, so `<replayComplete>` and `<notificationComplete>` pass at step 3). A nested notification is checked for read access at each instance from the top down, the notification included, each on its own: as for reads, a rule permitting the notification doesn't reach past an ancestor the user can't read.
- **Order.** Access, then the config-change cut, then the subscription's filter on what's left, then encoding. A filter can't select what the user may not read.
- **`<netconf-config-change>`.** Each `edit/target` is an instance-identifier @node-net/yang has already resolved to schema nodes and key values. It is readable when every node on it is, which is how the error sanitiser decides. With nothing to drop, the notification goes as built. With some edits to drop, a `pruneTree` copy without them goes. With every edit dropped, nothing is sent. One without an edit list (past 1000 changes, RFC 6470 §2.1.1) names no data and goes on its type alone.
- **Sharing.** One `NotificationCheck` per published notification caches the answer, and any copy, by the session's rule-lists (the engine caches those per policy and group set). Subscribers in the same groups share one copy and one encoding, and no notification is rebuilt per session.
- **Reporting.** A notification refused on its type counts once per subscription in `denied-notifications`, raises `accessDenied` with kind `notification`, the notification's name as `operation` and, for a nested one, its data path, and is logged at info with the rule and step. A config-change withheld because every edit was dropped isn't a denial of its type: it isn't counted, and is logged at debug.
- **For RFC 8639/8641.** `notificationAccess(subject, tree)` is the function their subscriptions call for each event; YANG-Push updates take the session's read plan (read-plan.ts) on the data they carry. The module's header says so.

## 9. State and observability

- **Counters:** `/nacm/denied-operations`, `denied-data-writes` and `denied-notifications` are state the server produces, merged into `<operational>` as monitoring is. They start at zero when the server starts, as their `zero-based-counter32` type expects.
- **Events:** an `accessDenied` event (`{ sessionId, username, kind: 'operation' | 'write' | 'notification' | 'action', operation?, path? }`) lets embedders audit. It only reports, like the other events.
- **Logging:** each denial is logged at info with the session context. The path is logged in full, because logs aren't the client.

## 10. Configuration surface

The library adds one option:

```ts
const server = await createServer({
  device,
  nacm: { recovery: (p) => p.username === 'root' },
});
```

nncd's `server.json` adds:

```json
{ "nacm": { "recoveryUsers": ["root"] } }
```

`nncd --check` warns, and doesn't fail, when the device implements `ietf-netconf-acm` and no recovery user is named. That configuration is legal, but nobody can then repair the policy over NETCONF.

The policy itself goes in the device's initial `running` data, or over NETCONF afterwards. The `lab` devices get none, so they stay open.

## 11. Testing

1. **Engine unit tests,** table-driven, from RFC 8341 Appendix A's groups and its module, operation, data node and notification rules. Each row is a user, an access request and a verdict, and every step of §3.4.4–§3.4.6 has a row that reaches it.
2. **In-process tests** over `transport()`, one per operation family: reads pruned under each filter kind, writes per diff kind, commit by a user other than the candidate's editor, copy-config, actions, notifications including the config-change edit filter, error sanitising, recovery, `enable-nacm false`, policy changes taking effect on the next message, and the counters.
3. **Differential tests against netopeer2** (`test:interop`), as `admin` and as the TLS user `nn-guest` (who is in no group): the same reads, writes and denied operations against both. Known netopeer2 deviations go on the allowlist: its operation error-path is `/ietf-netconf:<op>` rather than `/nc:rpc/nc:<op>`, and `nn-guest` can write `/nacm` there. That second one is never probed, because it changes the shared server.

   **As built in NACM-4:** test/interop/nacm.test.ts. This server loads netopeer2's ietf-interfaces, iana-if-type, ietf-truststore and ietf-crypto-types through `<get-schema>`, with the features its YANG library lists, and copies netopeer2's `/nacm`, truststore and interfaces into running. `admin` is netopeer2's `netconf` user over SSH (group nn-admin, permit-all). `nn-guest` connects with the test-only guest.pem over TLS. In process, both are `transport()` sessions with the same usernames.
   - **Compared:** each user's reads of `/nacm` (empty for the guest), interfaces and the truststore; writes by the guest that write-default permits, a guest write to the truststore that its `nacm:default-deny-write` refuses, and the same write by admin, compared by error-tags and the resulting configuration; kill-session and delete-config refused for the guest; admin's kill-session not refused for access.
   - **Error-type.** netopeer2 gives a refused write error-type `protocol`. RFC 8341 and this server give `application`, so writes are compared by error-tag.
   - **Allowlisted, each a test of its own:** the operation error-path; and `<netconf-config-change>` filtering. For that, admin edits an interface and adds an empty `/nacm` group in one edit while the guest is subscribed: netopeer2 sends the guest the `/nacm` edits and this server doesn't. The group is removed in the same test and in `afterAll`, and the guest never writes `/nacm`.
   - **The implicit-change deviation** (section 7.2) has no case: neither module has a `when` or `choice` an edit could flip. It stays recorded beside the writes allowlist (test/interop/writes.test.ts).
4. **Benchmark:** a 100k-node read (scripts/nacm-read-bench.mjs; the package had a 100k-node load test but no read benchmark), with a typical policy (read permitted, two denied subtrees, one keyed rule). The target is under 15% overhead, and none with an empty policy. Measured on 2026-11-16 (medians of 25): `<get-config>` +0.6% with an empty policy and +7.1% with the typical one, `<get>` +1.7% and +4.8%.

## 12. Decisions

Agreed on 2026-11-15, each as recommended in review:

1. **Enforcement switch.** Implementing `ietf-netconf-acm` turns it on (section 3). Rejected: an explicit `nacm.enabled` option, which would be a second switch alongside `enable-nacm`.
2. **Write checks on the diff** (section 7.2), with the implicit-change deviation. Rejected: walking the edit's effective operations. That is closer to §3.2.5's letter, but it doesn't cover `<commit>` or `<copy-config>` and so needs the diff anyway.
3. **Filtering `<netconf-config-change>` edits** by read access (section 8), which is stricter than RFC 8341.
4. **No implicit recovery for in-process sessions** (section 4). Rejected: making `transport()` sessions recovery by default, which is easier for tests but means NACM tests have to opt in.
5. **A denied write fails the whole operation** under every `<error-option>` (section 7.2).

Amended on 2026-11-16, while NACM-2 was built:

6. **The root plan.** `/nacm` is `default-deny-all` in its own module, so a device that enforces never has an "everything permitted" root. The plan is "permitted except the `default-deny-all` subtrees", and reads that drop nothing, or that drop from a tree built for them, copy nothing (sections 5 and 7.1).
7. **Pruning after `with-defaults`** (section 7.1), so that `report-all` can't put back a denied leaf's default.
8. **Skipping at encode** (section 7.1). Copying a 100k-node snapshot to drop one keyed entry cost `<get-config>` 25% in the benchmark. Leaving the dropped nodes out as the reply is encoded costs 7%. Rejected: sharing unchanged subtrees between the snapshot and the pruned tree. It would be cheaper, but shared nodes keep parent pointers into the snapshot, and later steps that change the reply tree could change the snapshot.

Amended on 2026-11-16, while NACM-3 was built:

9. **Non-presence containers need no write access of their own** (section 7.2). Such a container has no meaning of its own (RFC 7950 §7.5.1): it appears with its first child and goes with its last. diffTrees reports that as a `create` or `delete` of the container. Checking it would make creating the first entry under an empty `/top` need create access to `/top`, and emptying it would need delete access. So the check skips the container and checks its children in its place, at a change's root and inside created and deleted subtrees. The result is never more permissive than checking the children.
10. **The sysrepo-netopeer2 device's `admin` group gets a permit-all rule-list** (section 3). Its `/nacm` named the group but had no rules, so with write-default deny even `admin` could write nothing. netopeer2's own set-up (scripts/netopeer2.sh) gives its user the same rule.

## 13. Delivery

Four changes, each usable on its own:

| Change | Contents |
|---|---|
| NACM-1 Engine and operations | src/nacm/ compile, cache and decide; the dispatcher check; recovery (library and nncd); counters; `accessDenied`; the control module's `default-deny-all`; engine unit tests |
| NACM-2 Reads | the read plan, @node-net/yang's `pruneTree` `keep` option, pruning in `Reader.retrieve`, read-hook skipping, error sanitising, the benchmark |
| NACM-3 Writes and actions | the diff check in the writer, error-paths, commit and copy-config, actions |
| NACM-4 Notifications and interop | the bus check, config-change filtering, the netopeer2 differential tests and allowlist |

Until NACM-3 lands, a device that implements the module would enforce operation and read access but not write access. So the enforcement switch (section 3) turns on only when NACM-3 lands. NACM-1 and NACM-2 are tested through an internal option.

**As built in NACM-4:** notifications (section 8) and the netopeer2 differential tests (section 11) complete the four changes. The full suites deferred by NACM-1 to NACM-3 (`npm run check`, `test:interop` and `check:full` with the Node 22/24/26 lines) ran once, for all four, before NACM-4 landed.

**As built in NACM-3:** enforcement is on. The internal option (src/nacm/gate.ts) is gone, and a device that implements `ietf-netconf-acm` enforces whenever `enable-nacm` is true. The tests that turned it off use `enable-nacm false` or a device without the module instead. Of the shipped devices only `sysrepo-netopeer2` implements the module, and no in-process test wrote to it. The full suites, interop and the Node matrix were deferred, by agreement, to one run after NACM-4.
