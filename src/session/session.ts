/**
 * One NETCONF session, server side (RFC 6241 §8.1, RFC 6242): the hello
 * exchange, framing over @node-net/netconf's message channel, and a FIFO of
 * requests answered one at a time, so replies go out in the order the
 * requests arrived.
 *
 * Notifications (RFC 5277) go out between replies, never inside one: one
 * generated while a request is being answered waits until that reply has
 * been written. Quirks (design §13) and injected faults (CONTROL-03) change
 * what the session writes; a control session gets neither.
 */

import {
  CapabilitySet,
  FramingError,
  NETCONF_NS,
  openChannel,
  parseXml,
  redactXml,
  serializeXml,
  x,
  type BaseVersion,
  type Connection,
  type Logger,
  type MessageChannel,
  type NetconfError,
  type XmlElement,
} from '@node-net/netconf/core';
import type { Clock } from '../clock.js';
import type { FaultAction, FaultPoint } from '../control/faults.js';
import type { Device } from '../device/load.js';
import { brokenChunk, quirkReply, quirkText } from '../quirks/apply.js';
import type { ActiveQuirks, QuirkSettings } from '../quirks/catalogue.js';
import type { RpcErrorSpec } from '../rpc/errors.js';
import { newCounters, type RpcCounters } from '../state/monitoring.js';

/** Who a session is authenticated as (design §10). */
export interface Principal {
  readonly username: string;
  readonly groups?: readonly string[];
}

/** Why a session ended. */
export type SessionEndReason = 'closed' | 'killed' | 'dropped' | 'protocol-error';

/** What a session needs from its server. */
export interface SessionHost {
  readonly device: Device;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly helloTimeout: number;
  readonly maxMessageBytes: number | undefined;
  allocateSessionId(): number;
  /** Whether a session of this user is a control session: exempt from quirks and faults (CONTROL-08). */
  isControlUser(principal: Principal): boolean;
  /** Whether a session of this user is a NACM recovery session (RFC 8341 §3.3.3). */
  isRecovery(principal: Principal): boolean;
  /** The quirks a session opening now gets. */
  newSessionQuirks(): ActiveQuirks;
  /** A session's quirks now. */
  quirks(session: ServerSession): ActiveQuirks;
  /** Whether any fault is waiting, so a session need only look at a request's operation when one is. */
  hasFaults(): boolean;
  /** The fault that fires for the session at a point, if any; it counts as fired. */
  fault(session: ServerSession, point: FaultPoint): FaultAction | undefined;
  /** An rpc-reply to `request` carrying these errors (for injected rpc-errors and quirks). */
  errorReply(request: string, errors: readonly RpcErrorSpec[]): XmlElement;
  /** The hellos have been exchanged. */
  sessionStarted(session: ServerSession): void;
  /** The client's hello was refused (RFC 6022 in-bad-hellos). */
  badHello(session: ServerSession): void;
  /** The session is over. Called once; `version` is undefined when it ended before the hellos were exchanged. */
  sessionEnded(session: ServerSession, reason: SessionEndReason, killedBy: number | undefined): void;
  /** Answers one message: the reply to send, or undefined to send none. */
  answer(session: ServerSession, text: string): Promise<XmlElement | undefined>;
  /** A reply carrying rpc-errors was sent. */
  errorSent(session: ServerSession): void;
  /** A notification was sent. */
  notificationSent(session: ServerSession): void;
}

const MAX_SESSION_ID = 4294967295;

export class ServerSession {
  readonly id: number;
  /** When the session was opened, in milliseconds since the epoch. */
  readonly loginTime: number;
  /** RFC 6022's per-session counters. */
  readonly counters: RpcCounters = newCounters();
  /** Aborted when the session ends, so operations in progress stop. */
  readonly signal: AbortSignal;
  /** The quirks the session opened with (design §13). */
  readonly openedQuirks: ActiveQuirks;
  /** Whether NACM leaves the session unrestricted (RFC 8341 §3.3.3), decided when it starts. */
  readonly recovery: boolean;
  #exempt: boolean;
  #version: BaseVersion | undefined;
  #state: 'hello' | 'open' | 'ended' = 'hello';
  readonly #abort = new AbortController();
  readonly #channel: MessageChannel;
  #helloTimer: unknown;
  /** The tail of the request queue. */
  #queue: Promise<void> = Promise.resolve();
  /** Whether a request is being answered: notifications wait for its reply. */
  #busy = false;
  /** Requests received and not yet answered, for the noPipelining quirk. */
  #waiting = 0;
  /** Notifications waiting for the reply being answered. */
  #held: XmlElement[] = [];
  /** Run after the reply now being written has gone, such as closing for close-session. */
  #afterReply: (() => void) | undefined;

  constructor(
    connection: Connection,
    private readonly host: SessionHost,
    readonly principal: Principal,
    readonly transport: string,
    /** The client's address, when the transport knows it. */
    readonly sourceHost?: string,
  ) {
    this.id = host.allocateSessionId();
    this.loginTime = host.clock.now();
    this.signal = this.#abort.signal;
    this.#exempt = host.isControlUser(principal);
    this.recovery = host.isRecovery(principal);
    this.openedQuirks = this.#exempt ? new Map() : host.newSessionQuirks();
    this.#channel = openChannel(
      connection,
      {
        message: (text) => this.#onMessage(text),
        end: (reason) => this.#onChannelEnd(reason),
      },
      host.maxMessageBytes === undefined ? {} : { maxMessageBytes: host.maxMessageBytes },
    );
    const fault = host.hasFaults() ? host.fault(this, { kind: 'connect' }) : undefined;
    // RFC 6241 §8.1: each peer sends its hello at once, without waiting for the other's.
    if (fault?.kind !== 'no-hello') {
      this.#send(
        x('hello', { xmlns: NETCONF_NS },
          x('capabilities', host.device.capabilities.map((c) => x('capability', c))),
          x('session-id', String(this.id)),
        ),
      );
    }
    this.#helloTimer = host.clock.setTimeout(() => {
      this.#log('debug', 'No client hello in time');
      this.end('protocol-error');
    }, host.helloTimeout);
  }

  /** The base version agreed in the hellos, once they're exchanged. */
  get version(): BaseVersion | undefined {
    return this.#version;
  }

  get ended(): boolean {
    return this.#state === 'ended';
  }

  /** Whether the session is exempt from quirks and faults (a control session, CONTROL-08). */
  get exempt(): boolean {
    return this.#exempt;
  }

  /** Makes the session a control session from now on. */
  makeExempt(): void {
    this.#exempt = true;
  }

  /** A quirk's settings when it is in force for this session now. */
  quirk(name: string): QuirkSettings | undefined {
    return this.#exempt ? undefined : this.host.quirks(this).get(name);
  }

  /** Resolves once every request received so far has been answered. */
  settled(): Promise<void> {
    return this.#queue.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Run `fn` once the reply now being answered has been written. */
  afterReply(fn: () => void): void {
    this.#afterReply = fn;
  }

  /**
   * Send a notification (RFC 5277 §4): now, or after the reply being
   * answered, so it never lands inside one. Ignored once the session ended.
   */
  notify(notification: XmlElement): void {
    if (this.#state !== 'open') return;
    if (this.#busy) this.#held.push(notification);
    else this.#sendNotification(notification);
  }

  /** Apply a fault at once (an `immediate` trigger, CONTROL-03). */
  applyFault(action: FaultAction): void {
    if (this.#state === 'ended') return;
    switch (action.kind) {
      case 'drop':
        this.#drop();
        return;
      case 'unsolicited':
        for (const m of action.messages) this.#sendText(m);
        return;
      case 'raw-bytes':
        this.#channel.write(action.bytes);
        return;
      default:
        // The others act on a request; at once they mean nothing.
        return;
    }
  }

  /**
   * End the session: abort what it has in progress and close its
   * connection. Idempotent.
   */
  end(reason: SessionEndReason, killedBy?: number): void {
    if (this.#state === 'ended') return;
    this.#state = 'ended';
    this.#held = [];
    this.host.clock.clearTimeout(this.#helloTimer);
    this.#abort.abort(new Error(`Session ${this.id} ended: ${reason}`));
    if (reason === 'protocol-error' || reason === 'killed') this.#channel.destroy();
    else void this.#channel.close();
    this.host.sessionEnded(this, reason, killedBy);
  }

  #onMessage(text: string): void {
    if (this.#state === 'ended') return;
    if (this.host.logger.trace !== undefined) this.#trace('Received', text);
    if (this.#state === 'hello') {
      this.#onHello(text);
      return;
    }
    // The noPipelining quirk: a request that arrives while another is answered is refused at once.
    if (this.#waiting > 0 && this.quirk('noPipelining') !== undefined) {
      this.#sendReply(this.host.errorReply(text, [{ type: 'application', tag: 'operation-failed', message: 'Another request is being processed' }]));
      return;
    }
    this.#waiting++;
    this.#queue = this.#queue.then(() => this.#process(text));
  }

  #onHello(text: string): void {
    const fail = (why: string): void => {
      this.#log('debug', `Bad client hello: ${why}`);
      this.host.badHello(this);
      this.end('protocol-error');
    };
    let hello: XmlElement;
    try {
      hello = parseXml(text);
    } catch (err) {
      fail((err as Error).message);
      return;
    }
    if (hello.name !== 'hello' || hello.ns !== NETCONF_NS) {
      fail(`expected <hello>, got <${hello.name}>`);
      return;
    }
    // RFC 6241 §8.1: a client hello carrying a session-id is an error, and the server closes the session.
    if (hello.child('session-id', NETCONF_NS) !== undefined) {
      fail('it contains a session-id');
      return;
    }
    const caps = hello.child('capabilities', NETCONF_NS);
    const client = new CapabilitySet((caps?.childrenNamed('capability', NETCONF_NS) ?? []).map((c) => c.text()));
    const version = client.baseVersions.at(-1);
    if (version === undefined) {
      fail('it advertises no base capability');
      return;
    }
    this.host.clock.clearTimeout(this.#helloTimer);
    this.#version = version;
    // RFC 6242 §4.1: chunked framing from the next message, both ways, when both advertise base:1.1.
    if (version === '1.1') this.#channel.useChunkedFraming();
    this.#state = 'open';
    this.host.sessionStarted(this);
  }

  async #process(text: string): Promise<void> {
    let released = false;
    // Released just before the reply is written: a client that waits for each reply then sends at once is not pipelining.
    const release = (): void => {
      if (released) return;
      released = true;
      this.#waiting--;
    };
    if (this.#state === 'ended') {
      release();
      return;
    }
    this.#busy = true;
    try {
      await this.#answer(text, release);
    } finally {
      release();
      this.#busy = false;
      const held = this.#held;
      this.#held = [];
      if (this.#state === 'open') for (const n of held) this.#sendNotification(n);
    }
  }

  async #answer(text: string, release: () => void): Promise<void> {
    const fault = this.host.hasFaults() ? this.host.fault(this, { kind: 'rpc', operation: operationName(text) }) : undefined;
    if (fault !== undefined) {
      this.#log('debug', `Injected fault: ${fault.kind}`);
      switch (fault.kind) {
        case 'drop':
          this.#drop();
          return;
        case 'rpc-error':
          release();
          this.#sendReply(this.host.errorReply(text, fault.errors));
          return;
        case 'delay':
          await new Promise<void>((resolve) => {
            const timer = this.host.clock.setTimeout(resolve, fault.ms);
            this.signal.addEventListener('abort', () => {
              this.host.clock.clearTimeout(timer);
              resolve();
            });
          });
          if (this.ended) return;
          break;
        case 'unsolicited':
          for (const m of fault.messages) this.#sendText(m);
          break;
        default:
          break;
      }
    }
    let reply: XmlElement | undefined;
    try {
      reply = await this.host.answer(this, text);
    } catch (err) {
      this.#log('error', 'Failed to answer a request', { error: (err as Error).message });
      return;
    }
    // The session may have ended while the operation ran.
    if (this.ended) return;
    release();
    if (fault?.kind === 'raw-bytes') this.#channel.write(fault.bytes);
    else if (fault?.kind !== 'no-reply' && reply !== undefined) this.#sendReply(reply);
    const after = this.#afterReply;
    this.#afterReply = undefined;
    after?.();
  }

  #sendReply(reply: XmlElement): void {
    if (reply.child('rpc-error', NETCONF_NS) !== undefined) this.host.errorSent(this);
    const quirks = this.#exempt ? undefined : this.host.quirks(this);
    if (quirks === undefined || quirks.size === 0) {
      this.#send(reply);
      return;
    }
    this.#sendText(quirkText(serializeXml(quirkReply(reply, quirks), { declaration: true }), quirks));
  }

  #sendNotification(notification: XmlElement): void {
    this.counters.outNotifications++;
    this.host.notificationSent(this);
    this.#send(notification);
  }

  #send(message: XmlElement): void {
    this.#sendText(serializeXml(message, { declaration: true }));
  }

  #sendText(text: string): void {
    if (this.#state === 'ended') return;
    if (this.host.logger.trace !== undefined) this.#trace('Sent', text);
    if (this.#version === '1.1' && this.openedQuirks.has('chunkedFramingBroken')) {
      this.#channel.write(brokenChunk(text));
      return;
    }
    let framed: Uint8Array;
    try {
      framed = this.#channel.encode(text);
    } catch (err) {
      // Only EOM framing can fail, for a message containing `]]>]]>`.
      this.#log('error', "Can't frame a message", { error: (err as Error).message });
      this.end('protocol-error');
      return;
    }
    this.#channel.write(framed);
  }

  /** Drop the connection, as a transport failure would. */
  #drop(): void {
    this.#channel.destroy();
    this.end('dropped');
  }

  #onChannelEnd(reason: NetconfError): void {
    if (this.#state === 'ended') return;
    const framing = reason instanceof FramingError;
    this.#log('debug', framing ? `Framing error: ${reason.message}` : 'The client went away', {});
    this.end(framing ? 'protocol-error' : 'dropped');
  }

  /** Every message in and out at trace level (NNCD-04), with sensitive elements redacted. */
  #trace(message: string, text: string): void {
    this.host.logger.trace?.(message, { sessionId: this.id, username: this.principal.username, message: redactXml(text) });
  }

  #log(level: 'debug' | 'error', message: string, context: Record<string, unknown> = {}): void {
    this.host.logger[level]?.(message, { sessionId: this.id, username: this.principal.username, ...context });
  }
}

/** The operation a request names, for fault triggers; undefined when it isn't a readable rpc. */
function operationName(text: string): string | undefined {
  try {
    const rpc = parseXml(text);
    return rpc.name === 'rpc' ? rpc.elements[0]?.name : undefined;
  } catch {
    return undefined;
  }
}

export { MAX_SESSION_ID };
