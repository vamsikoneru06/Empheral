"""Hard allowlist and the only route from the simulator to the engine.

CLAUDE.md rule 7: the attack simulator refuses out-of-range targets. Every target and every
destination must sit inside a segment listed in out/expected-matrix.json, and the target must be
a team host in out/ip-allocation.csv. Anything else raises RefusedError (CLI exit 3). There is no
override flag.

Enforcement in code: the engine is held privately and reached only through Sandbox.attempt, which
checks the allowlist before every evaluation. The allowlist is a frozen tuple built once from the
expected matrix. This module imports no socket or network library. It evaluates the compiled model
and nothing else.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from pathlib import Path

from verifier.engine import Engine, Verdict
from verifier.errors import ConfigError
from verifier.expected import Segment, load_expected
from verifier.inventory import InventoryRow, load_inventory
from verifier.parser import load_model


class RefusedError(Exception):
    """A target or destination is outside the simulated range. CLI exit code 3."""


@dataclass(frozen=True)
class _Allowlist:
    networks: tuple[ipaddress.IPv4Network, ...]

    def contains(self, ip: ipaddress.IPv4Address) -> bool:
        return any(ip in net for net in self.networks)


class Sandbox:
    def __init__(self, config_dir: Path):
        expected = load_expected(config_dir / "expected-matrix.json")
        self._segments: tuple[Segment, ...] = expected.segments
        self._allow = _Allowlist(tuple(seg.cidr for seg in expected.segments))
        rows = load_inventory(config_dir / "ip-allocation.csv")
        self._inventory: dict[ipaddress.IPv4Address, InventoryRow] = {}
        for row in rows:
            if row.ip in self._inventory:
                raise ConfigError(f"ip-allocation.csv lists {row.ip} twice")
            self._inventory[row.ip] = row
        self._ordered = tuple(sorted(rows, key=lambda r: int(r.ip)))
        self._engine = Engine(load_model(config_dir))

    def segment_of(self, ip: ipaddress.IPv4Address) -> Segment | None:
        for seg in self._segments:
            if ip in seg.cidr:
                return seg
        return None

    def resolve_target(self, text: str) -> InventoryRow:
        """Return the inventory row for a valid compromise target, or refuse."""
        try:
            ip = ipaddress.IPv4Address(text.strip())
        except ValueError as exc:
            raise RefusedError(f"{text!r} is not an IPv4 address") from exc
        seg = self.segment_of(ip)
        if seg is None:
            raise RefusedError(f"{ip} is outside every segment listed in expected-matrix.json")
        row = self._inventory.get(ip)
        if row is None:
            raise RefusedError(f"{ip} is not an addressed host in ip-allocation.csv")
        if not row.is_host or seg.kind not in ("pod", "target"):
            raise RefusedError(f"{ip} is {row.role} in {seg.name}, not a team host")
        return row

    def segments(self) -> tuple[Segment, ...]:
        return self._segments

    def rows_in(self, cidr: ipaddress.IPv4Network) -> list[InventoryRow]:
        """Every addressed interface inside cidr, in address order. Discovery candidates."""
        return [row for row in self._ordered if row.ip in cidr]

    def attempt(
        self,
        src: ipaddress.IPv4Address,
        dst: ipaddress.IPv4Address,
        proto: str,
        flags: frozenset[str] = frozenset(),
        dst_port: int | None = None,
    ) -> Verdict:
        """Evaluate one packet through the compiled model. Refuses if either end is out of range."""
        for ip in (src, dst):
            if not self._allow.contains(ip):
                raise RefusedError(f"{ip} is outside the simulated range")
        return self._engine.evaluate(src, dst, proto, flags=flags, dst_port=dst_port)
