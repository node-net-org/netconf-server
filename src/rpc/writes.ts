/**
 * The write operations (RFC 6241 §7.2–7.6, §8.3–8.4, §8.6; RFC 8526 §3.1.2):
 * `<edit-config>`, `<edit-data>`, `<copy-config>`, `<delete-config>`,
 * `<validate>`, `<lock>`, `<unlock>`, `<commit>`, `<discard-changes>` and
 * `<cancel-commit>`. This module reads the parameters and decodes content;
 * the Writer (datastore/writer.ts) does the writing.
 */

import { DATASTORES_NS, NETCONF_NS, NMDA_NS, type XmlElement } from '@node-net/netconf/core';
import type { DataTree} from '@node-net/yang/core';
import { decodeXml, YangDataError, type ErrorOption } from '@node-net/yang/core';
import type { ConfigDatastore, Datastores } from '../datastore/datastores.js';
import type { LockableDatastore } from '../datastore/locks.js';
import type { TestOption, Writer } from '../datastore/writer.js';
import type { Device } from '../device/load.js';
import type { ServerSession } from '../session/session.js';
import { issueErrors } from './data-errors.js';
import type { Dispatcher } from './dispatch.js';
import { operationFailed, operationNotSupported, RpcFailure, rpcErrorElement } from './errors.js';
import { configRef, contentOf, identityName, invalid, required } from './params.js';
import { Reader } from './reads.js';

const DEFAULT_CONFIRM_TIMEOUT = 600;

export function registerWriteOperations(dispatcher: Dispatcher, device: Device, datastores: Datastores, writer: Writer): void {
  const p = device.protocol;
  const schema = device.schema;

  /** Content decoded for a datastore: an edit (with operations) or a whole configuration. */
  const decode = (element: XmlElement, datastore: ConfigDatastore, edit: boolean): DataTree => {
    try {
      return decodeXml(schema.forDatastore(datastore), contentOf(element), { edit });
    } catch (err) {
      if (err instanceof YangDataError) throw new RpcFailure(issueErrors(err.issues, schema));
      throw err;
    }
  };

  /** A datastore an edit or copy may write. */
  const writable = (name: string, element: string, operation: string): 'running' | 'candidate' | 'startup' => {
    if (name === 'running') {
      if (!p.writableRunning) {
        throw new RpcFailure({ ...operationNotSupported(operation), message: `The device does not have :writable-running, so ${operation} can't write running` });
      }
      return 'running';
    }
    if ((name === 'candidate' || name === 'startup') && datastores.has(name)) return name;
    throw invalid(`The device has no writable datastore ${name}`, element);
  };

  /** A configuration datastore the device has, for reading as a source. */
  const readable = (name: string, element: string): 'running' | 'candidate' | 'startup' => {
    if ((name === 'running' || name === 'candidate' || name === 'startup') && datastores.has(name)) return name;
    throw invalid(`The device has no datastore ${name}`, element);
  };

  /** Replies to an edit: ok, or the errors of the parts that failed. */
  const editReply = (errors: Awaited<ReturnType<Writer['edit']>>): 'ok' | XmlElement[] =>
    errors.length === 0 ? 'ok' : issueErrors(errors, schema).map(rpcErrorElement);

  dispatcher.handle(NETCONF_NS, 'edit-config', async ({ operation, session, access }) => {
    const ref = configRef(operation, 'target');
    if (ref.kind !== 'datastore') throw invalid('edit-config writes to a datastore', 'target');
    const target = writable(ref.name, ref.name, 'edit-config');
    if (target === 'startup') throw invalid('edit-config cannot write startup', 'startup');
    const config = editContent(operation, NETCONF_NS);
    const errors = await writer.edit({
      target,
      edit: decode(config, target, true),
      sessionId: session.id,
      defaultOperation: defaultOperation(operation.child('default-operation', NETCONF_NS)),
      errorOption: errorOption(operation.child('error-option', NETCONF_NS), p.rollbackOnError),
      // The candidateUnvalidated quirk (netopeer2): candidate edits are checked at commit, not now.
      testOption: unvalidated(target, session, testOption(operation.child('test-option', NETCONF_NS))),
      access,
    });
    return editReply(errors);
  });

  // RFC 8526 §3.1.2: no error-option or test-option; the edit applies whole or not at all.
  dispatcher.handle(NMDA_NS, 'edit-data', async ({ operation, session, access }) => {
    const dsElement = required(operation, 'datastore', NMDA_NS);
    const name = identityName(dsElement, DATASTORES_NS);
    if (name !== 'running' && name !== 'candidate') throw invalid(`edit-data cannot write ${dsElement.text().trim()}`, 'datastore');
    const target = writable(name, 'datastore', 'edit-data') as 'running' | 'candidate';
    const config = editContent(operation, NMDA_NS);
    const errors = await writer.edit({
      target,
      edit: decode(config, target, true),
      sessionId: session.id,
      defaultOperation: defaultOperation(operation.child('default-operation', NMDA_NS)),
      errorOption: 'rollback-on-error',
      testOption: unvalidated(target, session, 'test-then-set'),
      access,
    });
    return editReply(errors);
  });

  dispatcher.handle(NETCONF_NS, 'validate', ({ operation }) => {
    const ref = configRef(operation, 'source');
    const tree = ref.kind === 'config' ? decode(ref.element, 'running', false) : datastores.config(readable(ref.kind === 'datastore' ? ref.name : '', 'source'));
    writer.validate(tree);
    return 'ok' as const;
  });

  const reader = new Reader(device, datastores);

  dispatcher.handle(NETCONF_NS, 'copy-config', async ({ operation, session, access }) => {
    const targetRef = configRef(operation, 'target');
    const sourceRef = configRef(operation, 'source');
    if (targetRef.kind !== 'datastore') throw invalid('copy-config copies to a datastore', 'target');
    const target = writable(targetRef.name, targetRef.name, 'copy-config');
    let tree: DataTree;
    // RFC 8341 §3.2.6: from running to startup needs only exec access; any other copy is checked on the nodes it changes.
    let checked = access;
    if (sourceRef.kind === 'config') tree = decode(sourceRef.element, target, false);
    else {
      const source = readable(sourceRef.kind === 'datastore' ? sourceRef.name : '', 'source');
      if (source === target) throw invalid('copy-config needs different source and target datastores', 'target');
      if (source === 'running' && target === 'startup') checked = undefined;
      // What the user may not read is left out of the copy (§3.2.6).
      tree = reader.retrieve({ tree: datastores.config(source), owned: false, plan: checked === undefined ? undefined : reader.plan(checked) });
    }
    await writer.copy(target, tree, session.id, checked);
    return 'ok' as const;
  });

  dispatcher.handle(NETCONF_NS, 'delete-config', async ({ operation, session }) => {
    const ref = configRef(operation, 'target');
    if (ref.kind === 'datastore' && ref.name === 'running') throw new RpcFailure(operationFailed('The running datastore cannot be deleted', 'protocol'));
    if (ref.kind !== 'datastore' || ref.name !== 'startup' || !datastores.has('startup')) throw invalid('delete-config deletes the startup datastore', 'target');
    await writer.deleteStartup(session.id);
    return 'ok' as const;
  });

  const lockTarget = (operation: XmlElement): LockableDatastore => {
    const ref = configRef(operation, 'target');
    if (ref.kind !== 'datastore') throw invalid(`${operation.name} takes a datastore`, 'target');
    return readable(ref.name, ref.name);
  };

  dispatcher.handle(NETCONF_NS, 'lock', ({ operation, session }) => {
    writer.lock(lockTarget(operation), session.id);
    return 'ok' as const;
  });

  dispatcher.handle(NETCONF_NS, 'unlock', ({ operation, session }) => {
    writer.unlock(lockTarget(operation), session.id);
    return 'ok' as const;
  });

  dispatcher.handle(NETCONF_NS, 'commit', async ({ operation, session, access }) => {
    const confirmed = operation.child('confirmed', NETCONF_NS) !== undefined;
    const timeoutText = operation.child('confirm-timeout', NETCONF_NS)?.text().trim();
    let timeout = DEFAULT_CONFIRM_TIMEOUT;
    if (timeoutText !== undefined) {
      timeout = /^[0-9]{1,10}$/.test(timeoutText) ? Number(timeoutText) : NaN;
      if (!(timeout >= 1 && timeout <= 4294967295)) throw invalid('confirm-timeout is 1 to 4294967295 seconds', 'confirm-timeout');
    }
    const persist = operation.child('persist', NETCONF_NS)?.text();
    if (!confirmed && (timeoutText !== undefined || persist !== undefined)) {
      throw invalid('confirm-timeout and persist go with confirmed', timeoutText !== undefined ? 'confirm-timeout' : 'persist');
    }
    await writer.commit({ sessionId: session.id, confirmed, timeout, persist, persistId: operation.child('persist-id', NETCONF_NS)?.text(), access });
    return 'ok' as const;
  });

  dispatcher.handle(NETCONF_NS, 'discard-changes', async ({ session }) => {
    await writer.discard(session.id);
    return 'ok' as const;
  });

  dispatcher.handle(NETCONF_NS, 'cancel-commit', async ({ operation, session }) => {
    await writer.cancelCommit(session.id, operation.child('persist-id', NETCONF_NS)?.text());
    return 'ok' as const;
  });
}

/** An edit's `<config>`; a `<url>` gets operation-not-supported. */
function editContent(operation: XmlElement, ns: string): XmlElement {
  if (operation.child('url', ns) !== undefined) throw new RpcFailure({ ...operationNotSupported('url'), message: 'The :url capability is not implemented' });
  return required(operation, 'config', ns);
}

function defaultOperation(element: XmlElement | undefined): 'merge' | 'replace' | 'none' {
  const value = element?.text().trim() ?? 'merge';
  if (value !== 'merge' && value !== 'replace' && value !== 'none') throw invalid(`default-operation ${JSON.stringify(value)} is not merge, replace or none`, 'default-operation');
  return value;
}

function errorOption(element: XmlElement | undefined, rollback: boolean): ErrorOption {
  const value = element?.text().trim() ?? 'stop-on-error';
  if (value === 'rollback-on-error' && !rollback) throw invalid('rollback-on-error needs the :rollback-on-error capability, which the device does not have', 'error-option');
  if (value !== 'stop-on-error' && value !== 'continue-on-error' && value !== 'rollback-on-error') {
    throw invalid(`error-option ${JSON.stringify(value)} is not stop-on-error, continue-on-error or rollback-on-error`, 'error-option');
  }
  return value;
}

/** test-then-set becomes set for the candidate under the candidateUnvalidated quirk; the other options are as asked. */
function unvalidated(target: 'running' | 'candidate', session: ServerSession, option: TestOption): TestOption {
  return target === 'candidate' && option === 'test-then-set' && session.quirk('candidateUnvalidated') !== undefined ? 'set' : option;
}

function testOption(element: XmlElement | undefined): TestOption {
  const value = element?.text().trim() ?? 'test-then-set';
  if (value !== 'test-then-set' && value !== 'set' && value !== 'test-only') throw invalid(`test-option ${JSON.stringify(value)} is not test-then-set, set or test-only`, 'test-option');
  return value;
}
