/**
 * The YANG library (RFC 8525) the server publishes in `<operational>`
 * (SCHEMA-01): built from the compiled schema, with the content-id the hello
 * advertises, every datastore the server implements, and, when the device
 * asks for it, the deprecated `modules-state` of RFC 7895.
 */

import { yangLibraryData, type JsonValue } from '@node-net/yang/core';
import { contentId } from '../device/capabilities.js';
import type { Device } from '../device/load.js';

/** The datastores the server implements, as `ietf-datastores` identity names. */
export function datastoreNames(device: Device): string[] {
  const p = device.protocol;
  return ['running', ...(p.candidate ? ['candidate'] : []), ...(p.startup ? ['startup'] : []), 'intended', 'operational'];
}

/** The library as RFC 7951 JSON members, ready to decode into the operational view. */
export function yangLibraryJson(device: Device): Record<string, JsonValue> {
  const id = contentId(device.schema);
  const library: Record<string, JsonValue> = yangLibraryData(device.schema, { contentId: id, datastores: datastoreNames(device) });
  if (device.definition.yangLibrary?.modulesState === true) library['ietf-yang-library:modules-state'] = modulesState(device, id);
  return library;
}

/** RFC 7895's module list, kept in ietf-yang-library 2019-01-04 as deprecated. */
function modulesState(device: Device, id: string): JsonValue {
  const modules = [...device.schema.allModules]
    .sort((a, b) => (a.name === b.name ? ((a.revision ?? '') < (b.revision ?? '') ? -1 : 1) : a.name < b.name ? -1 : 1))
    .map((m) => ({
      name: m.name,
      revision: m.revision ?? '',
      namespace: m.namespace,
      ...(m.implemented && m.enabledFeatures.size > 0 ? { feature: [...m.enabledFeatures].sort() } : {}),
      ...(m.implemented && m.deviations.length > 0
        ? { deviation: [...m.deviations].sort().map((name) => ({ name, revision: device.schema.module(name)?.revision ?? '' })) }
        : {}),
      'conformance-type': m.implemented ? 'implement' : 'import',
      ...(m.includes.length > 0 ? { submodule: m.includes.map((s) => ({ name: s.name, revision: s.revision ?? '' })) } : {}),
    }));
  return { 'module-set-id': id, module: modules };
}
