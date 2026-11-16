/**
 * Test support for NACM: the acme modules of RFC 8341 Appendix A, a device
 * implementing ietf-netconf-acm with them, and the Appendix's policies as
 * RFC 7951 JSON.
 */

import { memorySource, type JsonValue } from '@node-net/yang/core';
import type { DeviceDefinition } from '../src/core.js';

/** Appendix A.2's ietf-netconf-monitoring module rules need that module; the others come from these. */
const ACME_NETCONF = `module acme-netconf {
  yang-version 1.1;
  namespace "http://example.com/ns/netconf";
  prefix acme;
  import ietf-netconf-acm { prefix nacm; }
  container acme-netconf {
    container config-parameters {
      leaf speed { type string; }
    }
    container secret {
      nacm:default-deny-all;
      leaf key { type string; }
    }
    container protected {
      nacm:default-deny-write;
      leaf value { type string; }
    }
  }
  rpc reboot { nacm:default-deny-all; }
  rpc ping;
}`;

const ACME_ITF = `module acme-itf {
  yang-version 1.1;
  namespace "http://example.com/ns/itf";
  prefix acme;
  container interfaces {
    list interface {
      key name;
      leaf name { type string; }
      leaf mtu { type uint16; }
      action reset;
      notification link-flap;
    }
  }
}`;

const ACME_SYSTEM = `module acme-system {
  yang-version 1.1;
  namespace "http://example.com/ns/system";
  prefix sys;
  import ietf-netconf-acm { prefix nacm; }
  notification sys-config-change;
  notification sys-alarm { nacm:default-deny-all; }
}`;

export const ACME_SOURCE = memorySource([{ text: ACME_NETCONF }, { text: ACME_ITF }, { text: ACME_SYSTEM }]);

/** A device implementing ietf-netconf-acm and the acme modules, with :startup and :notification. */
export const NACM_DEVICE: DeviceDefinition = {
  id: 'nacm',
  yang: { modules: ['ietf-netconf-acm', 'acme-netconf', 'acme-itf', 'acme-system'] },
  capabilities: { startup: true, notification: true, interleave: true },
};

/** The same device without ietf-netconf-acm. */
export const NO_NACM_DEVICE: DeviceDefinition = { ...NACM_DEVICE, id: 'no-nacm', yang: { modules: ['acme-netconf', 'acme-itf', 'acme-system'] } };

type Json = Record<string, JsonValue>;

/** Appendix A.1's groups. */
export const GROUPS: Json = {
  group: [
    { name: 'admin', 'user-name': ['admin', 'andy'] },
    { name: 'limited', 'user-name': ['wilma', 'bam-bam'] },
    { name: 'guest', 'user-name': ['guest', 'guest@example.com'] },
  ],
};

/** A.2 Module Rule Example. */
export const A2: Json = {
  groups: GROUPS,
  'rule-list': [
    { name: 'guest-acl', group: ['guest'], rule: [{ name: 'deny-ncm', 'module-name': 'ietf-netconf-monitoring', 'access-operations': '*', action: 'deny' }] },
    {
      name: 'limited-acl',
      group: ['limited'],
      rule: [
        { name: 'permit-ncm', 'module-name': 'ietf-netconf-monitoring', 'access-operations': 'read', action: 'permit' },
        { name: 'permit-exec', 'module-name': '*', 'access-operations': 'exec', action: 'permit' },
      ],
    },
    { name: 'admin-acl', group: ['admin'], rule: [{ name: 'permit-all', 'module-name': '*', 'access-operations': '*', action: 'permit' }] },
  ],
};

/** A.3 Protocol Operation Rule Example. */
export const A3: Json = {
  groups: GROUPS,
  'rule-list': [
    {
      name: 'guest-limited-acl',
      group: ['limited', 'guest'],
      rule: [
        { name: 'deny-kill-session', 'module-name': 'ietf-netconf', 'rpc-name': 'kill-session', 'access-operations': 'exec', action: 'deny' },
        { name: 'deny-delete-config', 'module-name': 'ietf-netconf', 'rpc-name': 'delete-config', 'access-operations': 'exec', action: 'deny' },
      ],
    },
    { name: 'limited-acl', group: ['limited'], rule: [{ name: 'permit-edit-config', 'module-name': 'ietf-netconf', 'rpc-name': 'edit-config', 'access-operations': 'exec', action: 'permit' }] },
  ],
};

/** A.4 Data Node Rule Example, with the acme paths in RFC 7951 form. */
export const A4: Json = {
  groups: GROUPS,
  'rule-list': [
    { name: 'guest-acl', group: ['guest'], rule: [{ name: 'deny-nacm', path: '/ietf-netconf-acm:nacm', 'access-operations': '*', action: 'deny' }] },
    {
      name: 'limited-acl',
      group: ['limited'],
      rule: [{ name: 'permit-acme-config', path: '/acme-netconf:acme-netconf/config-parameters', 'access-operations': 'read create update delete', action: 'permit' }],
    },
    {
      name: 'guest-limited-acl',
      group: ['guest', 'limited'],
      rule: [{ name: 'permit-dummy-interface', path: "/acme-itf:interfaces/interface[name='dummy']", 'access-operations': 'read update', action: 'permit' }],
    },
    { name: 'admin-acl', group: ['admin'], rule: [{ name: 'permit-interface', path: '/acme-itf:interfaces/interface', 'access-operations': '*', action: 'permit' }] },
  ],
};

/** A.5 Notification Rule Example. */
export const A5: Json = {
  groups: GROUPS,
  'rule-list': [
    {
      name: 'sys-acl',
      group: ['limited', 'guest'],
      rule: [{ name: 'deny-config-change', 'module-name': 'acme-system', 'notification-name': 'sys-config-change', 'access-operations': 'read', action: 'deny' }],
    },
  ],
};

/** `/nacm` as running content. */
export function nacm(content: Json): Json {
  return { 'ietf-netconf-acm:nacm': content };
}
