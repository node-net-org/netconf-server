/**
 * Every provider hook runs under a timeout on the server's clock (design §8,
 * PROVIDER-10), so tests and the browser control time. A hook that runs late
 * is given an aborted signal; whatever it returns after that is ignored.
 */

import type { Clock } from '../clock.js';

/** A hook that didn't finish in time. */
export class HookTimeout extends Error {
  override name = 'HookTimeout';

  constructor(
    readonly hook: string,
    readonly ms: number,
  ) {
    super(`${hook} did not finish within ${ms} ms`);
  }
}

/**
 * Runs `hook` and resolves with its result, or rejects with a HookTimeout
 * after `ms` milliseconds on `clock`. Throws from the hook, synchronous or
 * not, become rejections.
 */
export function withTimeout<T>(clock: Clock, ms: number, name: string, hook: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = clock.setTimeout(() => {
      if (done) return;
      done = true;
      const error = new HookTimeout(name, ms);
      controller.abort(error);
      reject(error);
    }, ms);
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      settle();
    };
    Promise.resolve()
      .then(() => hook(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
      );
  });
}
