/**
 * @node-net/netconf-server/core: the server with nothing from Node.js (design §2),
 * so it runs in a browser or a worker. Devices are given as data, modules
 * come from @node-net/yang sources, and clients connect in-process through
 * `server.transport()`.
 *
 * The root entry, @node-net/netconf-server (index.ts), is a superset that adds
 * loading device files. A guardrail (ESLint, dependency-cruiser and
 * portable:check) keeps everything this file reaches free of Node built-ins.
 */

export {
  createServer,
  NetconfServer,
  type ServerOptions,
  type ServerEvents,
  type SessionStartEvent,
  type SessionEndEvent,
  type SessionInfo,
  type ServeOptions,
  type TransportOptions,
  type RunningDatastore,
  type OperationalDatastore,
  type NotifyOptions,
} from './server.js';
export type { Authenticate, AuthAttempt, CertificateAttempt, Listener, PasswordAttempt, PublicKeyAttempt, Serve } from './auth.js';
export type { ControlOptions, ResetOptions, ServerControl } from './control/control.js';
export type { FaultAction, FaultInfo, FaultSpec, FaultTarget, FaultTrigger } from './control/faults.js';
export { QUIRKS, quirkSpec, type ActiveQuirks, type QuirkSettings, type QuirkSpec } from './quirks/catalogue.js';
export type { QuirkChange } from './quirks/state.js';
export type {
  HookContext,
  HookTimeouts,
  OperationCall,
  OperationCallHandler,
  OutOfSyncEvent,
  Provider,
  ProviderHandle,
  ProviderTransaction,
  ReadContext,
  SubtreeData,
  TransactionCause,
} from './provider/provider.js';
export type { StateChangedEvent, StateEdit } from './datastore/operational.js';
export type { LockableDatastore, LockChangedEvent, LockInfo, Locks } from './datastore/locks.js';
export type { CommitCause, CommitEvent, ConfirmedCommitEvent } from './datastore/writer.js';
export { memoryStore, type Store, type StoredDatastore } from './store/store.js';
export type { StartupMode } from './store/startup.js';
export type { Principal, SessionEndReason } from './session/session.js';
export type { AccessDeniedEvent, NacmOptions } from './nacm/engine.js';
export type { ServerSession } from './session/session.js';
export { systemClock, type Clock } from './clock.js';
export { DeviceError, StoreError, type DeviceIssue } from './errors.js';
export { loadDevice, type Device, type LoadDeviceOptions } from './device/load.js';
export type { DataReader, InitialData } from './device/data.js';
export { validateDefinition } from './device/validate.js';
export { BASE_1_0, BASE_1_1 } from '@node-net/netconf/core';
export { contentId, type ProtocolCapabilities } from './device/capabilities.js';
export {
  QUIRK_NAMES,
  WITH_DEFAULTS_MODES,
  type DeviceCapabilities,
  type DeviceData,
  type DeviceDefinition,
  type DeviceYang,
  type DeviceYangLibrary,
  type ModuleRef,
  type WithDefaultsMode,
} from './device/definition.js';
export { RpcFailure, type RpcErrorSpec } from './rpc/errors.js';
export type { OperationContext, OperationHandler, OperationResult } from './rpc/dispatch.js';
