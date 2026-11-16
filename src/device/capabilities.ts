/**
 * The capabilities a device advertises in its hello (RFC 6241 §8, RFC 7950
 * §5.6.4, RFC 8526 §2): both base versions, the optional protocol
 * capabilities the definition chooses, the YANG library capability, a module
 * capability for each implemented YANG 1.0 module, and any extras.
 */

import { BASE_1_0, BASE_1_1, CAPABILITY_PREFIX as CAP } from '@node-net/netconf/core';
import type { Schema } from '@node-net/yang/core';
import type { DeviceCapabilities, WithDefaultsMode } from './definition.js';

const YANG_LIBRARY_REVISION = '2019-01-04';

/** The optional protocol capabilities, with defaults applied. */
export interface ProtocolCapabilities {
  readonly writableRunning: boolean;
  readonly candidate: boolean;
  readonly confirmedCommit: boolean;
  readonly rollbackOnError: boolean;
  readonly validate: boolean;
  readonly startup: boolean;
  readonly xpath: boolean;
  readonly withDefaults: false | { readonly basicMode: WithDefaultsMode; readonly alsoSupported: readonly WithDefaultsMode[] };
  readonly notification: boolean;
  readonly interleave: boolean;
}

export function resolveProtocol(caps: DeviceCapabilities = {}): ProtocolCapabilities {
  const candidate = caps.candidate ?? false;
  const wd = caps.withDefaults;
  return Object.freeze({
    candidate,
    // DEVICE-03: a device without a candidate writes running directly, and one with a candidate doesn't, unless it says so.
    writableRunning: caps.writableRunning ?? !candidate,
    confirmedCommit: caps.confirmedCommit ?? false,
    rollbackOnError: caps.rollbackOnError ?? true,
    validate: caps.validate ?? true,
    startup: caps.startup ?? false,
    xpath: caps.xpath ?? true,
    withDefaults:
      wd === false
        ? false
        : wd === undefined
          ? { basicMode: 'explicit' as const, alsoSupported: ['report-all', 'report-all-tagged', 'trim'] as const }
          : { basicMode: wd.basicMode, alsoSupported: wd.alsoSupported ?? [] },
    notification: caps.notification ?? false,
    interleave: caps.interleave ?? false,
  });
}

export function protocolCapabilities(protocol: ProtocolCapabilities, schema: Schema, caps: DeviceCapabilities = {}): string[] {
  const out = [BASE_1_0, BASE_1_1];
  if (protocol.writableRunning) out.push(`${CAP}writable-running:1.0`);
  if (protocol.candidate) out.push(`${CAP}candidate:1.0`);
  if (protocol.confirmedCommit) out.push(`${CAP}confirmed-commit:1.1`);
  if (protocol.rollbackOnError) out.push(`${CAP}rollback-on-error:1.0`);
  if (protocol.validate) out.push(`${CAP}validate:1.1`);
  if (protocol.startup) out.push(`${CAP}startup:1.0`);
  if (protocol.xpath) out.push(`${CAP}xpath:1.0`);
  if (protocol.withDefaults !== false) {
    const also = protocol.withDefaults.alsoSupported.filter((m) => m !== (protocol.withDefaults as { basicMode: string }).basicMode);
    out.push(`${CAP}with-defaults:1.0?basic-mode=${protocol.withDefaults.basicMode}${also.length > 0 ? `&also-supported=${also.join(',')}` : ''}`);
  }
  if (protocol.notification) out.push(`${CAP}notification:1.0`);
  if (protocol.interleave) out.push(`${CAP}interleave:1.0`);
  out.push(`${CAP}yang-library:1.1?revision=${YANG_LIBRARY_REVISION}&content-id=${contentId(schema)}`);
  out.push(...(caps.moduleCapabilities ?? moduleCapabilities(schema)));
  out.push(...(caps.extra ?? []));
  return out;
}

/**
 * A module capability for each implemented YANG 1.0 module (RFC 7950
 * §5.6.4). YANG 1.1 modules are listed only in the YANG library.
 */
export function moduleCapabilities(schema: Schema): string[] {
  return schema.implemented
    .filter((m) => m.yangVersion === '1')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((m) => {
      let uri = `${m.namespace}?module=${m.name}`;
      if (m.revision !== undefined) uri += `&revision=${m.revision}`;
      const features = [...m.enabledFeatures].sort();
      if (features.length > 0) uri += `&features=${features.join(',')}`;
      if (m.deviations.length > 0) uri += `&deviations=${[...m.deviations].sort().join(',')}`;
      return uri;
    });
}

/**
 * The YANG library content-id (RFC 8525 §3): it changes whenever the module
 * set does. An FNV-1a hash of the implemented modules, their revisions,
 * features and deviations, and the import-only modules.
 */
export function contentId(schema: Schema): string {
  const parts = schema.allModules
    .map((m) => `${m.implemented ? 'i' : 'o'}:${m.name}@${m.revision ?? ''}:${[...m.enabledFeatures].sort().join(',')}:${[...m.deviations].sort().join(',')}`)
    .sort();
  let hash = 0x811c9dc5;
  for (const ch of parts.join('\n')) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
