/**
 * A small typed event emitter (design §3: events only report). A listener
 * that throws is logged and ignored, so it never affects a session, and
 * there is no 'error' event.
 */

import type { Logger } from '@node-net/netconf/core';

type Listener<T> = (event: T) => void;

export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

  constructor(private readonly logger: Logger) {}

  on<K extends keyof Events>(name: K, listener: Listener<Events[K]>): this {
    let set = this.#listeners.get(name);
    if (set === undefined) this.#listeners.set(name, (set = new Set()));
    set.add(listener);
    return this;
  }

  off<K extends keyof Events>(name: K, listener: Listener<Events[K]>): this {
    this.#listeners.get(name)?.delete(listener);
    return this;
  }

  once<K extends keyof Events>(name: K, listener: Listener<Events[K]>): this {
    const wrapper: Listener<Events[K]> = (event) => {
      this.off(name, wrapper);
      listener(event);
    };
    return this.on(name, wrapper);
  }

  /** @internal */
  emit<K extends keyof Events>(name: K, event: Events[K]): void {
    const set = this.#listeners.get(name);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(event);
      } catch (err) {
        this.logger.warn?.(`A ${String(name)} listener threw`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
