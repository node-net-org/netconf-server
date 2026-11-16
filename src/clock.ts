/**
 * The server's clock (design §2): every timer and timestamp goes through it,
 * so tests and the browser tutorial control time. The default uses the
 * runtime's own timers.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Call `fn` after `ms` milliseconds. Returns a handle for clearTimeout(). */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle: unknown): void => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});
