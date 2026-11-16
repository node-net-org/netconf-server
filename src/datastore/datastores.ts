/**
 * The NMDA datastores (RFC 8342, design §5): separate @node-net/yang trees for
 * running, candidate and startup, with intended an alias of running until
 * the server has template expansion or inactive configuration, and
 * operational built on each read from running's configuration, the state
 * the server holds (operational.ts) and the state it produces.
 *
 * Every tree held here is an immutable snapshot (design §8): reads use it
 * as it is and never change it, and writes replace it whole. A read that
 * started before a write finishes keeps the tree it began with (READ-07).
 *
 * The candidate (RFC 6241 §8.3) is running itself until it is changed. Once
 * changed it keeps its own tree, the running snapshot it was changed from
 * (`base`), and the sessions that changed it, until a commit or
 * discard-changes makes it running again.
 */

import { ORIGIN_NS } from '@node-net/netconf/core';
import { DataTree, decodeJson, mergeTrees, readJsonValue, type Annotation, type InstanceNode, type JsonValue, type Schema } from '@node-net/yang/core';
import type { Device } from '../device/load.js';

export type ConfigDatastore = 'running' | 'candidate' | 'startup' | 'intended';
export type DatastoreName = ConfigDatastore | 'operational';

/** State the server produces itself, as RFC 7951 JSON members: the YANG library, monitoring. */
export type StateSource = () => Record<string, JsonValue>;

/** An uncommitted candidate. */
export interface CandidateChanges {
  /** The candidate's content. */
  readonly tree: DataTree;
  /** The running snapshot the changes were made against. */
  readonly base: DataTree;
  /** The sessions that changed it, ended ones included. */
  readonly modifiedBy: ReadonlySet<number>;
}

/** The trees the server starts with: the device's initial data, or what a store saved. */
export interface StartTrees {
  readonly running: DataTree;
  readonly startup: DataTree | undefined;
}

export class Datastores {
  readonly #operationalView: Schema;
  readonly #state: readonly StateSource[];
  readonly #held: () => DataTree;
  readonly #hasCandidate: boolean;
  #running: DataTree;
  #candidate: CandidateChanges | undefined;
  #startup: DataTree | undefined;

  /**
   * @param state the state the server produces itself
   * @param held the state the server holds: by default the device's operational file
   */
  constructor(device: Device, state: readonly StateSource[], start: StartTrees = device.initial, held: () => DataTree = () => device.initial.operational) {
    this.#operationalView = device.schema.forDatastore('operational');
    this.#state = state;
    this.#held = held;
    this.#hasCandidate = device.protocol.candidate;
    this.#running = start.running;
    this.#startup = device.protocol.startup ? start.startup : undefined;
  }

  /** Whether the server implements a datastore. */
  has(name: string): boolean {
    switch (name) {
      case 'running':
      case 'intended':
      case 'operational':
        return true;
      case 'candidate':
        return this.#hasCandidate;
      case 'startup':
        return this.#startup !== undefined;
      default:
        return false;
    }
  }

  /** A configuration datastore's current snapshot. Never change it. */
  config(name: ConfigDatastore): DataTree {
    switch (name) {
      case 'running':
      case 'intended':
        return this.#running;
      case 'candidate':
        if (!this.#hasCandidate) fail(name);
        return this.#candidate?.tree ?? this.#running;
      case 'startup':
        return this.#startup ?? fail(name);
    }
  }

  get running(): DataTree {
    return this.#running;
  }

  /** The candidate's uncommitted changes, or undefined when it equals running. */
  get candidate(): CandidateChanges | undefined {
    return this.#candidate;
  }

  /** Replaces running. The candidate, if unchanged, follows it. */
  setRunning(tree: DataTree): void {
    this.#running = tree;
  }

  /** Replaces startup. */
  setStartup(tree: DataTree): void {
    if (this.#startup === undefined) fail('startup');
    this.#startup = tree;
  }

  /** Replaces the candidate's content after a change by `sessionId`. */
  setCandidate(tree: DataTree, sessionId: number | undefined): void {
    const before = this.#candidate;
    const modifiedBy = new Set(before?.modifiedBy ?? []);
    if (sessionId !== undefined) modifiedBy.add(sessionId);
    this.#candidate = { tree, base: before?.base ?? this.#running, modifiedBy };
  }

  /** Makes the candidate equal to running again: after commit, discard-changes, or a released lock. */
  resetCandidate(): void {
    this.#candidate = undefined;
  }

  /**
   * A new `<operational>` tree: running's configuration, tagged with origin
   * `intended`, merged with the state the server holds (the device's
   * operational file, pushed updates and read hooks' results) and the state
   * it produces. The caller owns it.
   */
  operational(): DataTree {
    const view = this.#operationalView;
    const produced = this.#state.map((s) => decodeJson(view, s()));
    const tree = mergeTrees(new DataTree(view), this.#running, this.#held(), ...produced);
    // Configuration in use came from <intended> (RFC 8342 §5.3.4); nodes inherit their parent's origin.
    const intended = originAnnotation(view, 'ietf-origin:intended');
    if (intended !== undefined) {
      for (const node of tree.children) {
        if (node.schema.config && !hasOrigin(node)) node.annotations.push(intended);
      }
    }
    return tree;
  }
}

function fail(name: string): never {
  throw new Error(`The device has no ${name} datastore`);
}

function hasOrigin(node: InstanceNode): boolean {
  return node.annotations.some((a) => a.name === 'origin' && (a.namespace === ORIGIN_NS || a.module === 'ietf-origin'));
}

/** A typed `or:origin` annotation, or undefined when the schema lacks ietf-origin. */
function originAnnotation(schema: Schema, identity: string): Annotation | undefined {
  const module = schema.module('ietf-origin');
  const definition = module?.annotations.get('origin');
  if (module === undefined || definition?.type === undefined) return undefined;
  const value = readJsonValue(schema, definition.type, identity, module);
  if (typeof value === 'string') return undefined;
  return { namespace: ORIGIN_NS, module: 'ietf-origin', name: 'origin', value, definition, prefix: 'or' };
}

/** Removes every `or:origin` annotation in a tree the caller owns, for replies without with-origin. */
export function stripOrigins(tree: DataTree): void {
  for (const node of tree.walk()) {
    if (node.annotations.length === 0) continue;
    const keep = node.annotations.filter((a) => !(a.name === 'origin' && (a.namespace === ORIGIN_NS || a.module === 'ietf-origin')));
    node.annotations.length = 0;
    node.annotations.push(...keep);
  }
}
