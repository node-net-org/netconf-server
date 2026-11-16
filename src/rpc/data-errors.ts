/**
 * Problems @node-net/yang finds in configuration, as `<rpc-error>`s (WRITE-04).
 * @node-net/yang reports issues with its own codes and stays protocol-agnostic;
 * the NETCONF error-tags come from RFC 6241 Appendix A and the error-app-tags
 * from RFC 7950 §15. Every issue becomes its own rpc-error, so a client sees
 * every violation in one reply.
 */

import { x, YANG_NS, type XmlNode } from '@node-net/netconf/core';
import { readJsonValue, writeXmlText, type CompiledModule, type DataIssue, type InstanceIdentifier, type Schema, type YangType } from '@node-net/yang/core';
import type { RpcErrorSpec } from './errors.js';
import { info } from './errors.js';

type Tag = RpcErrorSpec['tag'];

/** The error-tag for each @node-net/yang issue code. Codes not listed are operation-failed. */
const TAGS: Readonly<Record<string, Tag>> = {
  // Reading the edit (RFC 6241 Appendix A).
  'unknown-node': 'unknown-element',
  'wrong-namespace': 'unknown-namespace',
  'invalid-value': 'invalid-value',
  'missing-key': 'missing-element',
  'duplicate-node': 'bad-element',
  'unexpected-content': 'bad-element',
  'unknown-annotation': 'unknown-attribute',
  'invalid-edit': 'invalid-value',
  // Applying it (RFC 6241 §7.2, RFC 7950 §15.7).
  'data-exists': 'data-exists',
  'data-missing': 'data-missing',
  'missing-anchor': 'bad-attribute',
  'multiple-cases': 'bad-element',
  // Validating the result (RFC 7950 §15, §8.3.3).
  'when-false': 'unknown-element',
  'missing-instance': 'data-missing',
  'missing-mandatory': 'data-missing',
  'missing-choice': 'data-missing',
  'missing-parent': 'data-missing',
};

/** The error-app-tag for codes whose app tag RFC 7950 §15 fixes, when @node-net/yang didn't give one. */
const APP_TAGS: Readonly<Record<string, string>> = {
  'must-violation': 'must-violation',
  'missing-instance': 'instance-required',
  'not-unique': 'data-not-unique',
  'too-many-elements': 'too-many-elements',
  'too-few-elements': 'too-few-elements',
  'missing-choice': 'missing-choice',
  'missing-anchor': 'missing-instance',
};

/** The rpc-errors for a list of issues; warnings are left out. */
export function issueErrors(issues: readonly DataIssue[], schema: Schema): RpcErrorSpec[] {
  return issues.filter((i) => i.severity !== 'warning').map((i) => issueError(i, schema));
}

export function issueError(issue: DataIssue, schema: Schema): RpcErrorSpec {
  const tag = TAGS[issue.code] ?? 'operation-failed';
  const appTag = issue.appTag ?? APP_TAGS[issue.code];
  const path = errorPath(issue.path, schema);
  const infos: XmlNode[] = [];
  const leaf = lastName(issue.path);
  if (tag === 'unknown-element' || tag === 'missing-element' || tag === 'bad-element' || tag === 'unknown-namespace') {
    if (leaf !== undefined) infos.push(info('bad-element', leaf));
  }
  if (issue.code === 'not-unique') {
    for (const p of issue.nonUnique ?? []) {
      const np = errorPath(p, schema);
      infos.push(x('non-unique', { xmlns: YANG_NS, ...np.declarations }, np.text));
    }
  }
  if (issue.code === 'missing-choice' && issue.missingChoice !== undefined) {
    infos.push(x('missing-choice', { xmlns: YANG_NS }, issue.missingChoice));
  }
  return {
    type: 'application',
    tag,
    ...(appTag === undefined ? {} : { appTag }),
    ...(path.text === '/' ? {} : { path: path.text, pathDeclarations: path.declarations }),
    message: issue.message,
    ...(infos.length > 0 ? { info: infos } : {}),
  };
}

const INSTANCE_IDENTIFIER: YangType = Object.freeze({ name: 'instance-identifier', builtin: 'instance-identifier', patterns: [], requireInstance: false });

/**
 * An RFC 7951 data path (`/mod:a/b[name='x']`) as an XPath for
 * `<error-path>` (RFC 6241 §4.3): every step prefixed, with each prefix
 * (the module's name) declared. A path @node-net/yang can't read back stays as it
 * is.
 */
export function errorPath(path: string, schema: Schema): { text: string; declarations: Record<string, string> } {
  if (path === '/' || path === '') return { text: '/', declarations: {} };
  const anyModule = schema.implemented[0];
  const read = anyModule === undefined ? path : readJsonValue(schema, INSTANCE_IDENTIFIER, path, anyModule);
  if (typeof read === 'string') return { text: path, declarations: {} };
  const id = read.value as InstanceIdentifier;
  const declarations: Record<string, string> = {};
  const prefix = (m: CompiledModule): string => {
    declarations[`xmlns:${m.name}`] = m.namespace;
    return m.name;
  };
  let text = '';
  for (const step of id.steps) {
    text += `/${prefix(step.node.module)}:${step.node.name}`;
    for (const k of step.keys ?? []) text += `[${prefix(k.key.module)}:${k.key.name}=${quote(writeXmlText(k.value, prefix, schema))}]`;
    if (step.value !== undefined) text += `[.=${quote(writeXmlText(step.value, prefix, schema))}]`;
    if (step.position !== undefined) text += `[${step.position}]`;
  }
  return { text, declarations };
}

function quote(s: string): string {
  return s.includes("'") ? `"${s}"` : `'${s}'`;
}

/** The last step's name in an RFC 7951 path, without prefix or predicates. */
function lastName(path: string): string | undefined {
  const step = path.replace(/\[[^\]]*\]/g, '').split('/').at(-1);
  if (step === undefined || step === '') return undefined;
  return step.slice(step.indexOf(':') + 1);
}
