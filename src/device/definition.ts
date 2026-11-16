/**
 * The device definition (design §13): what a server emulates, as data. The
 * JSON Schema for the file form is schemas/device.schema.json; validate.ts
 * checks the same rules at run time, so a definition object built in code
 * (the browser) gets the same errors as a file.
 */

/** A module by name, or by name and revision. */
export type ModuleRef = string | { readonly name: string; readonly revision?: string };

export type WithDefaultsMode = 'report-all' | 'report-all-tagged' | 'trim' | 'explicit';

export interface DeviceYang {
  /** The modules the device implements. Their imports are found automatically. */
  readonly modules: readonly ModuleRef[];
  /** Enabled features per module. A module not listed has every feature enabled; an empty list disables them all. */
  readonly features?: Readonly<Record<string, readonly string[]>>;
  /** Implemented modules that only carry deviations of other modules. */
  readonly deviations?: readonly ModuleRef[];
  /** Modules to load but not implement. */
  readonly importOnly?: readonly ModuleRef[];
  /**
   * Directories to find modules in, searched before @node-net/yang's bundled IETF
   * modules. In a file they are relative to the file; a definition given as
   * an object needs loadDeviceFile() or a directory source to use them.
   */
  readonly directories?: readonly string[];
}

export interface DeviceCapabilities {
  /** `:writable-running`. Default: true when the device has no candidate, otherwise false. */
  readonly writableRunning?: boolean;
  /** `:candidate`. Default false. */
  readonly candidate?: boolean;
  /** `:confirmed-commit:1.1`. Needs candidate. Default false. */
  readonly confirmedCommit?: boolean;
  /** `:rollback-on-error`. Default true. */
  readonly rollbackOnError?: boolean;
  /** `:validate:1.1`. Default true. */
  readonly validate?: boolean;
  /** `:startup`. Default false. */
  readonly startup?: boolean;
  /** `:xpath`. Default true. */
  readonly xpath?: boolean;
  /** `:with-defaults` (RFC 6243), or false for none. Default basic mode explicit, with every other mode also supported. */
  readonly withDefaults?: false | { readonly basicMode: WithDefaultsMode; readonly alsoSupported?: readonly WithDefaultsMode[] };
  /** `:notification` (RFC 5277). Default false. */
  readonly notification?: boolean;
  /** `:interleave`. Needs notification. Default false. */
  readonly interleave?: boolean;
  /** Extra capability URIs, advertised as written. */
  readonly extra?: readonly string[];
  /** Module capability URIs exactly as the real device writes them, replacing the generated ones. */
  readonly moduleCapabilities?: readonly string[];
}

/**
 * Initial data files, XML or RFC 7951 JSON by extension (DEVICE-04). In a
 * file they are relative to the file; a definition given as an object needs
 * loadDeviceFile() or a `readData` option to read them.
 */
export interface DeviceData {
  readonly running?: string;
  readonly startup?: string;
  readonly operational?: string;
}

/** What the YANG library (RFC 8525) reports beyond the defaults. */
export interface DeviceYangLibrary {
  /** Also provide the deprecated `modules-state` container (RFC 7895), as older devices do. Default false. */
  readonly modulesState?: boolean;
}

export interface DeviceDefinition {
  readonly $schema?: string;
  readonly id: string;
  readonly description?: string;
  /** The id of the @node-net/netconf client profile this device should be detected as. */
  readonly emulates?: string;
  readonly yang: DeviceYang;
  readonly capabilities?: DeviceCapabilities;
  readonly data?: DeviceData;
  readonly yangLibrary?: DeviceYangLibrary;
  /** Misbehaviours to emulate (design §13): each quirk of the catalogue by name, `true` or its settings. */
  readonly quirks?: Readonly<Record<string, unknown>>;
}

export const WITH_DEFAULTS_MODES: readonly WithDefaultsMode[] = ['report-all', 'report-all-tagged', 'trim', 'explicit'];

export { QUIRK_NAMES } from '../quirks/catalogue.js';
