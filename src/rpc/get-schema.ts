/**
 * `<get-schema>` (RFC 6022 §3.1, SCHEMA-02): a module's or submodule's
 * source, from the module source the device was compiled from, as YANG or
 * YIN, whichever form the source holds it in.
 */

import { MONITORING_NS, parseXml, XmlElement } from '@node-net/netconf/core';
import { parseModuleText, substatement, substatements, writeYang, writeYin, type Schema } from '@node-net/yang/core';
import type { Device } from '../device/load.js';
import type { Dispatcher } from './dispatch.js';
import { info, RpcFailure } from './errors.js';

interface Candidate {
  readonly name: string;
  readonly revision: string | undefined;
}

export function registerGetSchema(dispatcher: Dispatcher, device: Device): void {
  dispatcher.handle(MONITORING_NS, 'get-schema', async ({ operation }) => {
    const identifier = operation.child('identifier', MONITORING_NS)?.text().trim();
    if (identifier === undefined || identifier === '') {
      throw new RpcFailure({ type: 'protocol', tag: 'missing-element', message: 'get-schema needs an identifier', info: [info('bad-element', 'identifier')] });
    }
    const version = operation.child('version', MONITORING_NS)?.text().trim();
    const format = formatOf(operation.child('format', MONITORING_NS));

    const found = candidates(device.schema, identifier).filter((c) => version === undefined || (c.revision ?? '') === version);
    if (found.length === 0) {
      const what = version === undefined ? identifier : `${identifier} revision ${version}`;
      throw new RpcFailure({ type: 'protocol', tag: 'invalid-value', message: `The server has no schema ${what}`, info: [info('bad-element', version === undefined ? 'identifier' : 'version')] });
    }
    if (found.length > 1) {
      // RFC 6022 §3.1: more than one revision matches and none was asked for.
      throw new RpcFailure({
        type: 'protocol',
        tag: 'operation-failed',
        appTag: 'data-not-unique',
        message: `${identifier} has more than one revision (${found.map((c) => c.revision ?? 'none').join(', ')}): give a version`,
      });
    }
    const { name, revision } = found[0]!;
    const text = await device.source.load(name, revision);
    if (text === undefined) {
      throw new RpcFailure({ type: 'application', tag: 'operation-failed', message: `The source of ${name} is not available` });
    }
    const content = typeof text.text === 'string' ? text.text : new TextDecoder().decode(text.text);
    const isYin = text.format === 'yin' || (text.format === undefined && content.trimStart().startsWith('<'));

    if (format === 'yang') {
      // YANG as the source has it, or written from the YIN source's statement tree.
      const yang = isYin ? writeYang(parseModuleText({ text: content, format: 'yin', ...(text.source === undefined ? {} : { source: text.source }) }).statement) : content;
      return [new XmlElement({ name: 'data', ns: MONITORING_NS, children: [yang] })];
    }
    const yin = isYin ? content : toYin(device.schema, content, text.source);
    return [new XmlElement({ name: 'data', ns: MONITORING_NS, children: [parseXml(yin)] })];
  });
}

/** The modules and submodules called `identifier`, one per revision. */
function candidates(schema: Schema, identifier: string): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const m of schema.allModules) {
    if (m.name === identifier) seen.set(m.revision ?? '', { name: m.name, revision: m.revision });
    for (const s of m.includes) if (s.name === identifier) seen.set(s.revision ?? '', { name: s.name, revision: s.revision });
  }
  return [...seen.values()];
}

/** The format parameter: `ncm:yang` (the default) or `ncm:yin`. */
function formatOf(element: XmlElement | undefined): 'yang' | 'yin' {
  if (element === undefined) return 'yang';
  const text = element.text().trim();
  const colon = text.indexOf(':');
  const ns = element.inScope.get(colon === -1 ? '' : text.slice(0, colon));
  const name = text.slice(colon + 1);
  if (ns === MONITORING_NS && (name === 'yang' || name === 'yin')) return name;
  throw new RpcFailure({ type: 'protocol', tag: 'invalid-value', message: `The server doesn't provide schemas as ${text}`, info: [info('bad-element', 'format')] });
}

/** YANG text as YIN (RFC 7950 §13), with the module's and its imports' namespaces declared. */
function toYin(schema: Schema, text: string, source: string | undefined): string {
  const statement = parseModuleText({ text, ...(source === undefined ? {} : { source }) }).statement;
  const namespaces: Record<string, string> = {};
  const own = substatement(statement, 'prefix')?.argument ?? substatement(substatement(statement, 'belongs-to') ?? statement, 'prefix')?.argument;
  const ownModule = statement.keyword === 'module' ? statement.argument : substatement(statement, 'belongs-to')?.argument;
  const ownNs = ownModule === undefined ? undefined : schema.module(ownModule)?.namespace;
  if (own !== undefined && ownNs !== undefined) namespaces[own] = ownNs;
  for (const imp of substatements(statement, 'import')) {
    const prefix = substatement(imp, 'prefix')?.argument;
    const ns = imp.argument === undefined ? undefined : schema.module(imp.argument)?.namespace;
    if (prefix !== undefined && ns !== undefined) namespaces[prefix] = ns;
  }
  return writeYin(statement, { namespaces });
}
