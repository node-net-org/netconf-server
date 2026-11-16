import { memorySource, type ModuleSource } from '@node-net/yang/core';
import { BASE_MODULES } from './base-modules.js';

let base: ModuleSource | undefined;

/**
 * The base modules the server embeds (modules/README.md): monitoring, NMDA
 * and the notification modules, which @node-net/yang doesn't bundle.
 */
export const baseModuleSource: ModuleSource = {
  load(name, revision) {
    base ??= memorySource(BASE_MODULES.map((m) => ({ text: m.text, source: `@node-net/netconf-server/modules/${m.file}`, format: 'yang' as const })));
    return base.load(name, revision);
  },
};
