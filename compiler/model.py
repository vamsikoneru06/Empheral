"""Load topology.yaml into plain data: segments, devices, links, port attachments and SVIs.

Everything else in the compiler (policy, validation, rendering) reads this model and nothing else.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

REQUIRED_ROLES = ("web", "db", "workstation", "dc", "fileserver", "beacon")
POD_WORKSTATION_PORT = "FastEthernet0/2"
ROLE_PORT_BASE = 2                  # target role i (sorted by offset) -> FastEthernet0/(2+i)
C2960_ACCESS_PORTS = 24             # FastEthernet0/1 .. FastEthernet0/24
C3650_PORTS = 48                    # GigabitEthernet1/0/1 .. GigabitEthernet1/0/48
C2960_UPLINKS = ("GigabitEthernet0/1", "GigabitEthernet0/2")


class ConfigError(Exception):
    """topology.yaml cannot be read or is structurally malformed. Fatal."""


def port_exists(model: str, port: str) -> bool:
    if model == "c2960":
        if port in C2960_UPLINKS:
            return True
        prefix = "FastEthernet0/"
        return port.startswith(prefix) and port[len(prefix):].isdigit() and 1 <= int(port[len(prefix):]) <= C2960_ACCESS_PORTS
    if model == "c3650":
        prefix = "GigabitEthernet1/0/"
        return port.startswith(prefix) and port[len(prefix):].isdigit() and 1 <= int(port[len(prefix):]) <= C3650_PORTS
    return False


def access_ports(model: str) -> list[str]:
    """Host-facing access ports that the compiler may shut down when unused (R4)."""
    if model == "c2960":
        return [f"FastEthernet0/{i}" for i in range(1, C2960_ACCESS_PORTS + 1)]
    return []


@dataclass(frozen=True)
class Segment:
    name: str                       # pod-N, target-N, scoring, institutional-a, management
    kind: str                       # pod | target | scoring | institutional | management
    team: int | None
    cidr: ipaddress.IPv4Network
    vlan: int | None
    representative_ip: str


@dataclass(frozen=True)
class Device:
    name: str
    model: str                      # c2960 | c3650
    role: str                       # core | dist | access | mgmt
    team: int | None
    kind: str | None                # pod | target | None
    zone: str | None
    mgmt: ipaddress.IPv4Address


@dataclass(frozen=True)
class Link:
    a: str
    a_port: str
    b: str
    b_port: str
    kind: str                       # trunk
    vlans: tuple[int, ...]          # explicit allowed list; empty means missing (fatal)


@dataclass(frozen=True)
class Attachment:
    """A host-facing access port (vlan set) or a routed port (routed=True, ip set)."""
    device: str
    port: str
    segment: str
    role: str                       # workstation | web | ... | gateway | scoring-engine | scoring-validator
    ip: ipaddress.IPv4Address
    vlan: int | None
    routed: bool


@dataclass(frozen=True)
class Svi:
    """A VLAN interface (gateway) and the segment whose ingress ACL it carries."""
    device: str
    vlan: int
    segment: str
    address: ipaddress.IPv4Interface


@dataclass
class Model:
    profile: str
    teams: int
    packet_tracer_safe: bool
    addressing: dict[str, ipaddress.IPv4Network]
    management_vlan: int
    native_vlan: int
    blackhole_vlan: int
    vlan_claims: list[tuple[int, str]]      # (vlan id, owner) used for duplicate detection and naming
    roles: dict[str, int]
    segments: list[Segment]
    devices: list[Device]
    links: list[Link]
    attachments: list[Attachment]
    svis: list[Svi]

    def segment_by_name(self) -> dict[str, Segment]:
        return {s.name: s for s in self.segments}

    def device_by_name(self) -> dict[str, Device]:
        return {d.name: d for d in self.devices}

    def owner_of_vlan(self) -> dict[int, str]:
        return {vid: owner for vid, owner in self.vlan_claims}


def _req(mapping: Any, key: str, where: str) -> Any:
    if not isinstance(mapping, dict) or key not in mapping:
        raise ConfigError(f"missing '{key}' in {where}")
    return mapping[key]


def _net(text: Any, where: str) -> ipaddress.IPv4Network:
    try:
        return ipaddress.IPv4Network(str(text), strict=True)
    except ValueError as exc:
        raise ConfigError(f"bad CIDR {text!r} in {where}") from exc


def _ip(text: Any, where: str) -> ipaddress.IPv4Address:
    try:
        return ipaddress.IPv4Address(str(text))
    except ValueError as exc:
        raise ConfigError(f"bad IPv4 address {text!r} in {where}") from exc


def _team_net(base: ipaddress.IPv4Network, team: int, prefix: int) -> ipaddress.IPv4Network:
    """R1: team N's block is base third octet N, e.g. 10.20.N.0/26."""
    return ipaddress.IPv4Network((int(base.network_address) + (team << 8), prefix), strict=True)


def load_model(path: Path) -> Model:
    try:
        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise ConfigError(f"YAML error in {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise ConfigError("topology must be a YAML mapping")
    return build_model(raw)


def build_model(raw: dict) -> Model:
    profile = str(_req(raw, "profile", "topology"))
    teams = int(_req(raw, "teams", "topology"))
    if teams < 1:
        raise ConfigError("teams must be at least 1")

    addr = _req(raw, "addressing", "topology")
    addressing = {k: _net(_req(addr, k, "addressing"), f"addressing.{k}")
                  for k in ("institutional", "pods", "targets", "management")}
    pod_prefix = int(_req(addr, "pod_prefix", "addressing"))
    target_prefix = int(_req(addr, "target_prefix", "addressing"))
    if addressing["pods"].prefixlen != 16 or addressing["targets"].prefixlen != 16:
        raise ConfigError("pods and targets blocks must be /16: team N uses third octet N (R1)")

    vl = _req(raw, "vlans", "topology")
    pod_base = int(_req(vl, "pod_base", "vlans"))
    target_base = int(_req(vl, "target_base", "vlans"))
    mgmt_vlan = int(_req(vl, "management", "vlans"))
    native = int(_req(vl, "native_unused", "vlans"))
    blackhole = int(_req(vl, "blackhole", "vlans"))

    sc = _req(raw, "scoring", "topology")
    scoring_vlan = int(_req(sc, "vlan", "scoring"))
    scoring_net = _net(_req(sc, "cidr", "scoring"), "scoring.cidr")
    scoring_device = str(_req(sc, "device", "scoring"))
    engine_ip = _ip(_req(sc, "engine_ip", "scoring"), "scoring.engine_ip")
    validator_ip = _ip(_req(sc, "validator_ip", "scoring"), "scoring.validator_ip")
    engine_port = str(_req(sc, "engine_port", "scoring"))
    validator_port = str(_req(sc, "validator_port", "scoring"))

    roles = {str(k): int(v) for k, v in _req(raw, "target_roles", "topology").items()}

    devices: list[Device] = []
    for d in _req(raw, "devices", "topology"):
        name = str(_req(d, "name", "devices[]"))
        devices.append(Device(
            name=name,
            model=str(_req(d, "model", name)),
            role=str(_req(d, "role", name)),
            team=d.get("team"),
            kind=d.get("kind"),
            zone=d.get("zone"),
            mgmt=_ip(_req(d, "mgmt", name), f"{name}.mgmt"),
        ))

    links: list[Link] = []
    for l in raw.get("links") or []:
        links.append(Link(
            a=str(_req(l, "a", "links[]")), a_port=str(_req(l, "a_port", "links[]")),
            b=str(_req(l, "b", "links[]")), b_port=str(_req(l, "b_port", "links[]")),
            kind=str(l.get("kind", "trunk")),
            vlans=tuple(int(v) for v in (l.get("vlans") or [])),
        ))

    inst_entries = raw.get("institutional") or []

    # Segments
    segments: list[Segment] = []
    pod_nets: dict[int, ipaddress.IPv4Network] = {}
    target_nets: dict[int, ipaddress.IPv4Network] = {}
    for n in range(1, teams + 1):
        pod_nets[n] = _team_net(addressing["pods"], n, pod_prefix)
        segments.append(Segment(f"pod-{n}", "pod", n, pod_nets[n], pod_base + n,
                                str(pod_nets[n].network_address + 10)))
    for n in range(1, teams + 1):
        target_nets[n] = _team_net(addressing["targets"], n, target_prefix)
        segments.append(Segment(f"target-{n}", "target", n, target_nets[n], target_base + n,
                                str(target_nets[n].network_address + 10)))
    segments.append(Segment("scoring", "scoring", None, scoring_net, scoring_vlan, str(engine_ip)))
    for entry in inst_entries:
        net = _net(_req(entry, "cidr", "institutional[]"), "institutional[].cidr")
        segments.append(Segment(str(_req(entry, "name", "institutional[]")), "institutional", None, net, None,
                                str(net.network_address + 10)))
    segments.append(Segment("management", "management", None, addressing["management"], None,
                            str(addressing["management"].network_address + 250)))

    # Exercise-zone distribution switch owns every exercise and scoring SVI
    dists = [d for d in devices if d.role == "dist" and d.zone == "exercise"]
    if len(dists) != 1:
        raise ConfigError(f"need exactly one dist switch with zone: exercise, found {len(dists)}")
    dist_name = dists[0].name

    svis: list[Svi] = []
    for seg in segments:
        if seg.kind in ("pod", "target", "scoring"):
            svis.append(Svi(dist_name if seg.kind != "scoring" else scoring_device, seg.vlan, seg.name,
                            ipaddress.IPv4Interface(f"{seg.cidr.network_address + 1}/{seg.cidr.prefixlen}")))

    # Attachments: host ports and routed ports
    attachments: list[Attachment] = []
    team_range = range(1, teams + 1)
    for d in devices:
        if d.kind == "pod" and d.team in team_range:
            attachments.append(Attachment(d.name, POD_WORKSTATION_PORT, f"pod-{d.team}", "workstation",
                                          pod_nets[d.team].network_address + 10, pod_base + d.team, False))
        if d.kind == "target" and d.team in team_range:
            ordered = sorted(roles.items(), key=lambda kv: kv[1])
            for i, (role, offset) in enumerate(ordered):
                attachments.append(Attachment(d.name, f"FastEthernet0/{ROLE_PORT_BASE + i}", f"target-{d.team}",
                                              role, target_nets[d.team].network_address + offset,
                                              target_base + d.team, False))
    attachments.append(Attachment(scoring_device, engine_port, "scoring", "scoring-engine",
                                  engine_ip, scoring_vlan, False))
    attachments.append(Attachment(scoring_device, validator_port, "scoring", "scoring-validator",
                                  validator_ip, scoring_vlan, False))
    for entry in inst_entries:
        net = _net(entry["cidr"], "institutional[].cidr")
        attachments.append(Attachment(str(entry["device"]), str(entry["port"]), str(entry["name"]), "gateway",
                                      net.network_address + 1, None, True))

    claims: list[tuple[int, str]] = []
    claims += [(pod_base + n, f"pod-{n}") for n in team_range]
    claims += [(target_base + n, f"target-{n}") for n in team_range]
    claims += [(scoring_vlan, "scoring"), (mgmt_vlan, "management"), (native, "native"), (blackhole, "blackhole")]

    return Model(
        profile=profile,
        teams=teams,
        packet_tracer_safe=bool((raw.get("options") or {}).get("packet_tracer_safe", False)),
        addressing=addressing,
        management_vlan=mgmt_vlan,
        native_vlan=native,
        blackhole_vlan=blackhole,
        vlan_claims=claims,
        roles=roles,
        segments=segments,
        devices=devices,
        links=links,
        attachments=attachments,
        svis=svis,
    )
