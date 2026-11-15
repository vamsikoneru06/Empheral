"""Load out/expected-matrix.json (schema cyberrange.expected-matrix/v1). The verifier only reads it."""

from __future__ import annotations

import ipaddress
import json
from dataclasses import dataclass
from pathlib import Path

from .errors import ConfigError

SCHEMA = "cyberrange.expected-matrix/v1"
PROBE_NAMES = ("icmp", "tcp-syn", "tcp-ack", "udp")
VERDICTS = ("permit", "deny")


@dataclass(frozen=True)
class Segment:
    name: str
    kind: str  # pod | target | scoring | institutional | management
    team: int | None
    cidr: ipaddress.IPv4Network
    vlan: int | None
    representative_ip: ipaddress.IPv4Address


@dataclass(frozen=True)
class ExpectedMatrix:
    profile: str
    teams: int
    probes: tuple[str, ...]
    segments: tuple[Segment, ...]
    matrix: dict  # src -> dst -> probe -> verdict

    def segment(self, name: str) -> Segment:
        for seg in self.segments:
            if seg.name == name:
                return seg
        raise ConfigError(f"unknown segment {name}")

    def sources(self) -> list[str]:
        return sorted(self.matrix)

    def destinations(self, src: str) -> list[str]:
        return sorted(seg.name for seg in self.segments if seg.name != src)


def load_expected(path: Path) -> ExpectedMatrix:
    if not path.is_file():
        raise ConfigError(f"expected matrix not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path}: invalid JSON: {exc}") from exc
    if data.get("schema") != SCHEMA:
        raise ConfigError(f"{path}: schema is {data.get('schema')!r}, expected {SCHEMA!r}")
    if tuple(data.get("probes", ())) != PROBE_NAMES:
        raise ConfigError(f"{path}: probes must be {list(PROBE_NAMES)}")
    try:
        segments = tuple(
            Segment(
                name=s["name"],
                kind=s["kind"],
                team=s.get("team"),
                cidr=ipaddress.IPv4Network(s["cidr"], strict=True),
                vlan=s.get("vlan"),
                representative_ip=ipaddress.IPv4Address(s["representative_ip"]),
            )
            for s in data["segments"]
        )
    except (KeyError, ValueError, TypeError) as exc:
        raise ConfigError(f"{path}: bad segment entry: {exc}") from exc
    names = {s.name for s in segments}
    if len(names) != len(segments):
        raise ConfigError(f"{path}: duplicate segment names")
    matrix = data.get("matrix", {})
    if not matrix:
        raise ConfigError(f"{path}: empty matrix")
    for src, row in matrix.items():
        if src not in names:
            raise ConfigError(f"{path}: source {src} is not a segment")
        for dst in names - {src}:
            if dst not in row:
                raise ConfigError(f"{path}: missing cell {src} -> {dst}")
            for probe in PROBE_NAMES:
                verdict = row[dst].get(probe)
                if verdict not in VERDICTS:
                    raise ConfigError(f"{path}: cell {src} -> {dst} {probe} is {verdict!r}")
    return ExpectedMatrix(
        profile=data.get("profile", ""),
        teams=int(data.get("teams", 0)),
        probes=PROBE_NAMES,
        segments=segments,
        matrix=matrix,
    )
