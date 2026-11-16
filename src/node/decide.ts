/**
 * Asking an Authenticate hook about one attempt, for every listener (SSH-04):
 * a hook that throws or doesn't answer in time refuses the attempt, and the
 * error is logged.
 */

import type { Logger } from '@node-net/netconf';
import type { Authenticate, AuthAttempt } from '../auth.js';
import type { Principal } from '../session/session.js';

export async function decide(authenticate: Authenticate, attempt: AuthAttempt, timeout: number, logger: Logger): Promise<Principal | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => authenticate(attempt)),
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error(`no answer within ${timeout} ms`)), timeout);
      }),
    ]);
  } catch (err) {
    logger.error?.('Authentication failed with an error', { username: attempt.username, method: attempt.method, error: (err as Error).message });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
