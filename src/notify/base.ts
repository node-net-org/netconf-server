/**
 * The RFC 6470 base notifications the server generates (NOTIF-03), as
 * RFC 7951 JSON content for @node-net/yang to decode and validate: what changed
 * running, sessions starting and ending, and the steps of a confirmed
 * commit.
 */

import type { DataChange, JsonValue } from '@node-net/yang/core';
import type { CommitEvent, ConfirmedCommitEvent } from '../datastore/writer.js';
import type { SessionEndReason } from '../session/session.js';

const NCN = 'ietf-netconf-notifications';
export const CONFIG_CHANGE = `/${NCN}:netconf-config-change`;
export const SESSION_START = `/${NCN}:netconf-session-start`;
export const SESSION_END = `/${NCN}:netconf-session-end`;
export const CONFIRMED_COMMIT = `/${NCN}:netconf-confirmed-commit`;

/** Past this many changes, netconf-config-change omits its edit list, as RFC 6470 §2.1.1 allows. */
export const MAX_EDITS = 1000;

/** A session as RFC 6470's common-session-parms describe it. */
export interface SessionParms {
  readonly username: string;
  readonly sessionId: number;
  readonly sourceHost: string | undefined;
}

function sessionParms(s: SessionParms): Record<string, JsonValue> {
  return { username: s.username, 'session-id': s.sessionId, ...(s.sourceHost === undefined ? {} : { 'source-host': s.sourceHost }) };
}

/**
 * netconf-config-change for a change to running: changed-by is the session
 * whose operation made it, or the server for a change from outside NETCONF,
 * a confirmed commit's timeout, a provider adopting its backend, or a reset.
 */
export function configChange(event: CommitEvent, session: SessionParms | undefined): Record<string, JsonValue> {
  return {
    'changed-by': session === undefined ? { server: [null] } : sessionParms(session),
    datastore: event.datastore,
    ...(event.changes.length > MAX_EDITS ? {} : { edit: event.changes.flatMap(edit) }),
  };
}

/** One edit entry: the changed node and the NETCONF operation that made the change. */
function edit(c: DataChange): JsonValue[] {
  switch (c.operation) {
    case 'create':
    case 'delete':
    case 'replace':
      return [{ target: c.path, operation: c.operation }];
    case 'move':
      return [{ target: c.path, operation: 'merge' }];
    default:
      // An origin change is not a change to configuration.
      return [];
  }
}

export function sessionStart(s: SessionParms): Record<string, JsonValue> {
  return sessionParms(s);
}

/** RFC 6470's termination-reason for how a session ended. */
export function terminationReason(reason: SessionEndReason): string {
  switch (reason) {
    case 'closed':
    case 'killed':
    case 'dropped':
      return reason;
    case 'protocol-error':
      return 'other';
  }
}

export function sessionEnd(s: SessionParms, reason: SessionEndReason, killedBy: number | undefined): Record<string, JsonValue> {
  return { ...sessionParms(s), ...(killedBy === undefined ? {} : { 'killed-by': killedBy }), 'termination-reason': terminationReason(reason) };
}

export function confirmedCommit(e: ConfirmedCommitEvent, session: SessionParms | undefined): Record<string, JsonValue> {
  return {
    ...(e.event === 'timeout' || session === undefined ? {} : sessionParms(session)),
    'confirm-event': e.event,
    ...(e.timeout === undefined ? {} : { timeout: e.timeout }),
  };
}
