"""Parse out/*.cfg into a device model. Grammar: compiler/README.md ("IOS subset it emits").

The parser is strict. A line it does not recognise raises ConfigError, so a hand-edited or
truncated file fails loudly rather than being read half-way.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass, field
from pathlib import Path

from .errors import ConfigError

# Sub-commands the verifier does not model (port security, STP, native VLAN). Accepted, not used.
_IGNORED_PREFIXES = (
    "switchport port-security",
    "switchport nonegotiate",
    "switchport trunk native vlan",
    "spanning-tree",
)
_TRUNK_DESC = re.compile(r"^TRUNK to (\S+) (\S+)$")
_SVI_NAME = re.compile(r"^Vlan(\d+)$")
_IPV4_NET = ipaddress.IPv4Network
_IPV4_ADDR = ipaddress.IPv4Address


@dataclass(frozen=True)
class AclLine:
    device: str
    acl: str
    seq: int
    action: str  # permit | deny
    proto: str  # ip | tcp
    src: ipaddress.IPv4Network
    dst: ipaddress.IPv4Network
    established: bool
    eq_port: int | None
    text: str

    @property
    def ref(self) -> str:
        return f"acl:{self.device}:{self.acl}:{self.seq}"

    def matches(self, proto: str, src_ip, dst_ip, flags: frozenset[str], dst_port: int | None) -> bool:
        if src_ip not in self.src or dst_ip not in self.dst:
            return False
        if self.proto == "tcp" and proto != "tcp":
            return False
        if self.established and not (flags & {"ACK", "RST"}):
            return False
        if self.eq_port is not None and dst_port != self.eq_port:
            return False
        return True


@dataclass
class Interface:
    device: str
    name: str
    description: str = ""
    mode: str | None = None  # access | trunk
    access_vlan: int | None = None
    trunk_allowed: frozenset[int] = frozenset()  # absent list = empty (fail closed)
    shutdown: bool = False
    routed: bool = False
    address: ipaddress.IPv4Interface | None = None
    access_group_in: str | None = None
    access_group_out: str | None = None

    @property
    def svi_vlan(self) -> int | None:
        m = _SVI_NAME.match(self.name)
        return int(m.group(1)) if m else None

    @property
    def up(self) -> bool:
        return not self.shutdown

    def carries(self, vlan: int) -> bool:
        return self.mode == "trunk" and self.up and vlan in self.trunk_allowed


@dataclass
class Device:
    name: str
    source: Path
    vlans: dict[int, str] = field(default_factory=dict)
    interfaces: dict[str, Interface] = field(default_factory=dict)
    acls: dict[str, tuple[AclLine, ...]] = field(default_factory=dict)
    ip_routing: bool = False


@dataclass(frozen=True)
class Host:
    device: str
    interface: str
    vlan: int | None
    ip: ipaddress.IPv4Address
    label: str
    enabled: bool


@dataclass
class Model:
    devices: dict[str, Device]
    hosts: dict[ipaddress.IPv4Address, Host]

    def trunk_link(self, a: str, b: str) -> tuple[Interface, Interface] | None:
        """The paired trunk interfaces between devices a and b, found from the TRUNK descriptions."""
        dev_a, dev_b = self.devices.get(a), self.devices.get(b)
        if dev_a is None or dev_b is None:
            return None
        for ifa in dev_a.interfaces.values():
            m = _TRUNK_DESC.match(ifa.description)
            if not m or m.group(1) != b:
                continue
            ifb = dev_b.interfaces.get(m.group(2))
            if ifb is None:
                continue
            back = _TRUNK_DESC.match(ifb.description)
            if back and back.group(1) == a and back.group(2) == ifa.name:
                return ifa, ifb
        return None

    def path_ok(self, a: str, b: str, vlan: int, hub: str | None = None) -> tuple[bool, str]:
        """Can a frame in vlan travel from device a to device b? Each hop needs both trunk ends to carry it.

        Hops go through hub (the routing device) when neither end is the hub.
        """
        if a == b:
            return True, "same device"
        hops = [(a, b)] if hub is None or hub in (a, b) else [(a, hub), (hub, b)]
        for x, y in hops:
            link = self.trunk_link(x, y)
            if link is None:
                return False, f"no trunk between {x} and {y}"
            for iface in link:
                if not iface.carries(vlan):
                    return False, f"{iface.device} {iface.name} does not carry vlan {vlan}"
        return True, f"vlan {vlan} carried {a} -> {b}"

    def routing_svi(self, vlan: int) -> tuple[Device, Interface] | None:
        """The SVI for a VLAN on a routing device, if one exists."""
        for dev in self.devices.values():
            iface = dev.interfaces.get(f"Vlan{vlan}")
            if dev.ip_routing and iface is not None and iface.address is not None:
                return dev, iface
        return None

    def connected_svis(self, device: str) -> list[tuple[int, Interface]]:
        dev = self.devices[device]
        out = []
        for iface in dev.interfaces.values():
            if iface.svi_vlan is not None and iface.address is not None:
                out.append((iface.svi_vlan, iface))
        return out

    def management_networks(self) -> list[ipaddress.IPv4Network]:
        """Networks of every SVI whose VLAN is named MGMT. Found from the config, not hard-coded."""
        nets = set()
        for dev in self.devices.values():
            mgmt_vlans = {vid for vid, name in dev.vlans.items() if name == "MGMT"}
            for vlan, iface in self.connected_svis(dev.name):
                if vlan in mgmt_vlans:
                    nets.add(iface.address.network)
        return sorted(nets)

    def vlan_on_any_trunk(self, vlan: int) -> bool:
        return any(
            iface.carries(vlan)
            for dev in self.devices.values()
            for iface in dev.interfaces.values()
        )


def _wildcard_to_network(addr: str, wildcard: str, where: str) -> ipaddress.IPv4Network:
    try:
        mask = _IPV4_ADDR(int(_IPV4_ADDR(wildcard)) ^ 0xFFFFFFFF)
        return _IPV4_NET(f"{addr}/{mask}", strict=True)
    except ValueError as exc:
        raise ConfigError(f"{where}: bad address/wildcard '{addr} {wildcard}': {exc}") from exc


def _take_addr(toks: list[str], i: int, where: str) -> tuple[ipaddress.IPv4Network, int]:
    if i >= len(toks):
        raise ConfigError(f"{where}: ACL line is missing an address")
    if toks[i] == "any":
        return _IPV4_NET("0.0.0.0/0"), i + 1
    if toks[i] == "host":
        if i + 1 >= len(toks):
            raise ConfigError(f"{where}: 'host' with no address")
        return _IPV4_NET(f"{toks[i + 1]}/32"), i + 2
    if i + 1 >= len(toks):
        raise ConfigError(f"{where}: address without wildcard")
    return _wildcard_to_network(toks[i], toks[i + 1], where), i + 2


def _parse_acl_line(device: str, acl: str, text: str, where: str) -> AclLine:
    toks = text.split()
    if len(toks) < 5:
        raise ConfigError(f"{where}: short ACL line '{text}'")
    try:
        seq = int(toks[0])
    except ValueError as exc:
        raise ConfigError(f"{where}: bad sequence number in '{text}'") from exc
    action, proto = toks[1], toks[2]
    if action not in ("permit", "deny") or proto not in ("ip", "tcp"):
        raise ConfigError(f"{where}: unsupported ACL line '{text}'")
    src, i = _take_addr(toks, 3, where)
    dst, i = _take_addr(toks, i, where)
    established, eq_port = False, None
    while i < len(toks):
        tok = toks[i]
        if tok == "established":
            established = True
            i += 1
        elif tok == "eq" and i + 1 < len(toks):
            try:
                eq_port = int(toks[i + 1])
            except ValueError as exc:
                raise ConfigError(f"{where}: bad port in '{text}'") from exc
            i += 2
        elif tok == "log":
            i += 1
        else:
            raise ConfigError(f"{where}: unsupported ACL keyword '{tok}' in '{text}'")
    if established and proto != "tcp":
        raise ConfigError(f"{where}: 'established' on a non-tcp line")
    return AclLine(device, acl, seq, action, proto, src, dst, established, eq_port, text.strip())


def _parse_vlan_list(text: str, where: str) -> frozenset[int]:
    vlans: set[int] = set()
    try:
        for part in text.split(","):
            if "-" in part:
                lo, hi = (int(x) for x in part.split("-"))
                vlans.update(range(lo, hi + 1))
            else:
                vlans.add(int(part))
    except ValueError as exc:
        raise ConfigError(f"{where}: bad VLAN list '{text}'") from exc
    return frozenset(vlans)


def _apply_interface(iface: Interface, sub: str, where: str) -> None:
    if sub.startswith("description "):
        iface.description = sub[len("description "):]
        return
    if sub == "shutdown":
        iface.shutdown = True
        return
    if sub == "no shutdown":
        iface.shutdown = False
        return
    if sub == "no switchport":
        iface.routed = True
        return
    if sub.startswith(_IGNORED_PREFIXES):
        return
    if m := re.fullmatch(r"switchport mode (access|trunk)", sub):
        iface.mode = m.group(1)
        return
    if m := re.fullmatch(r"switchport access vlan (\d+)", sub):
        iface.access_vlan = int(m.group(1))
        return
    if m := re.fullmatch(r"switchport trunk allowed vlan (\S+)", sub):
        iface.trunk_allowed = _parse_vlan_list(m.group(1), where)
        return
    if m := re.fullmatch(r"ip address (\S+) (\S+)", sub):
        try:
            iface.address = ipaddress.IPv4Interface(f"{m.group(1)}/{m.group(2)}")
        except ValueError as exc:
            raise ConfigError(f"{where}: bad address '{sub}'") from exc
        return
    if m := re.fullmatch(r"ip access-group (\S+) (in|out)", sub):
        if m.group(2) == "in":
            iface.access_group_in = m.group(1)
        else:
            iface.access_group_out = m.group(1)
        return
    raise ConfigError(f"{where}: unsupported interface sub-command '{sub}'")


def parse_device_file(path: Path) -> Device:
    """Parse one DEVICE.cfg. The hostname must match the file stem."""
    dev: Device | None = None
    block: tuple | None = None  # ("vlan", id) | ("iface", Interface) | ("acl", name)
    acl_lines: dict[str, list[AclLine]] = {}
    ended = False
    text = path.read_text(encoding="utf-8")
    for n, line in enumerate(text.splitlines(), 1):
        where = f"{path.name}:{n}"
        if not line.strip():
            continue
        if line.startswith("!"):
            block = None
            continue
        if ended:
            raise ConfigError(f"{where}: content after 'end'")
        if not line.startswith(" "):
            block = None
            if line == "end":
                ended = True
                continue
            if line.startswith("hostname "):
                if dev is not None:
                    raise ConfigError(f"{where}: second hostname line")
                dev = Device(name=line.split(None, 1)[1].strip(), source=path)
                continue
            if dev is None:
                raise ConfigError(f"{where}: hostname must come before other sections")
            if line == "ip routing":
                dev.ip_routing = True
                continue
            if m := re.fullmatch(r"vlan (\d+)", line):
                block = ("vlan", int(m.group(1)))
                continue
            if m := re.fullmatch(r"interface (\S+)", line):
                if m.group(1) in dev.interfaces:
                    raise ConfigError(f"{where}: duplicate interface {m.group(1)}")
                iface = Interface(device=dev.name, name=m.group(1))
                dev.interfaces[iface.name] = iface
                block = ("iface", iface)
                continue
            if m := re.fullmatch(r"ip access-list extended (\S+)", line):
                if m.group(1) in acl_lines:
                    raise ConfigError(f"{where}: duplicate ACL {m.group(1)}")
                acl_lines[m.group(1)] = []
                block = ("acl", m.group(1))
                continue
            raise ConfigError(f"{where}: unsupported top-level line '{line}'")
        # Sub-command: exactly one leading space.
        if line.startswith("  "):
            raise ConfigError(f"{where}: unexpected indentation")
        if dev is None or block is None:
            raise ConfigError(f"{where}: sub-command outside a block")
        sub = line[1:]
        kind = block[0]
        if kind == "vlan":
            m = re.fullmatch(r"name (\S+)", sub)
            if not m:
                raise ConfigError(f"{where}: unsupported vlan sub-command '{sub}'")
            dev.vlans[block[1]] = m.group(1)
        elif kind == "iface":
            _apply_interface(block[1], sub, where)
        else:
            acl_lines[block[1]].append(_parse_acl_line(dev.name, block[1], sub, where))
    if not ended:
        raise ConfigError(f"{path.name}: missing 'end' (truncated file?)")
    if dev is None:
        raise ConfigError(f"{path.name}: no hostname line")
    if dev.name != path.stem:
        raise ConfigError(f"{path.name}: hostname {dev.name} does not match file name")
    dev.acls = {name: tuple(sorted(lines, key=lambda x: x.seq)) for name, lines in acl_lines.items()}
    return dev


def _build_hosts(devices: dict[str, Device]) -> dict[ipaddress.IPv4Address, Host]:
    """An access port whose description ends in an IPv4 address is a host on that port."""
    hosts: dict[ipaddress.IPv4Address, Host] = {}
    for dev in devices.values():
        blackhole = {vid for vid, name in dev.vlans.items() if name == "BLACKHOLE"}
        for iface in dev.interfaces.values():
            if iface.mode != "access":
                continue
            tokens = iface.description.split()
            if not tokens:
                continue
            try:
                ip = _IPV4_ADDR(tokens[-1])
            except ValueError:
                continue
            if ip in hosts:
                raise ConfigError(f"address {ip} appears on two access ports")
            enabled = iface.up and iface.access_vlan is not None and iface.access_vlan not in blackhole
            hosts[ip] = Host(
                device=dev.name,
                interface=iface.name,
                vlan=iface.access_vlan,
                ip=ip,
                label=" ".join(tokens[:-1]),
                enabled=enabled,
            )
    return hosts


def load_model(config_dir: Path) -> Model:
    """Parse every *.cfg in config_dir. Raises ConfigError on any problem."""
    if not config_dir.is_dir():
        raise ConfigError(f"config directory not found: {config_dir}")
    files = sorted(config_dir.glob("*.cfg"))
    if not files:
        raise ConfigError(f"no .cfg files in {config_dir}")
    devices: dict[str, Device] = {}
    for path in files:
        dev = parse_device_file(path)
        if dev.name in devices:
            raise ConfigError(f"duplicate device {dev.name}")
        devices[dev.name] = dev
    return Model(devices=devices, hosts=_build_hosts(devices))
