/**
 * Persistence (design §9, STORE-01, STORE-02): a store saves the
 * configuration datastore RFC 6241 says survives a restart (startup with
 * :startup, otherwise running) as RFC 7951 JSON text, and gives it back at
 * start-up. The server does the YANG work; a store only keeps text.
 *
 * The memory store is here, and needs nothing from Node.js. The file store
 * (file.ts) is Node-only.
 */

/** The configuration datastores a store may be asked to keep. */
export type StoredDatastore = 'running' | 'startup';

export interface Store {
  /** Where the store keeps its data, for messages: a directory, or `memory`. */
  readonly location: string;
  /** Where one datastore is kept, for messages: its file, say. Default: the location and the datastore's name. */
  describe?(datastore: StoredDatastore): string;
  /**
   * Called once when a server starts with the store, before any load or
   * save. A store that can't be used throws, and the server doesn't start.
   */
  open?(): Promise<void>;
  /** The saved datastore as RFC 7951 JSON text, or undefined when none was saved. */
  load(datastore: StoredDatastore): Promise<string | undefined>;
  /** Saves a datastore. Resolves once it is saved; a rejection fails the write that made it. */
  save(datastore: StoredDatastore, json: string): Promise<void>;
}

/**
 * A store that keeps the saved datastores in memory (the default). A new
 * one starts empty, so the server starts from the device's initial data;
 * give the same store to a second server to simulate a restart.
 */
export function memoryStore(): Store {
  const saved = new Map<StoredDatastore, string>();
  return {
    location: 'memory',
    load: (datastore) => Promise.resolve(saved.get(datastore)),
    save: (datastore, json) => {
      saved.set(datastore, json);
      return Promise.resolve();
    },
  };
}
