/** One problem with a device definition or its YANG modules. */
export interface DeviceIssue {
  /** Where: a JSON path into the definition (`$.yang.modules[2]`), or a file location for YANG. */
  readonly path: string;
  readonly message: string;
}

/** A device definition, or the YANG it names, can't be loaded. Lists every problem found. */
export class DeviceError extends Error {
  override name = 'DeviceError';
  readonly code = 'ERR_NETCONF_SERVER_DEVICE';
  readonly issues: readonly DeviceIssue[];

  constructor(message: string, issues: readonly DeviceIssue[], options?: ErrorOptions) {
    super(`${message}${issues.map((i) => `\n  ${i.path}: ${i.message}`).join('')}`, options);
    this.issues = issues;
  }
}

/** A store can't be opened, read or written: the state directory or file is named in `location`. */
export class StoreError extends Error {
  override name = 'StoreError';
  readonly code = 'ERR_NETCONF_SERVER_STORE';
  /** The directory or file. */
  readonly location: string;

  constructor(message: string, location: string, options?: ErrorOptions) {
    super(message, options);
    this.location = location;
  }
}
