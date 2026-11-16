/**
 * The session operations of RFC 6241 §7.8 and §7.9: close-session and
 * kill-session.
 */

import { NETCONF_NS } from '@node-net/netconf/core';
import type { Clock } from '../clock.js';
import type { ServerSession } from '../session/session.js';
import type { Dispatcher } from './dispatch.js';
import { info, RpcFailure } from './errors.js';

/** What the session operations need from the server. */
export interface SessionRegistry {
  session(id: number): ServerSession | undefined;
  readonly clock: Clock;
}

export function registerSessionOperations(dispatcher: Dispatcher, sessions: SessionRegistry): void {
  // The reply goes first, then the connection closes (RFC 6241 §7.8).
  dispatcher.handle(NETCONF_NS, 'close-session', async ({ session }): Promise<'ok'> => {
    // The slowCloseSession quirk (design §13): the reply comes late, or never.
    const slow = session.quirk('slowCloseSession');
    if (slow !== undefined) {
      const delay = slow['delay'];
      await new Promise<void>((resolve) => {
        const timer = typeof delay === 'number' ? sessions.clock.setTimeout(resolve, delay) : undefined;
        session.signal.addEventListener('abort', () => {
          if (timer !== undefined) sessions.clock.clearTimeout(timer);
          resolve();
        });
      });
    }
    session.afterReply(() => session.end('closed'));
    return 'ok';
  });

  dispatcher.handle(NETCONF_NS, 'kill-session', ({ session, operation }) => {
    const text = operation.child('session-id', NETCONF_NS)?.text().trim();
    if (text === undefined) {
      throw new RpcFailure({ type: 'protocol', tag: 'missing-element', message: 'kill-session needs a session-id', info: [info('bad-element', 'session-id')] });
    }
    const id = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : NaN;
    // RFC 6241 §7.9: killing one's own session is invalid-value; so is a session that doesn't exist.
    if (id === session.id) {
      throw new RpcFailure({ type: 'protocol', tag: 'invalid-value', message: 'A session cannot kill itself; use close-session', info: [info('bad-element', 'session-id')] });
    }
    const victim = Number.isNaN(id) ? undefined : sessions.session(id);
    if (victim === undefined) {
      throw new RpcFailure({ type: 'protocol', tag: 'invalid-value', message: `No session ${text}`, info: [info('bad-element', 'session-id')] });
    }
    victim.end('killed', session.id);
    return 'ok';
  });
}
