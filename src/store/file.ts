/**
 * The file store (Node only, design §9, STORE-01): one RFC 7951 JSON file
 * per saved datastore in a state directory, `running.json` or
 * `startup.json`. Each save writes a temporary file and renames it over the
 * old one, so a crash during a save leaves the previous file intact.
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StoreError } from '../errors.js';
import type { Store, StoredDatastore } from './store.js';

/** A store that saves to files in `directory`, which is created if it doesn't exist. */
export function fileStore(directory: string): Store {
  const dir = resolve(directory);
  const file = (datastore: StoredDatastore): string => join(dir, `${datastore}.json`);
  let sequence = 0;
  return {
    location: dir,
    describe: file,

    async open() {
      try {
        await mkdir(dir, { recursive: true });
        // Prove the directory is writable now, rather than at the first save.
        const probe = join(dir, `.probe-${process.pid}`);
        const handle = await open(probe, 'w');
        await handle.close();
        await rm(probe);
      } catch (err) {
        throw new StoreError(`Can't use state directory ${dir}: ${(err as Error).message}`, dir, { cause: err });
      }
    },

    async load(datastore) {
      try {
        return await readFile(file(datastore), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new StoreError(`Can't read ${file(datastore)}: ${(err as Error).message}`, file(datastore), { cause: err });
      }
    },

    async save(datastore, json) {
      const target = file(datastore);
      const temp = `${target}.${process.pid}.${++sequence}.tmp`;
      try {
        const handle = await open(temp, 'w');
        try {
          await handle.writeFile(json, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, target);
      } catch (err) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw new StoreError(`Can't save ${target}: ${(err as Error).message}`, target, { cause: err });
      }
    },
  };
}
