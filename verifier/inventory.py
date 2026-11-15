"""Read out/ip-allocation.csv: every addressed interface and host, one row each."""

from __future__ import annotations

import csv
import ipaddress
from dataclasses import dataclass
from pathlib import Path

from .errors import ConfigError

# Roles that are infrastructure addresses (SVIs, routed ports, device management), not team hosts.
INFRA_ROLES = frozenset({"gateway", "device-mgmt"})


@dataclass(frozen=True)
class InventoryRow:
    device: str
    interface: str
    segment: str
    role: str
    ip: ipaddress.IPv4Address
    cidr: ipaddress.IPv4Network
    vlan: int | None

    @property
    def is_host(self) -> bool:
        return self.role not in INFRA_ROLES


def load_inventory(path: Path) -> tuple[InventoryRow, ...]:
    if not path.is_file():
        raise ConfigError(f"inventory not found: {path}")
    rows = []
    required = {"device", "interface", "segment", "role", "ip", "cidr", "vlan"}
    with path.open(encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        if not required.issubset(reader.fieldnames or []):
            raise ConfigError(f"{path}: missing columns {sorted(required - set(reader.fieldnames or []))}")
        for line_no, rec in enumerate(reader, 2):
            try:
                rows.append(
                    InventoryRow(
                        device=rec["device"],
                        interface=rec["interface"],
                        segment=rec["segment"],
                        role=rec["role"],
                        ip=ipaddress.IPv4Address(rec["ip"]),
                        cidr=ipaddress.IPv4Network(rec["cidr"], strict=True),
                        vlan=int(rec["vlan"]) if rec["vlan"] else None,
                    )
                )
            except (ValueError, KeyError) as exc:
                raise ConfigError(f"{path}:{line_no}: bad row: {exc}") from exc
    return tuple(rows)
