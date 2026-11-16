/**
 * The read operations: `<get-config>` and `<get>` (RFC 6241 §7.1, §7.7) and
 * NMDA's `<get-data>` (RFC 8526 §3.1.1), with subtree filters (RFC 6241 §6),
 * XPath filters (§8.9) and with-defaults (RFC 6243).
 *
 * Every read works on a datastore snapshot (design §8). A step that changes
 * a tree works on a copy, or on a tree built for this read, so snapshots are
 * never changed. The YANG work (defaults, filters, pruning, merging) is
 * @node-net/yang's; this module reads the parameters and maps problems to
 * rpc-errors.
 */

import { DATASTORES_NS, NETCONF_NS, NMDA_NS, WITH_DEFAULTS_NS, type XmlElement, type XmlNode } from '@node-net/netconf/core';
import {
  XPathError,
  applyWithDefaults,
  effectiveOrigin,
  evaluateXPath,
  mergeTrees,
  pruneTree,
  selectionTree,
  subtreeFilter,
  type DataTree,
  type Identity,
  type InstanceNode,
  type PruneOptions,
  type WithDefaultsMode,
} from '@node-net/yang/core';
import { stripOrigins, type ConfigDatastore, type Datastores } from '../datastore/datastores.js';
import { WITH_DEFAULTS_MODES } from '../device/definition.js';
import type { Device } from '../device/load.js';
import type { ReadHooks, ReadSelection } from '../provider/reads.js';
import type { Dispatcher } from './dispatch.js';
import { subtreeFilterDepth } from '../quirks/apply.js';
import type { ServerSession } from '../session/session.js';
import type { Subject } from '../nacm/decide.js';
import { readPlan, type ReadPlan } from '../nacm/read-plan.js';
import { info, operationFailed, operationNotSupported, RpcFailure, rpcErrorElement } from './errors.js';
import { identityName, invalid, required } from './params.js';
import { dataElement } from './xml.js';

/** What a read selects: a subtree filter's content, or an XPath expression with its namespace declarations. */
export type Filter =
  | { readonly kind: 'subtree'; readonly content: readonly XmlNode[]; readonly scope: ReadonlyMap<string, string> }
  | { readonly kind: 'xpath'; readonly select: string; readonly scope: ReadonlyMap<string, string>; readonly element: string };

interface Retrieval {
  /** The tree to read from. */
  readonly tree: DataTree;
  /** Whether the tree was built for this read, so it may be changed. */
  readonly owned: boolean;
  readonly defaults?: WithDefaultsMode | undefined;
  readonly filter?: Filter | undefined;
  /** Configuration nodes whose origin matches, and every state node (RFC 8526 §3.1.1). */
  readonly origins?: { readonly identities: readonly Identity[]; readonly negated: boolean; readonly unknown: Identity | undefined } | undefined;
  readonly prune?: PruneOptions | undefined;
  /** Keep `or:origin` annotations. */
  readonly withOrigin?: boolean;
  /** What the session may read (NACM design §7.1); undefined when access isn't checked. */
  readonly plan?: ReadPlan | undefined;
}

export function registerReadOperations(dispatcher: Dispatcher, device: Device, datastores: Datastores, hooks?: ReadHooks): void {
  const reader = new Reader(device, datastores);

  /**
   * Runs the read hooks a read of operational selects (never for
   * configuration datastores), leaving out providers whose data the user
   * may not read at all; returns the warnings for the reply.
   */
  const refresh = async (filter: Filter | undefined, who: { sessionId: number; username: string }, plan: ReadPlan | undefined): Promise<XmlElement[]> => {
    if (hooks === undefined) return [];
    const selection: ReadSelection =
      filter === undefined ? { kind: 'all' } : filter.kind === 'subtree' ? { kind: 'subtree', content: filter.content } : { kind: 'xpath', select: filter.select, scope: filter.scope };
    return (await hooks.refresh(selection, who, plan === undefined ? undefined : (node) => plan.denies(node))).map(rpcErrorElement);
  };

  /** The subtreeFilterLimit quirk (design §13): a filter deeper than the device takes fails with its own error text. */
  const limit = (filter: Filter | undefined, session: ServerSession): Filter | undefined => {
    const q = session.quirk('subtreeFilterLimit');
    if (q !== undefined && filter?.kind === 'subtree' && subtreeFilterDepth(filter.content) > Number(q['depth'])) {
      throw new RpcFailure(operationFailed(String(q['message'])));
    }
    return filter;
  };

  dispatcher.handle(NETCONF_NS, 'get-config', ({ operation, session, access }) => {
    const source = required(operation, 'source', NETCONF_NS);
    const target = source.elements[0];
    if (target === undefined || target.ns !== NETCONF_NS) throw invalid('get-config needs a source datastore', 'source');
    const name = target.name;
    if (name !== 'running' && name !== 'candidate' && name !== 'startup') throw invalid(`${name} is not a datastore get-config can read`, name);
    if (!datastores.has(name)) throw invalid(`The device has no ${name} datastore`, name);
    return [
      reader.reply(NETCONF_NS, {
        tree: datastores.config(name),
        owned: false,
        defaults: reader.defaults(operation.child('with-defaults', WITH_DEFAULTS_NS)),
        filter: limit(reader.netconfFilter(operation.child('filter', NETCONF_NS)), session),
        plan: reader.plan(access),
      }),
    ];
  });

  // RFC 8342 §5.3: <get> returns running's configuration with the state from <operational>; intended = running here.
  dispatcher.handle(NETCONF_NS, 'get', async ({ operation, session, access }) => {
    const defaults = reader.defaults(operation.child('with-defaults', WITH_DEFAULTS_NS));
    const filter = limit(reader.netconfFilter(operation.child('filter', NETCONF_NS)), session);
    const plan = reader.plan(access);
    const warnings = await refresh(filter, { sessionId: session.id, username: session.principal.username }, plan);
    return [reader.reply(NETCONF_NS, { tree: datastores.operational(), owned: true, defaults, filter, plan }), ...warnings];
  });

  dispatcher.handle(NMDA_NS, 'get-data', async ({ operation, session, access }) => {
    const dsElement = required(operation, 'datastore', NMDA_NS);
    const name = reader.identity(dsElement, DATASTORES_NS);
    if (name === undefined || !datastores.has(name)) throw invalid(`The server has no datastore ${dsElement.text().trim()}`, 'datastore');
    const operational = name === 'operational';

    const withOrigin = operation.child('with-origin', NMDA_NS) !== undefined;
    if (withOrigin && !operational) throw invalid('with-origin is only valid for the operational datastore', 'with-origin');
    const origins = reader.originFilters(operation, operational);

    const subtree = operation.child('subtree-filter', NMDA_NS);
    const xpath = operation.child('xpath-filter', NMDA_NS);
    if (subtree !== undefined && xpath !== undefined) throw invalid('Use subtree-filter or xpath-filter, not both', 'xpath-filter');
    const filter: Filter | undefined = limit(
      subtree !== undefined
        ? { kind: 'subtree', content: subtree.children, scope: subtree.inScope }
        : xpath !== undefined
          ? { kind: 'xpath', select: xpath.text().trim(), scope: xpath.inScope, element: 'xpath-filter' }
          : undefined,
      session,
    );

    const wd = operation.child('with-defaults', NMDA_NS);
    // RFC 8526 §3.1.1: with-defaults applies to <operational> only with :with-operational-defaults, which this server doesn't advertise.
    if (wd !== undefined && operational) throw invalid('with-defaults is not supported for the operational datastore', 'with-defaults');

    const prune = reader.prune(operation);
    const plan = reader.plan(access);
    const warnings = operational ? await refresh(filter, { sessionId: session.id, username: session.principal.username }, plan) : [];
    const result = reader.reply(NMDA_NS, {
      tree: operational ? datastores.operational() : datastores.config(name as ConfigDatastore),
      owned: operational,
      defaults: operational ? undefined : reader.defaults(wd),
      filter,
      origins,
      prune,
      withOrigin,
      plan,
    });
    return [result, ...warnings];
  });
}

export class Reader {
  readonly #moduleByNamespace = new Map<string, string>();

  constructor(
    readonly device: Device,
    readonly datastores: Datastores,
  ) {
    for (const m of device.schema.allModules) if (!this.#moduleByNamespace.has(m.namespace)) this.#moduleByNamespace.set(m.namespace, m.name);
  }

  /** What a session may read, for a message: undefined when access isn't checked. */
  plan(access: Subject | undefined): ReadPlan | undefined {
    return access === undefined ? undefined : readPlan(access, this.device.schema);
  }

  /** Runs a read for a tree to use, such as copy-config's source. */
  retrieve(r: Retrieval): DataTree {
    return this.#run(r, true).tree;
  }

  /** Runs a read for a reply: `<data>` in `ns`. */
  reply(ns: string, r: Retrieval): XmlElement {
    const { tree, skip } = this.#run(r, false);
    return dataElement(ns, tree, skip);
  }

  /**
   * Runs a read: defaults, access control, filter, origin filter, pruning,
   * then origins dropped unless asked for. Unless `materialise`, a snapshot
   * that only needs nodes left out isn't copied: the nodes come back in
   * `skip`, for the encoder to leave out (NACM design §7.1).
   */
  #run(r: Retrieval, materialise: boolean): { tree: DataTree; skip?: ReadonlySet<InstanceNode> } {
    let tree = r.tree;
    let owned = r.owned;
    // Defaults first, so content matches see them and filters select them (RFC 6243 §2).
    if (r.defaults !== undefined && (owned || r.defaults !== 'explicit')) {
      if (!owned) tree = mergeTrees(tree);
      owned = true;
      applyWithDefaults(tree, r.defaults);
    }
    // NACM (design §7.1): after defaults, so none come back for a leaf the user can't read; before filters, so they select only readable nodes.
    if (r.plan !== undefined && r.plan.root !== 'permit') {
      const pruner = r.plan.pruner();
      const drops = pruner.drops(tree);
      if (drops.length > 0) {
        if (owned) removeAll(drops);
        else if (!materialise && r.filter === undefined && r.origins === undefined && r.prune === undefined) return { tree, skip: new Set(drops) };
        else {
          tree = pruneTree(tree, { keep: pruner.keep });
          owned = true;
        }
      }
    }
    if (r.filter !== undefined) {
      tree = this.filter(tree, r.filter);
      owned = true;
    }
    if (r.origins !== undefined) {
      tree = selectionTree(tree, originMatches(tree, r.origins));
      owned = true;
    }
    if (r.prune !== undefined) {
      tree = pruneTree(tree, r.prune);
      owned = true;
    }
    if (r.withOrigin !== true && owned) stripOrigins(tree);
    return { tree };
  }

  /** What a filter selects from a tree, as a new tree (RFC 6241 §6, §8.9). */
  filter(tree: DataTree, filter: Filter): DataTree {
    return filter.kind === 'subtree' ? subtreeFilter(tree, filter.content, { scope: filter.scope }) : selectionTree(tree, this.#xpath(tree, filter));
  }

  /** The with-defaults mode for a read: the parameter, or the basic mode (RFC 6243 §4.3). */
  defaults(element: XmlElement | undefined): WithDefaultsMode | undefined {
    const wd = this.device.protocol.withDefaults;
    if (element === undefined) return wd === false ? undefined : wd.basicMode;
    const mode = element.text().trim();
    if (wd === false || !WITH_DEFAULTS_MODES.includes(mode as WithDefaultsMode) || (mode !== wd.basicMode && !wd.alsoSupported.includes(mode as WithDefaultsMode))) {
      throw invalid(`The server doesn't support with-defaults mode ${JSON.stringify(mode)}`, 'with-defaults');
    }
    return mode as WithDefaultsMode;
  }

  /** `<get>` and `<get-config>`'s `<filter>`: subtree by default, or xpath with :xpath. */
  netconfFilter(element: XmlElement | undefined): Filter | undefined {
    if (element === undefined) return undefined;
    const type = element.attr('type') ?? element.attr('type', NETCONF_NS) ?? 'subtree';
    if (type === 'subtree') return { kind: 'subtree', content: element.children, scope: element.inScope };
    if (type !== 'xpath') {
      throw new RpcFailure({
        type: 'protocol',
        tag: 'bad-attribute',
        message: `Unknown filter type ${JSON.stringify(type)}`,
        info: [info('bad-attribute', 'type'), info('bad-element', 'filter')],
      });
    }
    if (!this.device.protocol.xpath) throw new RpcFailure({ ...operationNotSupported('filter'), message: 'XPath filters need the :xpath capability, which the device does not have' });
    const select = element.attr('select') ?? element.attr('select', NETCONF_NS);
    if (select === undefined) {
      throw new RpcFailure({
        type: 'protocol',
        tag: 'missing-attribute',
        message: 'An xpath filter needs a select attribute',
        info: [info('bad-attribute', 'select'), info('bad-element', 'filter')],
      });
    }
    return { kind: 'xpath', select, scope: element.inScope, element: 'filter' };
  }

  /** The local name of an identityref value, when it is in `namespace`. */
  identity(element: XmlElement, namespace: string): string | undefined {
    return identityName(element, namespace);
  }

  /** get-data's origin-filter or negated-origin-filter, resolved to identities. */
  originFilters(operation: XmlElement, operational: boolean): Retrieval['origins'] {
    const plain = operation.childrenNamed('origin-filter', NMDA_NS);
    const negated = operation.childrenNamed('negated-origin-filter', NMDA_NS);
    if (plain.length === 0 && negated.length === 0) return undefined;
    if (!operational) throw invalid('Origin filters are only valid for the operational datastore', plain.length > 0 ? 'origin-filter' : 'negated-origin-filter');
    if (plain.length > 0 && negated.length > 0) throw invalid('Use origin-filter or negated-origin-filter, not both', 'negated-origin-filter');
    const origins = this.device.schema.module('ietf-origin')?.identities;
    const base = origins?.get('origin');
    const identities = (plain.length > 0 ? plain : negated).map((el) => {
      const text = el.text().trim();
      const colon = text.indexOf(':');
      const module = this.#moduleByNamespace.get(el.inScope.get(colon === -1 ? '' : text.slice(0, colon)) ?? '');
      const identity = module === undefined ? undefined : this.device.schema.module(module)?.identities.get(text.slice(colon + 1));
      if (identity === undefined || base === undefined || (identity !== base && !base.derived.has(identity))) throw invalid(`${text} is not an origin`, el.name);
      return identity;
    });
    return { identities, negated: negated.length > 0, unknown: origins?.get('unknown') };
  }

  /** get-data's config-filter and max-depth. */
  prune(operation: XmlElement): PruneOptions | undefined {
    const config = operation.child('config-filter', NMDA_NS)?.text().trim();
    const depth = operation.child('max-depth', NMDA_NS)?.text().trim();
    if (config !== undefined && config !== 'true' && config !== 'false') throw invalid('config-filter is true or false', 'config-filter');
    let maxDepth: number | undefined;
    if (depth !== undefined && depth !== 'unbounded') {
      maxDepth = /^[0-9]{1,5}$/.test(depth) ? Number(depth) : NaN;
      if (!(maxDepth >= 1 && maxDepth <= 65535)) throw invalid('max-depth is 1 to 65535 or unbounded', 'max-depth');
    }
    if (config === undefined && maxDepth === undefined) return undefined;
    return { ...(config === undefined ? {} : { config: config === 'true' }), ...(maxDepth === undefined ? {} : { maxDepth }) };
  }

  /** The node-set an XPath filter selects (RFC 6241 §8.9), with prefixes from the namespaces in scope. */
  #xpath(tree: DataTree, filter: Extract<Filter, { kind: 'xpath' }>): (InstanceNode | DataTree)[] {
    const prefixes = new Map<string, string>();
    for (const [prefix, uri] of filter.scope) {
      const module = this.#moduleByNamespace.get(uri);
      if (prefix !== '' && module !== undefined) prefixes.set(prefix, module);
    }
    let value: unknown;
    try {
      value = evaluateXPath(tree, filter.select, { prefixes });
    } catch (err) {
      if (err instanceof XPathError) throw invalid(`Invalid XPath filter: ${err.message}`, filter.element);
      throw err;
    }
    if (!Array.isArray(value)) throw invalid('The XPath filter does not select a node-set', filter.element);
    return value as (InstanceNode | DataTree)[];
  }
}

/** Takes nodes out of a tree built for this read: one pass over each parent's children, however many go. */
function removeAll(nodes: readonly InstanceNode[]): void {
  const byParent = new Map<DataTree | InstanceNode, Set<InstanceNode>>();
  for (const n of nodes) {
    const parent = n.parent!;
    let set = byParent.get(parent);
    if (set === undefined) byParent.set(parent, (set = new Set()));
    set.add(n);
  }
  for (const [parent, gone] of byParent) {
    const children = (parent as { children: InstanceNode[] }).children;
    let kept = 0;
    for (const c of children) {
      if (gone.has(c)) c.parent = undefined;
      else children[kept++] = c;
    }
    children.length = kept;
  }
}

/**
 * The nodes an origin filter keeps: every state node, and each configuration
 * node with no configuration children whose effective origin is (or derives
 * from) one of the identities, or none of them when negated. A configuration
 * node with no origin counts as `or:unknown` (RFC 8526 §3.1.1).
 */
function originMatches(tree: DataTree, { identities, negated, unknown }: NonNullable<Retrieval['origins']>): InstanceNode[] {
  const out: InstanceNode[] = [];
  const matches = (node: InstanceNode): boolean => {
    const origin = effectiveOrigin(node) ?? unknown;
    const hit = identities.some((f) => origin !== undefined && typeof origin !== 'string' && (origin === f || f.derived.has(origin)));
    return hit !== negated;
  };
  const visit = (nodes: readonly InstanceNode[]): void => {
    for (const n of nodes) {
      if (!n.schema.config) {
        out.push(n);
        continue;
      }
      const children = 'children' in n ? n.children : [];
      if (children.length > 0) visit(children);
      else if (matches(n)) out.push(n);
    }
  };
  visit(tree.children);
  return out;
}
