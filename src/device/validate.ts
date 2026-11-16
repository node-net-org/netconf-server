/**
 * Run-time validation of a device definition: the rules of
 * schemas/device.schema.json, plus the cross-field rules a JSON Schema
 * can't say well. Every problem is reported with its JSON path, not just the
 * first. A test keeps this and the schema in agreement.
 */

import type { DeviceIssue } from '../errors.js';
import { WITH_DEFAULTS_MODES } from './definition.js';
import { resolveQuirk } from '../quirks/catalogue.js';

type Obj = Record<string, unknown>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const REVISION = /^\d{4}-\d{2}-\d{2}$/;
const DATA_FILE = /\.(xml|json|XML|JSON)$/;

const TOP = ['$schema', 'id', 'description', 'emulates', 'yang', 'capabilities', 'data', 'yangLibrary', 'quirks'];
const YANG = ['modules', 'features', 'deviations', 'importOnly', 'directories'];
const CAPS = [
  'writableRunning',
  'candidate',
  'confirmedCommit',
  'rollbackOnError',
  'validate',
  'startup',
  'xpath',
  'withDefaults',
  'notification',
  'interleave',
  'extra',
  'moduleCapabilities',
];
const CAP_FLAGS = CAPS.filter((c) => !['withDefaults', 'extra', 'moduleCapabilities'].includes(c));
const DATA = ['running', 'startup', 'operational'];

/** Every problem with `value` as a device definition. Empty when it is valid. */
export function validateDefinition(value: unknown): DeviceIssue[] {
  const issues: DeviceIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ path, message });

  if (!isObject(value)) {
    add('$', 'must be an object');
    return issues;
  }
  unknownKeys(value, TOP, '$', add);
  if (value['$schema'] !== undefined && typeof value['$schema'] !== 'string') add('$.$schema', 'must be a string');
  if (typeof value['id'] !== 'string') add('$.id', value['id'] === undefined ? 'is required' : 'must be a string');
  else if (!ID.test(value['id'])) add('$.id', 'must start with a letter or digit and contain only letters, digits, ".", "_" and "-"');
  for (const key of ['description', 'emulates']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') add(`$.${key}`, 'must be a string');
  }

  const yang = value['yang'];
  if (yang === undefined) add('$.yang', 'is required');
  else if (!isObject(yang)) add('$.yang', 'must be an object');
  else {
    unknownKeys(yang, YANG, '$.yang', add);
    if (yang['modules'] === undefined) add('$.yang.modules', 'is required');
    else moduleRefs(yang['modules'], '$.yang.modules', add);
    if (yang['deviations'] !== undefined) moduleRefs(yang['deviations'], '$.yang.deviations', add);
    if (yang['importOnly'] !== undefined) moduleRefs(yang['importOnly'], '$.yang.importOnly', add);
    const features = yang['features'];
    if (features !== undefined) {
      if (!isObject(features)) add('$.yang.features', 'must be an object of module names to feature lists');
      else {
        for (const [module, list] of Object.entries(features)) {
          const path = `$.yang.features${member(module)}`;
          if (!MODULE_NAME.test(module)) add(path, 'is not a valid module name');
          strings(list, path, add);
        }
      }
    }
    if (yang['directories'] !== undefined) strings(yang['directories'], '$.yang.directories', add, true);
  }

  const caps = value['capabilities'];
  if (caps !== undefined) {
    if (!isObject(caps)) add('$.capabilities', 'must be an object');
    else {
      unknownKeys(caps, CAPS, '$.capabilities', add);
      for (const flag of CAP_FLAGS) {
        if (caps[flag] !== undefined && typeof caps[flag] !== 'boolean') add(`$.capabilities.${flag}`, 'must be true or false');
      }
      const wd = caps['withDefaults'];
      if (wd !== undefined && wd !== false) {
        if (!isObject(wd)) add('$.capabilities.withDefaults', 'must be false or an object with a basicMode');
        else {
          unknownKeys(wd, ['basicMode', 'alsoSupported'], '$.capabilities.withDefaults', add);
          if (!WITH_DEFAULTS_MODES.includes(wd['basicMode'] as never)) {
            add('$.capabilities.withDefaults.basicMode', `must be one of ${WITH_DEFAULTS_MODES.join(', ')}`);
          }
          const also = wd['alsoSupported'];
          if (also !== undefined) {
            if (!Array.isArray(also)) add('$.capabilities.withDefaults.alsoSupported', 'must be an array');
            else {
              also.forEach((m, i) => {
                if (!WITH_DEFAULTS_MODES.includes(m as never)) {
                  add(`$.capabilities.withDefaults.alsoSupported[${i}]`, `must be one of ${WITH_DEFAULTS_MODES.join(', ')}`);
                }
              });
            }
          }
        }
      }
      if (caps['extra'] !== undefined) strings(caps['extra'], '$.capabilities.extra', add, true);
      if (caps['moduleCapabilities'] !== undefined) strings(caps['moduleCapabilities'], '$.capabilities.moduleCapabilities', add, true);
      if (caps['confirmedCommit'] === true && caps['candidate'] !== true) {
        add('$.capabilities.confirmedCommit', 'needs candidate: confirmed commit commits the candidate (RFC 6241 §8.4)');
      }
      if (caps['interleave'] === true && caps['notification'] !== true) {
        add('$.capabilities.interleave', 'needs notification (RFC 5277 §6)');
      }
    }
  }

  const data = value['data'];
  if (data !== undefined) {
    if (!isObject(data)) add('$.data', 'must be an object');
    else {
      unknownKeys(data, DATA, '$.data', add);
      for (const key of DATA) {
        const file = data[key];
        if (file === undefined) continue;
        if (typeof file !== 'string' || file === '') add(`$.data.${key}`, 'must be a file path');
        else if (!DATA_FILE.test(file)) add(`$.data.${key}`, 'must be an .xml or .json file');
      }
    }
  }

  const library = value['yangLibrary'];
  if (library !== undefined) {
    if (!isObject(library)) add('$.yangLibrary', 'must be an object');
    else {
      unknownKeys(library, ['modulesState'], '$.yangLibrary', add);
      if (library['modulesState'] !== undefined && typeof library['modulesState'] !== 'boolean') add('$.yangLibrary.modulesState', 'must be true or false');
    }
  }

  const quirks = value['quirks'];
  if (quirks !== undefined) {
    if (!isObject(quirks)) add('$.quirks', 'must be an object');
    else {
      for (const [name, v] of Object.entries(quirks)) {
        const settings = resolveQuirk(name, v);
        if (typeof settings === 'string') add(`$.quirks${member(name)}`, settings);
      }
    }
  }
  return issues;
}

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function member(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function unknownKeys(o: Obj, known: readonly string[], path: string, add: (p: string, m: string) => void, message = 'is not allowed here'): void {
  for (const key of Object.keys(o)) if (!known.includes(key)) add(`${path}${member(key)}`, message);
}

function strings(v: unknown, path: string, add: (p: string, m: string) => void, nonEmpty = false): void {
  if (!Array.isArray(v)) {
    add(path, 'must be an array of strings');
    return;
  }
  v.forEach((s, i) => {
    if (typeof s !== 'string' || (nonEmpty && s === '')) add(`${path}[${i}]`, nonEmpty ? 'must be a non-empty string' : 'must be a string');
  });
}

function moduleRefs(v: unknown, path: string, add: (p: string, m: string) => void): void {
  if (!Array.isArray(v)) {
    add(path, 'must be an array of module names or { name, revision } objects');
    return;
  }
  v.forEach((m, i) => {
    const at = `${path}[${i}]`;
    if (typeof m === 'string') {
      if (!MODULE_NAME.test(m)) add(at, 'is not a valid module name');
    } else if (isObject(m)) {
      unknownKeys(m, ['name', 'revision'], at, add);
      if (typeof m['name'] !== 'string' || !MODULE_NAME.test(m['name'])) add(`${at}.name`, 'must be a valid module name');
      if (m['revision'] !== undefined && (typeof m['revision'] !== 'string' || !REVISION.test(m['revision']))) {
        add(`${at}.revision`, 'must be a date, YYYY-MM-DD');
      }
    } else add(at, 'must be a module name or a { name, revision } object');
  });
}
