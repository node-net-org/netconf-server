/**
 * NACM rule paths (RFC 8341 §3.5.2): a `node-instance-identifier`, held by
 * @node-net/yang in its JSON form with module names as prefixes, resolved
 * against the schema into the schema nodes it names, with any list key or
 * leaf-list values it requires.
 *
 * A path matches a requested node that is the node it names or a
 * descendant of it (§3.4.5 step 6). `/` names every node.
 */

import { dataChildren, DataTree, parseXPath, type InstanceNode, type Schema, type SchemaNode, type XPathExpr, type XPathStep } from '@node-net/yang/core';

/** One step of a resolved path: a schema node, and the values its instance must have, by key leaf name (`.` for a leaf-list's own value). */
export interface PathStep {
  readonly node: SchemaNode;
  readonly values: ReadonlyMap<string, string>;
}

/** Choice, case, input and output never appear in a data path. */
const TRANSPARENT = new Set(['choice', 'case', 'input', 'output']);

/**
 * The steps a path names, or why it can't be resolved: it isn't a plain
 * absolute location path, a step names a module or node the schema doesn't
 * have, or a predicate isn't a key value.
 */
export function resolvePath(schema: Schema, text: string): readonly PathStep[] | string {
  let ast: XPathExpr;
  try {
    ast = parseXPath(text.trim());
  } catch (err) {
    return `it is not valid XPath: ${(err as Error).message}`;
  }
  if (ast.type !== 'path' || ast.start !== 'root') return 'it is not an absolute location path';
  let candidates: readonly SchemaNode[] = [...schema.dataNodes, ...schema.rpcs, ...schema.notifications].flatMap((n) => (TRANSPARENT.has(n.kind) ? dataChildren(n) : [n]));
  let module: string | undefined;
  const steps: PathStep[] = [];
  for (const step of ast.steps) {
    if (step.axis !== 'child' || step.test.kind !== 'name') return 'only node names may be steps';
    if (step.test.prefix !== undefined) module = step.test.prefix;
    if (module === undefined) return `${step.test.name} names no module`;
    const name = step.test.name;
    const node = candidates.find((c) => c.name === name && c.module.name === module);
    if (node === undefined) return `the schema has no node ${module}:${name} there`;
    const values = keyValues(step, node);
    if (typeof values === 'string') return values;
    steps.push({ node, values });
    candidates = dataChildren(node);
  }
  return steps;
}

/** A step's predicates as key values, or why they aren't. */
function keyValues(step: XPathStep, node: SchemaNode): Map<string, string> | string {
  const values = new Map<string, string>();
  for (const p of step.predicates) {
    if (p.type !== 'binary' || p.op !== '=' || (p.right.type !== 'literal' && p.right.type !== 'number')) return 'a predicate must be a key = value';
    const value = String(p.right.value);
    const left = p.left;
    if (left.type !== 'path' || left.start !== 'context' || left.steps.length !== 1) return 'a predicate must be a key = value';
    const s = left.steps[0]!;
    if (node.kind === 'leaf-list' && s.axis === 'self' && s.test.kind === 'node') {
      values.set('.', value);
      continue;
    }
    if (node.kind !== 'list' || s.axis !== 'child' || s.test.kind !== 'name') return 'a predicate must be a key = value';
    const keyName = s.test.name;
    if (!node.keys.some((k) => k.name === keyName)) return `${keyName} is not a key of ${node.name}`;
    values.set(keyName, value);
  }
  return values;
}

/**
 * One node on the way to a requested node: its schema node, and its
 * instance when the request names one, or else the key values a path names
 * for it (as `PathStep.values`), such as an error-path's.
 */
export interface ChainLink {
  readonly node: SchemaNode;
  readonly instance: InstanceNode | undefined;
  readonly values?: ReadonlyMap<string, string>;
}

/** The data nodes from the top of the tree down to `target`, choice, case, input and output left out. */
export function chainOf(target: SchemaNode | InstanceNode): ChainLink[] {
  const out: ChainLink[] = [];
  if (isInstance(target)) {
    for (let n: InstanceNode | InstanceNode['parent'] = target; n !== undefined && !(n instanceof DataTree); n = n.parent) out.push({ node: n.schema, instance: n });
  } else {
    for (let n: SchemaNode | undefined = target; n !== undefined; n = n.parent) {
      if (!TRANSPARENT.has(n.kind)) out.push({ node: n, instance: undefined });
    }
  }
  return out.reverse();
}

/** Whether a path's steps name `chain`'s last node or one of its ancestors, with the key values it requires. */
export function pathMatches(steps: readonly PathStep[], chain: readonly ChainLink[]): boolean {
  if (steps.length > chain.length) return false;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const link = chain[i]!;
    if (step.node !== link.node) return false;
    if (step.values.size === 0) continue;
    // A rule for particular instances says nothing about a request that names none.
    const instance = link.instance;
    if (instance === undefined && link.values === undefined) return false;
    for (const [key, value] of step.values) {
      if ((instance === undefined ? link.values!.get(key) : instanceValue(instance, key)) !== value) return false;
    }
  }
  return true;
}

/** A list entry's key value, or a leaf-list entry's own value (`.`), as text. */
export function instanceValue(instance: InstanceNode, key: string): string | undefined {
  if (key === '.') return instance.kind === 'leaf-list' ? valueText(instance.value.value) : undefined;
  if (instance.kind !== 'list') return undefined;
  const leaf = instance.keys.find((k) => k.schema.name === key);
  return leaf === undefined ? undefined : valueText(leaf.value.value);
}

/** A value as a predicate would write it: an identity as `module:name`. */
export function valueText(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'module' in value && 'name' in value && 'bases' in value) {
    const id = value as { module: { name: string }; name: string };
    return `${id.module.name}:${id.name}`;
  }
  if (Array.isArray(value)) return value.join(' ');
  return String(value);
}

function isInstance(n: SchemaNode | InstanceNode): n is InstanceNode {
  return 'schema' in n;
}
