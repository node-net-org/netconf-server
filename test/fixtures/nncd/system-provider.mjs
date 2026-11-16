// A provider module for nncd tests (NNCD-03): the factory records how it was
// called in the file options.record names, adopts a hostname when its entry
// asks for adopt, and can be made to take a while to prepare a write.
import { writeFileSync } from 'node:fs';

export default function systemProvider(options = {}, context) {
  if (options.record) {
    writeFileSync(options.record, JSON.stringify({ options, configDir: context.configDir, hasLogger: typeof context.logger === 'object' }));
  }
  context.logger.info?.('system provider created');
  return new SystemProvider(options);
}

// A class with a private field, so the start-up override must keep methods bound.
class SystemProvider {
  #hostname;
  constructor(options) {
    this.#hostname = options.hostname ?? 'from-provider';
    this.delay = options.prepareDelayMs ?? 0;
  }
  load() {
    return { 'writes-test:system': { hostname: this.#hostname } };
  }
  async prepare(changes, context) {
    // Slow for writes, not for the start-up push.
    if (this.delay > 0 && context.cause !== 'startup') await new Promise((r) => setTimeout(r, this.delay));
    return { commit: () => undefined };
  }
}
