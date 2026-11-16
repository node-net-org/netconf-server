/**
 * The write queue (design §8, WRITE-10): every write to a configuration
 * datastore runs here, one at a time, in the order it arrived, so each is
 * validated against the configuration the writes before it left. Reads
 * never wait on it: they use the snapshot they start with.
 */

export class WriteQueue {
  #tail: Promise<unknown> = Promise.resolve();

  /** Runs `write` after every write queued before it has finished, whether it succeeded or not. */
  run<T>(write: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(write);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
