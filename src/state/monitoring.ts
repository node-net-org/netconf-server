/**
 * NETCONF monitoring (RFC 6022, SCHEMA-03): the `netconf-state` container,
 * built from the server's live state each time it is read.
 */

import type { JsonValue } from '@node-net/yang/core';
import type { LockInfo } from '../datastore/locks.js';
import type { Device } from '../device/load.js';

/** The four per-session counters of RFC 6022, also kept server-wide. */
export interface RpcCounters {
  inRpcs: number;
  inBadRpcs: number;
  outRpcErrors: number;
  outNotifications: number;
}

export function newCounters(): RpcCounters {
  return { inRpcs: 0, inBadRpcs: 0, outRpcErrors: 0, outNotifications: 0 };
}

/** One open session, as monitoring reports it. */
export interface MonitoredSession {
  readonly id: number;
  readonly transport: string;
  readonly username: string;
  readonly sourceHost: string | undefined;
  /** Milliseconds since the epoch. */
  readonly loginTime: number;
  readonly counters: Readonly<RpcCounters>;
  /** Whether it is a NACM recovery session. */
  readonly recovery: boolean;
}

/** The server-wide statistics (RFC 6022 §2.1.5). */
export interface ServerStatistics extends RpcCounters {
  /** Milliseconds since the epoch. */
  readonly startTime: number;
  inBadHellos: number;
  inSessions: number;
  droppedSessions: number;
}

const NCM = 'ietf-netconf-monitoring';

/** `netconf-state` as RFC 7951 JSON members. */
export function monitoringJson(device: Device, sessions: readonly MonitoredSession[], stats: Readonly<ServerStatistics>, locks: readonly LockInfo[] = []): Record<string, JsonValue> {
  const p = device.protocol;
  const datastores = ['running', ...(p.candidate ? ['candidate'] : []), ...(p.startup ? ['startup'] : [])].map((name) => {
    const lock = locks.find((l) => l.datastore === name);
    // RFC 6022 §2.1.3: the global lock's holder and when it was taken.
    return lock === undefined ? { name } : { name, locks: { 'global-lock': { 'locked-by-session': lock.sessionId, 'locked-time': dateAndTime(lock.lockedAt) } } };
  });
  const schemas: JsonValue[] = [];
  for (const m of device.schema.allModules) {
    const entries = [{ name: m.name, revision: m.revision }, ...m.includes.map((s) => ({ name: s.name, revision: s.revision }))];
    for (const e of entries) {
      for (const format of ['yang', 'yin']) {
        schemas.push({ identifier: e.name, version: e.revision ?? '', format: `${NCM}:${format}`, namespace: m.namespace, location: ['NETCONF'] });
      }
    }
  }
  return {
    [`${NCM}:netconf-state`]: {
      capabilities: { capability: [...device.capabilities] },
      datastores: { datastore: datastores },
      schemas: { schema: schemas },
      sessions: {
        session: sessions.map((s) => ({
          'session-id': s.id,
          transport: transportIdentity(s.transport),
          username: s.username,
          ...(s.sourceHost === undefined ? {} : { 'source-host': s.sourceHost }),
          'login-time': dateAndTime(s.loginTime),
          ...countersJson(s.counters),
          'net-netconf-server-monitoring:recovery': s.recovery,
        })),
      },
      statistics: {
        'netconf-start-time': dateAndTime(stats.startTime),
        'in-bad-hellos': stats.inBadHellos,
        'in-sessions': stats.inSessions,
        'dropped-sessions': stats.droppedSessions,
        ...countersJson(stats),
      },
    },
  };
}

function countersJson(c: Readonly<RpcCounters>): Record<string, number> {
  return { 'in-rpcs': c.inRpcs, 'in-bad-rpcs': c.inBadRpcs, 'out-rpc-errors': c.outRpcErrors, 'out-notifications': c.outNotifications };
}

/** The transport identity: RFC 6022's for SSH and TLS, the server's own for anything else. */
function transportIdentity(transport: string): string {
  if (transport === 'ssh') return `${NCM}:netconf-ssh`;
  if (transport === 'tls') return `${NCM}:netconf-tls`;
  return 'net-netconf-server-monitoring:in-process';
}

/** yang:date-and-time, in UTC. */
function dateAndTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The registered providers (net-netconf-server-monitoring:providers), or nothing when there are none. */
export function providersJson(registrations: readonly { readonly path: string; readonly outOfSyncReason: string | undefined }[]): Record<string, JsonValue> {
  if (registrations.length === 0) return {};
  return {
    'net-netconf-server-monitoring:providers': {
      provider: registrations.map((r) => ({ path: r.path, 'out-of-sync': r.outOfSyncReason !== undefined, ...(r.outOfSyncReason === undefined ? {} : { reason: r.outOfSyncReason }) })),
    },
  };
}
