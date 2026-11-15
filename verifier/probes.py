"""Probe types and how each maps onto a packet for the engine.

tcp probes carry dst_port 80. The compiled ACLs have no port terms except the fallback
'eq 80' lines, so this only matters for fallback builds (validation-plan.md, fallback note).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ProbeSpec:
    proto: str
    flags: frozenset[str]
    dst_port: int | None

    def kwargs(self) -> dict:
        return {"proto": self.proto, "flags": self.flags, "dst_port": self.dst_port}


PROBES: dict[str, ProbeSpec] = {
    "icmp": ProbeSpec(proto="icmp", flags=frozenset(), dst_port=None),
    "tcp-syn": ProbeSpec(proto="tcp", flags=frozenset({"SYN"}), dst_port=80),
    "tcp-ack": ProbeSpec(proto="tcp", flags=frozenset({"ACK"}), dst_port=80),
    "udp": ProbeSpec(proto="udp", flags=frozenset(), dst_port=None),
}
