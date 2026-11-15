"""V6: full compromise stays bounded (validation-plan.md, V6 steps a to g).

From one compromised team host, sweep every subnet that holds addressed interfaces. Each candidate
gets an ICMP attempt and a TCP SYN attempt on each port. Every attempt is reachable or blocked, and
a block names the enforcement layer.

Pass criteria:
  a  own target set: at least one host found (non-vacuity)
  b  own pod:        at least one host reachable (non-vacuity)
  c-g                zero reachable, zero open ports, and every block names a layer

"open" means the path admits a SYN to that port. The model has no listening services, so an
admitted port is counted open at the filter level only.
"""

from __future__ import annotations

import datetime as _dt
import ipaddress
from collections import Counter

from verifier.inventory import InventoryRow

from .sandbox import Sandbox

PORTS = (22, 23, 80, 443, 445, 3389, 8080, 3306)
SCHEMA = "cyberrange.v6/v1"


def _rfc3339_utc_ms() -> str:
    now = _dt.datetime.now(_dt.timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _step_cidrs(sandbox: Sandbox, own_team: int) -> list[tuple[str, str, list[ipaddress.IPv4Network]]]:
    """(step id, description, cidrs) for steps a to g. Peer steps cover every other team."""
    segs = sandbox.segments()
    own_target = [s for s in segs if s.kind == "target" and s.team == own_team]
    own_pod = [s for s in segs if s.kind == "pod" and s.team == own_team]
    peer_pods = [s for s in segs if s.kind == "pod" and s.team != own_team]
    peer_targets = [s for s in segs if s.kind == "target" and s.team != own_team]
    scoring = [s for s in segs if s.kind == "scoring"]
    institutional = [s for s in segs if s.kind == "institutional"]
    management = [s for s in segs if s.kind == "management"]

    def nets(group):
        return [s.cidr for s in group]

    return [
        ("a", "own target set", nets(own_target)),
        ("b", "own pod", nets(own_pod)),
        ("c", "peer pods", nets(peer_pods)),
        ("d", "peer target sets", nets(peer_targets)),
        ("e", "scoring", nets(scoring)),
        ("f", "institutional", nets(institutional)),
        ("g", "management plane", nets(management)),
    ]


def _attempt_record(step: str, src_row, dst: InventoryRow, probe: str, port: int | None, verdict) -> dict:
    if verdict.permitted:
        result = "reachable" if probe == "icmp" else "open"
        blocked_by = None
    else:
        result = "blocked"
        blocked_by = verdict.layer or "unnamed"
    return {
        "step": step,
        "target": str(dst.ip),
        "role": dst.role,
        "segment": dst.segment,
        "probe": probe,
        "port": port,
        "result": result,
        "blocked_by": blocked_by,
        "blocking_layers": list(verdict.layers),
        "checks": [{"name": c.name, "ok": c.ok, "detail": c.detail} for c in verdict.checks],
    }


def run_v6(sandbox: Sandbox, compromised: InventoryRow) -> dict:
    """Run steps a to g from the compromised host. Returns a JSON-ready result dict."""
    src = compromised.ip
    start_segment = sandbox.segment_of(src)
    starts_in_pod = start_segment is not None and start_segment.kind == "pod"
    steps_out = []
    attempts_out: list[dict] = []
    all_passed = True
    for step_id, description, cidrs in _step_cidrs(sandbox, _team_of(sandbox, compromised)):
        candidates: dict[ipaddress.IPv4Address, InventoryRow] = {}
        for cidr in cidrs:
            for row in sandbox.rows_in(cidr):
                if row.ip != src:
                    candidates[row.ip] = row

        step_attempts: list[dict] = []
        for ip in sorted(candidates, key=int):
            row = candidates[ip]
            verdict = sandbox.attempt(src, ip, "icmp")
            step_attempts.append(_attempt_record(step_id, compromised, row, "icmp", None, verdict))
            for port in PORTS:
                verdict = sandbox.attempt(src, ip, "tcp", frozenset({"SYN"}), port)
                step_attempts.append(_attempt_record(step_id, compromised, row, "tcp-syn", port, verdict))
        attempts_out.extend(step_attempts)

        reachable = sorted({a["target"] for a in step_attempts if a["result"] == "reachable"}, key=ipaddress.IPv4Address)
        hosts_found = sum(
            1 for a in step_attempts if a["result"] == "reachable" and candidates[ipaddress.IPv4Address(a["target"])].is_host
        )
        open_ports = sum(1 for a in step_attempts if a["result"] == "open")
        blocked_recs = [a for a in step_attempts if a["result"] == "blocked"]
        layers = Counter(a["blocked_by"] for a in blocked_recs)
        unnamed = layers.get("unnamed", 0)

        if step_id == "a":
            passed = hosts_found >= 1 and unnamed == 0
            criterion = "at least one team host found in own target set"
        elif step_id == "b" and starts_in_pod:
            # Design decision: a pod may not reach its own gateway. The ingress list on the pod SVI blocks it.
            gateways = {str(ip) for ip, row in candidates.items() if row.role == "gateway"}
            peers = {str(ip) for ip, row in candidates.items() if row.is_host}
            passed = unnamed == 0 and not gateways & set(reachable) and peers <= set(reachable)
            criterion = "own pod: gateway blocked by design, other pod hosts reachable"
        elif step_id == "b":
            passed = len(reachable) >= 1 and unnamed == 0
            criterion = "own pod reachable"
        else:
            passed = not reachable and open_ports == 0 and unnamed == 0
            criterion = "zero reachable, zero open ports, every block names a layer"
        all_passed = all_passed and passed
        steps_out.append(
            {
                "step": step_id,
                "name": description,
                "subnets": [str(c) for c in cidrs],
                "candidates": len(candidates),
                "reachable": reachable,
                "hosts_found": hosts_found,
                "open_ports": open_ports,
                "blocked": len(blocked_recs),
                "blocking_layers": dict(sorted(layers.items())),
                "criterion": criterion,
                "passed": passed,
            }
        )
    return {
        "schema": SCHEMA,
        "ran_at": _rfc3339_utc_ms(),
        "backend": "config-evaluation",
        "scope": "Config-level evaluation of compiled IOS (out/*.cfg). Not live traffic. "
        "Host discovery uses ip-allocation.csv. Ports are the 8 listed in validation-plan.md.",
        "compromised": {
            "ip": str(compromised.ip),
            "segment": compromised.segment,
            "role": compromised.role,
            "device": compromised.device,
            "interface": compromised.interface,
        },
        "ports": list(PORTS),
        "steps": steps_out,
        "attempts": attempts_out,
        "passed": all_passed,
    }


def _team_of(sandbox: Sandbox, row: InventoryRow) -> int:
    seg = sandbox.segment_of(row.ip)
    if seg is None or seg.team is None:
        raise ValueError(f"{row.ip} has no team")
    return seg.team
