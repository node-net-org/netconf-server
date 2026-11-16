/**
 * Loading a device definition from a JSON file (Node only). Paths inside
 * the definition (module directories, data files) are relative to the file,
 * and the data files are read from disk.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileSource } from '@node-net/yang';
import { DeviceError } from '../errors.js';
import { loadDevice, type Device, type LoadDeviceOptions } from './load.js';

/**
 * Loads a device from its definition file.
 * @throws DeviceError when the file can't be read or parsed, the definition
 *   is invalid, or its modules don't compile.
 */
export async function loadDeviceFile(path: string, options: Pick<LoadDeviceOptions, 'source' | 'control'> = {}): Promise<Device> {
  const file = resolve(path);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new DeviceError(`Can't read device definition ${file}`, [{ path: file, message: (err as Error).message }], { cause: err });
  }
  let definition: unknown;
  try {
    definition = JSON.parse(text);
  } catch (err) {
    throw new DeviceError(`Device definition ${file} is not valid JSON`, [{ path: file, message: (err as Error).message }], { cause: err });
  }
  const base = dirname(file);
  try {
    return await loadDevice(definition, {
      ...options,
      directorySource: (dirs) => fileSource(dirs.map((d) => resolve(base, d))),
      resolvePath: (p) => resolve(base, p),
      readData: (p) => readFile(p),
    });
  } catch (err) {
    if (err instanceof DeviceError) throw new DeviceError(`Can't load device definition ${file}`, err.issues, { cause: err });
    throw err;
  }
}
