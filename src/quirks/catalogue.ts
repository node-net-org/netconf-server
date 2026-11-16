/**
 * The quirk catalogue (design §13, DEVICE-05): misbehaviours of real devices
 * the server can emulate. Client quirks are tolerances (how @node-net/netconf
 * copes with a device); server quirks are the misbehaviours they exist for.
 * Each entry names the @node-net/netconf client quirk it exercises, and a test
 * fails when a client quirk has no server quirk naming it (DEVICE-06).
 *
 * A quirk is set to `true` (its default settings) or to an object of
 * settings. With no quirks set the server behaves as the RFCs require.
 */

/** A quirk's settings, after defaults. */
export type QuirkSettings = Readonly<Record<string, unknown>>;

/** The quirks in force, by name. */
export type ActiveQuirks = ReadonlyMap<string, QuirkSettings>;

export interface QuirkSpec {
  readonly name: string;
  readonly description: string;
  /** The @node-net/netconf client quirks (session or content) this one exercises; empty for one kept for interop references. */
  readonly exercises: readonly string[];
  /** Applies only to sessions opened after it is set, because it acts on the hello or framing. */
  readonly atSessionStart: boolean;
  /** The settings with defaults filled in, or a message saying what is wrong with them. */
  settings(value: unknown): QuirkSettings | string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Settings checked against a small description: each key's type and default. */
function shape(fields: Readonly<Record<string, { readonly type: 'string' | 'number' | 'boolean'; readonly default?: unknown; readonly check?: (v: never) => string | undefined }>>): QuirkSpec['settings'] {
  return (value) => {
    if (value === true) value = {};
    if (!isObject(value)) return 'must be true or an object of settings';
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) if (!(key in fields)) return `has no setting ${JSON.stringify(key)}`;
    for (const [key, f] of Object.entries(fields)) {
      const v = value[key];
      if (v === undefined) {
        if (f.default !== undefined) out[key] = f.default;
        continue;
      }
      if (typeof v !== f.type) return `${key} must be a ${f.type}`;
      const problem = f.check?.(v as never);
      if (problem !== undefined) return `${key} ${problem}`;
      out[key] = v;
    }
    return out;
  };
}

const positive = (v: number): string | undefined => (Number.isInteger(v) && v >= 0 ? undefined : 'must be a whole number, 0 or more');

export const QUIRKS: readonly QuirkSpec[] = [
  {
    name: 'replyWithoutMessageId',
    description: 'Replies carry no message-id: rpc-error replies only (`replies: "errors"`, the default), or every reply (`"all"`).',
    exercises: ['replyWithoutMessageId'],
    atSessionStart: false,
    settings: shape({ replies: { type: 'string', default: 'errors', check: (v: string) => (v === 'errors' || v === 'all' ? undefined : 'must be "errors" or "all"') } }),
  },
  {
    name: 'invalidXmlChars',
    description: 'rpc-error messages carry a character XML 1.0 does not allow (`char`, BEL by default), as devices that copy raw CLI output do.',
    exercises: ['invalidXmlChars'],
    atSessionStart: false,
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    settings: shape({ char: { type: 'string', default: '\u0007', check: (v: string) => (/^[\u0000-\u0008\u000B\u000C\u000E-\u001F]$/.test(v) ? undefined : 'must be one control character XML 1.0 does not allow') } }),
  },
  {
    name: 'paddedEmptyElements',
    description: 'Empty elements in replies are written across two lines: a line feed and `indent` spaces before the closing tag.',
    exercises: ['paddedEmptyElements'],
    atSessionStart: false,
    settings: shape({ indent: { type: 'number', default: 20, check: positive } }),
  },
  {
    name: 'chunkedFramingBroken',
    description: 'Advertises base:1.1 but writes chunked framing with broken chunk headers, so the device only works with base:1.0.',
    exercises: ['forceBaseVersion'],
    atSessionStart: true,
    settings: shape({}),
  },
  {
    name: 'noPipelining',
    description: 'A request that arrives while another is being answered gets operation-failed at once, as devices that mishandle pipelined requests do.',
    exercises: ['maxInFlight'],
    atSessionStart: false,
    settings: shape({}),
  },
  {
    name: 'slowCloseSession',
    description: 'The close-session reply is sent after `delay` milliseconds, or never when no delay is given.',
    exercises: ['closeTimeout'],
    atSessionStart: false,
    settings: shape({ delay: { type: 'number', check: positive } }),
  },
  {
    name: 'subtreeFilterLimit',
    description: "Subtree filters may go only `depth` levels down (keyed list entries straight after them don't count); a deeper one fails with the device's own error `message`.",
    exercises: ['subtreeFilter', 'subtreeFilterDepth'],
    atSessionStart: false,
    settings: shape({
      depth: { type: 'number', default: 2, check: (v: number) => (Number.isInteger(v) && v >= 1 ? undefined : 'must be a whole number, 1 or more') },
      message: { type: 'string', default: 'Leaf element specified which is not a key' },
    }),
  },
  {
    name: 'candidateUnvalidated',
    description: "Edits of the candidate aren't validated until commit or validate (netopeer2), so an invalid candidate is accepted and the commit fails.",
    exercises: [],
    atSessionStart: false,
    settings: shape({}),
  },
];

const BY_NAME = new Map(QUIRKS.map((q) => [q.name, q]));

/** The quirk catalogue's names (DEVICE-05). */
export const QUIRK_NAMES: readonly string[] = QUIRKS.map((q) => q.name);

export function quirkSpec(name: string): QuirkSpec | undefined {
  return BY_NAME.get(name);
}

/** Checks a quirk name and its settings: the settings with defaults, or a message. */
export function resolveQuirk(name: string, value: unknown): QuirkSettings | string {
  const spec = BY_NAME.get(name);
  if (spec === undefined) return 'is not a known quirk';
  return spec.settings(value);
}
