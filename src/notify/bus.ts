/**
 * Event notifications (RFC 5277, NOTIF-01, NOTIF-02): subscriptions to the
 * NETCONF stream, and the delivery of each notification to every session
 * whose subscription's filter selects it. Publishing is synchronous, so the
 * notifications of one caller reach each subscriber in the order they were
 * published.
 */

import { NOTIFICATION_NS, XmlElement, type Logger } from '@node-net/netconf/core';
import { encodeXml, type DataTree } from '@node-net/yang/core';
import { NotificationCheck, type NotificationAccess } from '../nacm/notify-check.js';
import type { Subject } from '../nacm/decide.js';
import type { Filter, Reader } from '../rpc/reads.js';
import { toElement } from '../rpc/xml.js';
import type { ServerSession } from '../session/session.js';

/** The one stream the server has (RFC 5277 §3.2.3). */
export const NETCONF_STREAM = 'NETCONF';

interface Subscription {
  readonly session: ServerSession;
  readonly filter: Filter | undefined;
}

/**
 * NACM's part in delivery (NACM design §8): the session's view of the
 * policy in running when a notification is published, and what to do when
 * it may not receive one.
 */
export interface NotificationGuard {
  /** undefined when access isn't checked for this session. */
  subject(session: ServerSession): Subject | undefined;
  /** A notification not sent to a subscription because its type was denied. */
  denied(session: ServerSession, denial: Extract<NotificationAccess, { action: 'deny' }>): void;
}

export class NotificationBus {
  readonly #subscriptions = new Map<number, Subscription>();

  constructor(
    private readonly reader: Reader,
    private readonly logger: Logger,
    private readonly guard?: NotificationGuard,
  ) {}

  /** Whether a session has a subscription. */
  has(sessionId: number): boolean {
    return this.#subscriptions.has(sessionId);
  }

  get size(): number {
    return this.#subscriptions.size;
  }

  subscribe(session: ServerSession, filter: Filter | undefined): void {
    this.#subscriptions.set(session.id, { session, filter });
  }

  /** A session ended: its subscription goes with it. */
  sessionEnded(sessionId: number): void {
    this.#subscriptions.delete(sessionId);
  }

  /**
   * Sends a notification (a validated @node-net/yang notification tree) to every
   * subscription that may receive it and whose filter selects it. Access is
   * checked first, with the policy in running now, so a filter selects only
   * from what the subscriber may read (NACM design §8).
   */
  publish(tree: DataTree, eventTime: number): void {
    if (this.#subscriptions.size === 0) return;
    const guard = this.guard;
    const check = guard === undefined ? undefined : new NotificationCheck(tree);
    const elements = new Map<DataTree, XmlElement>();
    for (const { session, filter } of [...this.#subscriptions.values()]) {
      let sent = tree;
      if (guard !== undefined && check !== undefined) {
        const access = check.access(guard.subject(session));
        if (access.action === 'deny') {
          guard.denied(session, access);
          continue;
        }
        if (access.action === 'suppress') {
          this.logger.debug?.('A netconf-config-change named only data the subscriber may not read: not sent', { sessionId: session.id });
          continue;
        }
        sent = access.tree;
      }
      if (filter !== undefined && !this.#selects(sent, filter, session.id)) continue;
      let element = elements.get(sent);
      if (element === undefined) elements.set(sent, (element = notificationElement(sent, eventTime)));
      session.notify(element);
    }
  }

  /** Whether a filter selects anything of the notification (RFC 5277 §3.6). */
  #selects(tree: DataTree, filter: Filter, sessionId: number): boolean {
    try {
      return this.reader.filter(tree, filter).children.length > 0;
    } catch (err) {
      // An XPath filter that fails on this notification selects nothing.
      this.logger.debug?.('A subscription filter failed on a notification', { sessionId, error: (err as Error).message });
      return false;
    }
  }
}

/** `<notification>` with its eventTime (RFC 5277 §4) and content. */
export function notificationElement(tree: DataTree, eventTime: number): XmlElement {
  return new XmlElement({
    name: 'notification',
    ns: NOTIFICATION_NS,
    children: [new XmlElement({ name: 'eventTime', ns: NOTIFICATION_NS, children: [dateTime(eventTime)] }), ...encodeXml(tree).map(toElement)],
  });
}

/** RFC 3339 date-time, in UTC. */
export function dateTime(ms: number): string {
  return new Date(ms).toISOString();
}
