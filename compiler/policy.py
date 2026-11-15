"""The single policy model.

build_rules() is the only place intent is written down. Both the ingress ACLs (acl_for_segment) and
the expected matrix (expected_matrix) are derived from the same Rule list, so they cannot drift.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass

from .model import Model

PROBES = ("icmp", "tcp-syn", "tcp-ack", "udp")
SOURCE_KINDS = ("pod", "target", "scoring")
MATRIX_SCHEMA = "cyberrange.expected-matrix/v1"


@dataclass(frozen=True)
class Rule:
    """Permit traffic from src to dst. proto is 'ip' (any protocol) or 'tcp'.

    qualifier '' matches everything; 'established' matches TCP with ACK or RST set;
    'eq 80' matches TCP to destination port 80 (packet-tracer-safe fallback only).
    """
    src: str
    dst: str
    proto: str
    qualifier: str

    @property
    def probes(self) -> tuple[str, ...]:
        return probes_for(self.proto, self.qualifier)


def probes_for(proto: str, qualifier: str) -> tuple[str, ...]:
    if proto == "ip" and qualifier == "":
        return PROBES
    if proto == "tcp" and qualifier == "established":
        return ("tcp-ack",)
    if proto == "tcp" and qualifier == "eq 80":
        return ("tcp-syn", "tcp-ack")
    raise ValueError(f"unsupported rule shape: {proto} {qualifier!r}")


def build_rules(model: Model) -> list[Rule]:
    rules: list[Rule] = []
    for n in range(1, model.teams + 1):
        rules.append(Rule(f"pod-{n}", f"target-{n}", "ip", ""))            # pod-N -> target-N: all four
        rules.append(Rule(f"target-{n}", f"pod-{n}", "ip", ""))            # target-N -> pod-N: all four
        if model.packet_tracer_safe:
            rules.append(Rule(f"target-{n}", "scoring", "tcp", "eq 80"))   # R8 fallback
        else:
            rules.append(Rule(f"target-{n}", "scoring", "tcp", "established"))  # R8: tcp-ack only
        rules.append(Rule("scoring", f"target-{n}", "ip", ""))             # scoring -> target-N: all four
    return rules


def verdict(rules: list[Rule], src: str, dst: str, probe: str) -> str:
    for r in rules:
        if r.src == src and r.dst == dst and probe in r.probes:
            return "permit"
    return "deny"


def acl_name(segment: str) -> str:
    """Name of the ingress ACL on a source segment's SVI."""
    if segment.startswith("pod-"):
        return f"POD-{segment[4:]}-IN"
    if segment.startswith("target-"):
        return f"TGT-{segment[7:]}-IN"
    if segment == "scoring":
        return "SCORING-IN"
    raise KeyError(f"no ingress ACL for segment {segment}")


@dataclass(frozen=True)
class AclLine:
    action: str                                    # permit | deny
    proto: str                                     # ip | tcp
    src: ipaddress.IPv4Network | None              # None means any
    dst: ipaddress.IPv4Network | None              # None means any
    qualifier: str = ""                            # '' | established | eq 80
    log: bool = False

    def text(self, seq: int) -> str:
        def spec(net: ipaddress.IPv4Network | None) -> str:
            return "any" if net is None else f"{net.network_address} {net.hostmask}"

        parts = [str(seq), self.action, self.proto, spec(self.src), spec(self.dst)]
        if self.qualifier:
            parts.append(self.qualifier)
        if self.log:
            parts.append("log")
        return " ".join(parts)


def acl_for_segment(model: Model, rules: list[Rule], segment: str) -> list[AclLine]:
    nets = {s.name: s.cidr for s in model.segments}
    lines = [AclLine("permit", r.proto, nets[r.src], nets[r.dst], r.qualifier)
             for r in rules if r.src == segment]
    lines.append(AclLine("deny", "ip", None, None, log=True))
    return lines


def egress_lines(model: Model) -> list[AclLine]:
    """R10: core egress ACL. Exercise blocks may not reach institutional or management."""
    exercise = [model.addressing["pods"], model.addressing["targets"]]
    outside = [s.cidr for s in model.segments if s.kind in ("institutional", "management")]
    lines = [AclLine("deny", "ip", src, dst) for src in exercise for dst in outside]
    lines.append(AclLine("permit", "ip", None, None))
    return lines


def find_shadowed(lines: list[AclLine]) -> list[tuple[int, int]]:
    """Return (earlier, later) index pairs where an earlier line matches everything a later line matches."""

    def net_covers(outer: ipaddress.IPv4Network | None, inner: ipaddress.IPv4Network | None) -> bool:
        if outer is None:
            return True
        if inner is None:
            return False
        return inner.subnet_of(outer)

    def covers(i: AclLine, j: AclLine) -> bool:
        return (net_covers(i.src, j.src) and net_covers(i.dst, j.dst)
                and (i.proto == "ip" or i.proto == j.proto)
                and (i.qualifier == "" or i.qualifier == j.qualifier))

    pairs = []
    for j in range(len(lines)):
        for i in range(j):
            if covers(lines[i], lines[j]):
                pairs.append((i, j))
                break
    return pairs


def expected_matrix(model: Model, rules: list[Rule]) -> dict:
    sources = [s for s in model.segments if s.kind in SOURCE_KINDS]
    matrix: dict[str, dict] = {}
    for src in sources:
        row = {}
        for dst in model.segments:
            if dst.name == src.name:
                continue
            row[dst.name] = {p: verdict(rules, src.name, dst.name, p) for p in PROBES}
        matrix[src.name] = row
    return {
        "schema": MATRIX_SCHEMA,
        "profile": model.profile,
        "teams": model.teams,
        "probes": list(PROBES),
        "segments": [
            {
                "name": s.name,
                "kind": s.kind,
                "team": s.team,
                "cidr": str(s.cidr),
                "vlan": s.vlan,
                "representative_ip": s.representative_ip,
            }
            for s in model.segments
        ],
        "matrix": matrix,
    }
