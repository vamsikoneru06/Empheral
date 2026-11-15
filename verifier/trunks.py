"""Trunk invariant (config-compiler R2): each access switch uplink carries exactly its own VLAN, on both ends.

The packet walk only tests the trunks that a probe crosses. A widened uplink whose ACL still denies would
pass the matrix, so this check reads every exercise uplink directly.
"""

from __future__ import annotations

import re

from .expected import ExpectedMatrix
from .parser import _TRUNK_DESC, Model

_ACCESS = re.compile(r"^SW-(POD|TGT)-(\d+)$")


def _expected_vlans(expected: ExpectedMatrix) -> dict[str, int]:
    prefix = {"pod": "SW-POD", "target": "SW-TGT"}
    return {
        f"{prefix[seg.kind]}-{seg.team:02d}": seg.vlan
        for seg in expected.segments
        if seg.kind in prefix
    }


def trunk_violations(model: Model, expected: ExpectedMatrix) -> list[dict]:
    want = _expected_vlans(expected)
    out: list[dict] = []
    for dev in sorted(model.devices.values(), key=lambda d: d.name):
        for iface in sorted(dev.interfaces.values(), key=lambda i: i.name):
            if iface.mode != "trunk":
                continue
            m = _TRUNK_DESC.match(iface.description)
            if not m:
                continue
            peer = m.group(1)
            access = dev.name if _ACCESS.match(dev.name) else peer if _ACCESS.match(peer) else None
            if access not in want:
                continue
            if iface.trunk_allowed != frozenset({want[access]}):
                out.append(
                    {
                        "device": dev.name,
                        "interface": iface.name,
                        "rule": "R2",
                        "expected_allowed": [want[access]],
                        "observed_allowed": sorted(iface.trunk_allowed),
                    }
                )
    return out
