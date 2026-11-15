"""Config-level evaluation of one packet through the compiled model.

This is NOT live packet forwarding. It walks the compiled IOS configs:

  1. src-port     source host sits on an enabled access port            -> l2-access-port
  2. src-trunk    source switch uplink carries the source VLAN           -> trunk-prune
  3. acl          ingress ACL on the source SVI, first match, implicit deny -> acl:<dev>:<acl>:<seq>
  4. route        longest match over connected SVIs on the routing device -> no-route
  5. dst-trunk    destination uplink carries the destination VLAN        -> trunk-prune
  6. dst-host     a host answers in that VLAN on an enabled port         -> blackhole / l2-access-port

Same-segment traffic is switched at L2: stages 3 and 4 are skipped and stage 5 checks the path.
Every stage is computed. The blocking layer is the first failing stage in the order above.
No transit link exists between the cores and the distribution switch, so no packet is ever routed
to a core routed port. The management-deny lines in the core's EXER-EGRESS are therefore never
evaluated and their hit counter is zero by construction.
"""

from __future__ import annotations

import ipaddress
from collections import Counter
from dataclasses import dataclass

from .parser import AclLine, Host, Interface, Model

PROTOS = frozenset({"icmp", "tcp", "udp"})


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool | None  # None means not applicable for this packet
    layer: str | None  # blocking layer when ok is False
    detail: str


@dataclass(frozen=True)
class Verdict:
    action: str  # permit | deny
    layer: str | None  # first blocking layer when action is deny, else None
    checks: tuple[Check, ...]
    layers: tuple[str, ...] = ()  # every failing layer. Independent layers all show here, not only the first

    @property
    def permitted(self) -> bool:
        return self.action == "permit"


def _verdict(checks: list[Check]) -> Verdict:
    failing = [c for c in checks if c.ok is False]
    if not failing:
        return Verdict("permit", None, tuple(checks))
    return Verdict("deny", failing[0].layer, tuple(checks), tuple(c.layer for c in failing))


def _addr(value) -> ipaddress.IPv4Address:
    return value if isinstance(value, ipaddress.IPv4Address) else ipaddress.IPv4Address(value)


class Engine:
    """Evaluates packets against a parsed Model. Holds the management-deny hit counter."""

    def __init__(self, model: Model):
        self.model = model
        self._mgmt = model.management_networks()
        self.mgmt_hits: Counter[str] = Counter()
        self.mgmt_deny_lines: tuple[AclLine, ...] = tuple(
            line
            for dev in model.devices.values()
            for lines in dev.acls.values()
            for line in lines
            if self._is_mgmt_deny(line)
        )

    def _is_mgmt_deny(self, line: AclLine) -> bool:
        if line.action != "deny" or line.dst.prefixlen == 0:
            return False
        return any(line.dst.overlaps(net) for net in self._mgmt)

    def evaluate(
        self,
        src_ip,
        dst_ip,
        proto: str,
        flags=(),
        dst_port: int | None = None,
    ) -> Verdict:
        """Permit or deny one packet. proto is icmp, tcp or udp. flags are TCP flags (SYN, ACK, RST)."""
        src_ip, dst_ip = _addr(src_ip), _addr(dst_ip)
        proto = proto.lower()
        if proto not in PROTOS:
            raise ValueError(f"unknown protocol {proto!r}")
        flags = frozenset(f.upper() for f in flags)
        m = self.model

        src = m.hosts.get(src_ip)
        if src is None or not src.enabled:
            return _verdict([Check("src-port", False, "l2-access-port", f"{src_ip} is not an enabled access-port host")])
        checks = [Check("src-port", True, None, f"{src_ip} on {src.device} {src.interface} vlan {src.vlan}")]

        routing = m.routing_svi(src.vlan)
        dst_host = m.hosts.get(dst_ip)
        if routing is None:
            kind, rvlan, riface, routing_dev = "none", None, None, None
        else:
            routing_dev = routing[0].name
            kind, rvlan, riface = self._route(routing_dev, dst_ip)
        same_segment = (dst_host is not None and dst_host.vlan == src.vlan) or (
            kind == "connected" and rvlan == src.vlan
        )

        if same_segment:
            checks.append(Check("acl", None, None, "same segment: switched at L2, no SVI"))
            checks.append(Check("route", None, None, "same segment"))
            checks.append(self._dst_trunk_same_segment(src, dst_host, routing_dev))
            checks.append(self._dst_host_check(dst_host, dst_ip, src.vlan))
            return _verdict(checks)

        if routing is None:
            checks.append(Check("acl", None, None, "no SVI for source vlan"))
            checks.append(Check("route", False, "no-route", f"no routing SVI for vlan {src.vlan}"))
            return _verdict(checks)

        if src.device != routing_dev:
            ok, detail = m.path_ok(src.device, routing_dev, src.vlan, hub=routing_dev)
            checks.append(Check("src-trunk", ok, None if ok else "trunk-prune", detail))
        else:
            checks.append(Check("src-trunk", None, None, "source on routing device"))

        checks.append(self._acl_check(routing_dev, routing[1], src_ip, dst_ip, proto, flags, dst_port))

        if kind == "none":
            checks.append(Check("route", False, "no-route", f"no connected SVI covers {dst_ip}"))
            checks.append(Check("dst-trunk", None, None, "not routed"))
            checks.append(Check("dst-host", None, None, "not routed"))
            return _verdict(checks)
        if kind == "local":
            checks.append(Check("route", True, None, f"{dst_ip} is the SVI address of vlan {rvlan} on {routing_dev}"))
            checks.append(Check("dst-trunk", None, None, "local delivery to routing device"))
            checks.append(Check("dst-host", None, None, "local delivery to routing device"))
            return _verdict(checks)

        checks.append(Check("route", True, None, f"{dst_ip} is in vlan {rvlan} ({riface.address.network})"))
        if dst_host is not None:
            if dst_host.device != routing_dev:
                ok, detail = m.path_ok(routing_dev, dst_host.device, rvlan, hub=routing_dev)
                checks.append(Check("dst-trunk", ok, None if ok else "trunk-prune", detail))
            else:
                checks.append(Check("dst-trunk", None, None, "destination on routing device"))
            checks.append(self._dst_host_check(dst_host, dst_ip, rvlan))
        else:
            carried = m.vlan_on_any_trunk(rvlan)
            checks.append(
                Check(
                    "dst-trunk",
                    carried,
                    None if carried else "trunk-prune",
                    f"vlan {rvlan} is {'carried by a trunk' if carried else 'carried by no trunk'}",
                )
            )
            checks.append(self._dst_host_check(None, dst_ip, rvlan))
        return _verdict(checks)

    # ----- stages -------------------------------------------------------------------------

    def _route(self, routing_dev: str, dst_ip: ipaddress.IPv4Address) -> tuple[str, int | None, Interface | None]:
        svis = self.model.connected_svis(routing_dev)
        for vlan, iface in svis:
            if dst_ip == iface.address.ip:
                return "local", vlan, iface
        best: tuple[int, Interface] | None = None
        for vlan, iface in svis:
            net = iface.address.network
            if dst_ip in net and (best is None or net.prefixlen > best[1].address.network.prefixlen):
                best = (vlan, iface)
        if best is None:
            return "none", None, None
        return "connected", best[0], best[1]

    def _acl_check(
        self,
        device: str,
        svi: Interface,
        src_ip,
        dst_ip,
        proto: str,
        flags: frozenset[str],
        dst_port: int | None,
    ) -> Check:
        name = svi.access_group_in
        if name is None:
            return Check("acl", True, None, "no ingress ACL bound")
        lines = self.model.devices[device].acls.get(name)
        if lines is None:
            return Check("acl", False, f"acl:{device}:{name}:missing", f"ingress ACL {name} is bound but not defined")
        for line in lines:
            if line.matches(proto, src_ip, dst_ip, flags, dst_port):
                if line.action == "deny":
                    if self._is_mgmt_deny(line):
                        self.mgmt_hits[line.ref] += 1
                    return Check("acl", False, line.ref, f"denied by {line.ref}: {line.text}")
                return Check("acl", True, None, f"permitted by {line.ref}: {line.text}")
        return Check("acl", False, f"acl:{device}:{name}:implicit", f"no line of {name} matched; implicit deny")

    def _dst_trunk_same_segment(self, src: Host, dst_host: Host | None, routing_dev: str | None) -> Check:
        if dst_host is None or dst_host.device == src.device:
            return Check("dst-trunk", None, None, "same switch, no trunk")
        ok, detail = self.model.path_ok(src.device, dst_host.device, src.vlan, hub=routing_dev)
        return Check("dst-trunk", ok, None if ok else "trunk-prune", detail)

    def _dst_host_check(self, dst_host: Host | None, dst_ip, vlan: int) -> Check:
        if dst_host is None:
            return Check("dst-host", False, "blackhole", f"no host answers at {dst_ip} in vlan {vlan}")
        if not dst_host.enabled or dst_host.vlan != vlan:
            return Check(
                "dst-host",
                False,
                "l2-access-port",
                f"{dst_ip} port {dst_host.device} {dst_host.interface} is down or not in vlan {vlan}",
            )
        return Check("dst-host", True, None, f"{dst_host.label} at {dst_host.device} {dst_host.interface}")


