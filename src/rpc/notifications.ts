/**
 * `<create-subscription>` (RFC 5277 §2.1.1, NOTIF-01) and the
 * `:interleave` rule (§6, NOTIF-02). The server keeps no notification log,
 * so replay (startTime) is not supported, and stopTime, which RFC 5277
 * allows only with startTime, is refused on its own with missing-element.
 */

import { NETCONF_NS, NOTIFICATION_NS } from '@node-net/netconf/core';
import { parseXPath } from '@node-net/yang/core';
import type { Device } from '../device/load.js';
import { NETCONF_STREAM, type NotificationBus } from '../notify/bus.js';
import type { Dispatcher } from './dispatch.js';
import { info, operationNotSupported, RpcFailure } from './errors.js';
import { invalid } from './params.js';
import type { Filter, Reader } from './reads.js';

export function registerNotificationOperations(dispatcher: Dispatcher, device: Device, reader: Reader, bus: NotificationBus): void {
  if (!device.protocol.notification) return;

  dispatcher.handle(NOTIFICATION_NS, 'create-subscription', ({ operation, session }) => {
    // RFC 5277 §2.1.1: one subscription per session.
    if (bus.has(session.id)) {
      throw new RpcFailure({ type: 'protocol', tag: 'in-use', message: 'This session already has a subscription' });
    }
    const stream = operation.child('stream', NOTIFICATION_NS)?.text().trim() ?? NETCONF_STREAM;
    if (stream !== NETCONF_STREAM) throw invalid(`The server has no stream ${JSON.stringify(stream)}; it has ${NETCONF_STREAM}`, 'stream');
    if (operation.child('startTime', NOTIFICATION_NS) !== undefined) {
      throw new RpcFailure({ ...operationNotSupported('startTime'), message: 'Replay is not supported: the server keeps no notification log' });
    }
    if (operation.child('stopTime', NOTIFICATION_NS) !== undefined) {
      // RFC 5277 §2.1.1: stopTime "must be used with" startTime, so startTime is the element missing (as netopeer2 answers too).
      throw new RpcFailure({ type: 'protocol', tag: 'missing-element', message: 'stopTime is only valid with startTime (RFC 5277 §2.1.1)', info: [info('bad-element', 'startTime')] });
    }
    const filter = subscriptionFilter(reader, operation.child('filter', NOTIFICATION_NS));
    bus.subscribe(session, filter);
    return 'ok';
  });

  // RFC 5277 §6: without :interleave, a subscribed session may only close.
  if (!device.protocol.interleave) {
    dispatcher.gate((session, operation) =>
      bus.has(session.id) && !(operation.name === 'close-session' && operation.ns === NETCONF_NS)
        ? { ...operationNotSupported(operation.name), message: 'The session has a subscription, and the server does not support :interleave' }
        : undefined,
    );
  }
}

/** A subscription's filter, checked: subtree, or XPath with a select that parses. */
function subscriptionFilter(reader: Reader, element: Parameters<Reader['netconfFilter']>[0]): Filter | undefined {
  const filter = reader.netconfFilter(element);
  if (filter?.kind === 'xpath') {
    try {
      parseXPath(filter.select);
    } catch (err) {
      throw invalid(`Invalid XPath filter: ${(err as Error).message}`, 'filter');
    }
  }
  return filter;
}
