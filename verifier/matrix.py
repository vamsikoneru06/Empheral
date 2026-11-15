"""Probe every (source, destination, probe) in the expected matrix, diff against it, derive assertions.

Only the 9 sources in the expected matrix are probed. Institutional and management are destinations
only: validation-plan.md and the contract define no policy for them as sources.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
from dataclasses import dataclass, field
from pathlib import Path

from .engine import Engine
from .errors import ConfigError
from .expected import VERDICTS, ExpectedMatrix
from .inventory import load_inventory
from .parser import Model
from .probes import PROBES
from .trunks import trunk_violations

NOT_PROBED = "not-probed"  # a cell the lab did not probe. Never counts as a pass
NOT_MEASURED = "not_measured"  # an assertion that probes cannot evaluate. Shown, not counted as a failure
LAB_HEADER = ("source", "destination", "probe", "observed")

ASSERTION_NAMES = (
    "team_to_team_denied",
    "target_to_scoring_denied",
    "scoring_to_target_permitted",
    "exercise_to_institutional_denied",
    "mgmt_plane_unreachable",
    "mgmt_acl_counter_zero",
    "environments_identical",
)


@dataclass
class MatrixRun:
    observed: dict  # src -> dst -> probe -> permit|deny
    layers: dict  # src -> dst -> probe -> blocking layer or None
    violations: list[dict]
    pairs: int
    probe_count: int
    assertions: dict[str, bool]
    mgmt_acl_hits: int
    mgmt_deny_lines: int
    env_hashes: dict[str, str]
    notes: list[str] = field(default_factory=list)
    trunk_violations: list[dict] = field(default_factory=list)
    backend: str = "config-evaluation"

    @property
    def passed(self) -> bool:
        return (
            not self.violations
            and not self.trunk_violations
            and all(v is True or v == NOT_MEASURED for v in self.assertions.values())
        )


def target_set_hashes(config_dir: Path, expected: ExpectedMatrix) -> dict[str, str]:
    """V7: hash each target set's structure (role -> offset from the subnet base)."""
    rows = load_inventory(config_dir / "ip-allocation.csv")
    hashes: dict[str, str] = {}
    for seg in expected.segments:
        if seg.kind != "target":
            continue
        members = {
            row.role: int(row.ip) - int(row.cidr.network_address)
            for row in rows
            if row.segment == seg.name and row.is_host
        }
        if not members:
            raise ConfigError(f"no target-set hosts for {seg.name} in ip-allocation.csv")
        hashes[seg.name] = hashlib.sha256(json.dumps(members, sort_keys=True).encode("utf-8")).hexdigest()
    if not hashes:
        raise ConfigError("expected matrix has no target segments")
    return hashes


def _pairs(expected: ExpectedMatrix, src_ok, dst_ok) -> list[tuple[str, str]]:
    out = []
    for src in expected.sources():
        s = expected.segment(src)
        if not src_ok(s):
            continue
        for dst in expected.destinations(src):
            d = expected.segment(dst)
            if dst_ok(s, d):
                out.append((src, dst))
    return out


def _all_match(observed: dict, pairs: list[tuple[str, str]], wanted: dict[str, str]) -> bool:
    if not pairs:
        return False
    for src, dst in pairs:
        for probe, verdict in wanted.items():
            if observed[src][dst][probe] != verdict:
                return False
    return True


def _assertions(expected: ExpectedMatrix, observed: dict, mgmt_hits: int, env_hashes: dict[str, str]) -> dict[str, bool]:
    all_deny = {p: "deny" for p in expected.probes}
    all_permit = {p: "permit" for p in expected.probes}
    exercise = lambda s: s.kind in ("pod", "target")  # noqa: E731
    any_source = lambda s: True  # noqa: E731

    team_to_team = _pairs(expected, exercise, lambda s, d: d.kind in ("pod", "target") and s.team != d.team)
    t2s = _pairs(expected, lambda s: s.kind == "target", lambda s, d: d.kind == "scoring")
    s2t = _pairs(expected, lambda s: s.kind == "scoring", lambda s, d: d.kind == "target")
    exer_inst = _pairs(expected, exercise, lambda s, d: d.kind == "institutional")
    mgmt = _pairs(expected, any_source, lambda s, d: d.kind == "management")

    values = list(env_hashes.values())
    return {
        "team_to_team_denied": _all_match(observed, team_to_team, all_deny),
        # Initiating probes are denied. The ACK reply path (V10) must be permitted, so both are checked here.
        "target_to_scoring_denied": _all_match(
            observed, t2s, {"icmp": "deny", "tcp-syn": "deny", "udp": "deny", "tcp-ack": "permit"}
        ),
        "scoring_to_target_permitted": _all_match(observed, s2t, all_permit),
        "exercise_to_institutional_denied": _all_match(observed, exer_inst, all_deny),
        "mgmt_plane_unreachable": _all_match(observed, mgmt, all_deny),
        "mgmt_acl_counter_zero": mgmt_hits == 0,
        "environments_identical": bool(values) and len(set(values)) == 1,
    }


def run_matrix(
    model: Model,
    expected: ExpectedMatrix,
    config_dir: Path,
    lab: dict | None = None,
) -> MatrixRun:
    """Evaluate every cell. With lab=None the config model supplies the observed values. With lab set
    (see load_lab_results), the lab's observed values are used. A cell the lab did not probe is a violation."""
    engine = Engine(model)
    observed: dict = {}
    layers: dict = {}
    violations: list[dict] = []
    pairs = 0
    probe_count = 0
    for src in expected.sources():
        s = expected.segment(src)
        observed[src], layers[src] = {}, {}
        for dst in expected.destinations(src):
            d = expected.segment(dst)
            pairs += 1
            observed[src][dst], layers[src][dst] = {}, {}
            for probe in expected.probes:
                verdict = engine.evaluate(s.representative_ip, d.representative_ip, **PROBES[probe].kwargs())
                model_obs = "permit" if verdict.permitted else "deny"
                obs = model_obs if lab is None else lab.get(src, {}).get(dst, {}).get(probe)
                want = expected.matrix[src][dst][probe]
                probe_count += 1
                observed[src][dst][probe] = obs if obs is not None else NOT_PROBED
                layers[src][dst][probe] = verdict.layer
                if obs != want:
                    violations.append(
                        {
                            "source": src,
                            "destination": dst,
                            "probe": probe,
                            "expected": want,
                            "observed": observed[src][dst][probe],
                            "blocking_layer": NOT_PROBED if obs is None else verdict.layer,
                            "blocking_layers": list(verdict.layers),
                        }
                    )
    env_hashes = target_set_hashes(config_dir, expected)
    mgmt_hits = sum(engine.mgmt_hits.values())
    assertions = _assertions(expected, observed, mgmt_hits, env_hashes)
    notes = [
        "Sources are the 9 controlled segments. Institutional and management are destinations only.",
        "Management-deny lines live on the core (EXER-EGRESS). No packet reaches the core in this model, "
        "so their hit count is zero by construction.",
    ]
    if lab is not None:
        # Probes cannot read switch counters, so the lab run cannot measure this assertion.
        assertions["mgmt_acl_counter_zero"] = NOT_MEASURED
        notes = [
            "Observed values were imported from a lab CSV. The config model supplies blocking layers only.",
            "mgmt_acl_counter_zero is not measured by probes. Read the core ACL counters on the device to check it.",
        ]
    return MatrixRun(
        observed=observed,
        layers=layers,
        violations=violations,
        pairs=pairs,
        probe_count=probe_count,
        assertions=assertions,
        mgmt_acl_hits=mgmt_hits,
        mgmt_deny_lines=len(engine.mgmt_deny_lines),
        env_hashes={name: h for name, h in sorted(env_hashes.items())},
        notes=notes,
        trunk_violations=trunk_violations(model, expected),
        backend="lab-import" if lab is not None else "config-evaluation",
    )


def observed_rows(expected: ExpectedMatrix, observed: dict) -> list[list[str]]:
    """One CSV row per controlled cell, in matrix order: source, destination, probe, observed."""
    rows = []
    for src in expected.sources():
        for dst in expected.destinations(src):
            for probe in expected.probes:
                rows.append([src, dst, probe, observed[src][dst][probe]])
    return rows


def export_template(expected: ExpectedMatrix, observed: dict, path: Path) -> int:
    """Write the config model's observed values as a CSV that a lab team edits with real probe results."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(LAB_HEADER)
    rows = observed_rows(expected, observed)
    writer.writerows(rows)
    path.write_text(buf.getvalue(), encoding="utf-8")
    return len(rows)


def load_lab_results(path: Path, expected: ExpectedMatrix) -> dict:
    """Read lab probe results. Returns src -> dst -> probe -> permit|deny. Rejects unknown names and duplicates."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"cannot read lab results {path}: {exc}") from exc
    reader = csv.DictReader(io.StringIO(text))
    if tuple(reader.fieldnames or ()) != LAB_HEADER:
        raise ConfigError(f"{path}: header must be {','.join(LAB_HEADER)}")
    names = {seg.name for seg in expected.segments}
    out: dict = {}
    for line_no, row in enumerate(reader, start=2):
        values = [row.get(key) for key in LAB_HEADER]
        if any(v is None for v in values):
            raise ConfigError(f"{path}:{line_no}: expected {len(LAB_HEADER)} columns")
        src, dst, probe, obs = (v.strip() for v in values)
        where = f"{path}:{line_no}"
        if src not in expected.matrix:
            raise ConfigError(f"{where}: {src!r} is not a controlled source")
        if dst not in names or dst == src:
            raise ConfigError(f"{where}: {dst!r} is not a destination of {src!r}")
        if probe not in expected.probes:
            raise ConfigError(f"{where}: unknown probe {probe!r}")
        if obs not in VERDICTS:
            raise ConfigError(f"{where}: observed must be permit or deny, got {obs!r}")
        cell = out.setdefault(src, {}).setdefault(dst, {})
        if probe in cell:
            raise ConfigError(f"{where}: duplicate {src} -> {dst} {probe}")
        cell[probe] = obs
    return out
