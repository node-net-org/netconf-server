# Base modules

IETF modules the server implements for its own protocol support that
@node-net/yang does not bundle. @node-net/yang's bundled modules (ietf-netconf,
ietf-netconf-with-defaults, ietf-yang-library, ietf-datastores, ietf-origin
and the common types) are used from there. These files are embedded in the
library by `scripts/gen-base-modules.mjs`, so the Node-free core needs no
filesystem, and are named `name@revision.yang`. They were taken from the
netopeer2/sysrepo distribution, which ships them as published.

| Module | Revision | RFC |
|--------|----------|-----|
| ietf-netconf-monitoring | 2010-10-04 | 6022 |
| ietf-netconf-nmda | 2019-01-07 | 8526 |
| ietf-netconf-notifications | 2012-02-06 | 6470 |
| notifications | 2008-07-14 | 5277 |
| nc-notifications | 2008-07-14 | 5277 |

One module is the server's own:

| Module | Revision | What |
|--------|----------|------|
| net-netconf-server-monitoring | 2026-11-15 | The `in-process` transport identity reported in NETCONF monitoring for sessions without a network transport, whether each session is a NACM recovery session, and the registered providers with their out-of-sync state |

The IETF modules are code components of IETF documents. They are licensed under
the Simplified BSD License set forth in Section 4.c of the IETF Trust's Legal
Provisions Relating to IETF Documents (https://trustee.ietf.org/license-info).
