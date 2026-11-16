# The lab device's YANG modules

Copies of published modules, unchanged except for their file names (`name@revision.yang`). The lab device compiles them with @node-net/yang's bundled modules (ietf-yang-types, ietf-inet-types, ietf-netconf-acm and the NETCONF base modules), so those aren't repeated here.

## OpenConfig

From [openconfig/public](https://github.com/openconfig/public) at commit `fa27bd6ac13d14a167719bbf4eac48b1f298e43f` (2026-11-11), under the Apache License 2.0: see [LICENSE-openconfig](./LICENSE-openconfig). The lab device implements openconfig-interfaces, -if-ethernet, -if-aggregate, -vlan, -lacp, -lldp, -platform, -platform-port and -platform-transceiver. The other modules are their imports.

Left out: openconfig-if-ip and openconfig-system, which import openconfig-network-instance and about 100 more modules. Without openconfig-network-instance, openconfig-vlan offers VLAN membership on ports (`switched-vlan`) but not the list of VLANs, which is instantiated only within a network instance.

| File | Upstream path |
|---|---|
| `openconfig-alarm-types@2018-11-21.yang` | `release/models/system/openconfig-alarm-types.yang` |
| `openconfig-extensions@2025-01-02.yang` | `release/models/openconfig-extensions.yang` |
| `openconfig-if-aggregate@2026-01-06.yang` | `release/models/interfaces/openconfig-if-aggregate.yang` |
| `openconfig-if-ethernet@2026-06-22.yang` | `release/models/interfaces/openconfig-if-ethernet.yang` |
| `openconfig-inet-types@2025-06-18.yang` | `release/models/types/openconfig-inet-types.yang` |
| `openconfig-interfaces@2026-10-05.yang` | `release/models/interfaces/openconfig-interfaces.yang` |
| `openconfig-lacp@2026-04-09.yang` | `release/models/lacp/openconfig-lacp.yang` |
| `openconfig-lldp@2026-04-14.yang` | `release/models/lldp/openconfig-lldp.yang` |
| `openconfig-lldp-types@2025-12-09.yang` | `release/models/lldp/openconfig-lldp-types.yang` |
| `openconfig-platform@2026-07-08.yang` | `release/models/platform/openconfig-platform.yang` |
| `openconfig-platform-common@2026-07-08.yang` | `release/models/platform/openconfig-platform-common.yang` |
| `openconfig-platform-port@2023-03-22.yang` | `release/models/platform/openconfig-platform-port.yang` |
| `openconfig-platform-transceiver@2026-03-25.yang` | `release/models/platform/openconfig-platform-transceiver.yang` |
| `openconfig-platform-types@2026-08-29.yang` | `release/models/platform/openconfig-platform-types.yang` |
| `openconfig-transport-types@2026-10-27.yang` | `release/models/optical-transport/openconfig-transport-types.yang` |
| `openconfig-types@2026-08-13.yang` | `release/models/types/openconfig-types.yang` |
| `openconfig-vlan@2023-02-07.yang` | `release/models/vlan/openconfig-vlan.yang` |
| `openconfig-vlan-types@2026-06-24.yang` | `release/models/vlan/openconfig-vlan-types.yang` |
| `openconfig-yang-types@2024-05-30.yang` | `release/models/types/openconfig-yang-types.yang` |

## IETF and IANA

Each module carries its own copyright notice: Copyright (c) the IETF Trust and the persons identified as authors, redistributed under the Simplified BSD License set forth in Section 4.c of the IETF Trust's Legal Provisions Relating to IETF Documents (https://trustee.ietf.org/license-info).

| File | Source |
|---|---|
| `ietf-interfaces@2018-02-20.yang` | RFC 8343, as copied in openconfig/public at the commit above (`third_party/ietf/ietf-interfaces.yang`) |
| `iana-if-type@2017-01-19.yang` | IANA, as copied in openconfig/public at the commit above (`third_party/ietf/iana-if-type.yang`) |
| `ietf-system@2014-08-06.yang` | RFC 7317, from [YangModels/yang](https://github.com/YangModels/yang) at commit `8b2414f42773a6fa97251ae8e7e3006649dff6d1` (`standard/ietf/RFC/`) |
| `iana-crypt-hash@2014-08-06.yang` | RFC 7317, from YangModels/yang at the same commit |
