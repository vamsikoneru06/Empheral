"""Build the report JSON (validation-plan.md "Report format") and the console summary."""

from __future__ import annotations

from datetime import datetime, timezone

from .matrix import NOT_MEASURED, MatrixRun

SCOPE = (
    "Config-level evaluation of the compiled IOS in out/*.cfg: ingress ACL first match, trunk "
    "pruning, connected-SVI routing. Not live packets."
)


LAB_SCOPE = (
    "Observed values imported from a lab CSV (--live-results). The config model supplies the blocking layers and the trunk checks."
)


def status_text(value) -> str:
    """PASS for a true assertion, NOT MEASURED for one probes cannot evaluate, FAIL otherwise."""
    if value == NOT_MEASURED:
        return "NOT MEASURED"
    return "PASS" if value is True else "FAIL"


def rfc3339_utc_ms(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def build_report(run: MatrixRun, profile: str, now: datetime | None = None) -> dict:
    return {
        "ran_at": rfc3339_utc_ms(now),
        "profile": profile,
        "backend": run.backend,
        "scope": SCOPE if run.backend == "config-evaluation" else LAB_SCOPE,
        "pairs_tested": run.pairs,
        "probes": run.probe_count,
        "violations": len(run.violations),
        "passed": run.passed,
        "assertions": dict(run.assertions),
        "mgmt_acl_hits": run.mgmt_acl_hits,
        "mgmt_deny_lines": run.mgmt_deny_lines,
        "environment_hashes": dict(run.env_hashes),
        "matrix": run.observed,
        "blocking_layers": run.layers,
        "violation_details": run.violations,
        "trunk_violations": len(run.trunk_violations),
        "trunk_violation_details": run.trunk_violations,
        "notes": list(run.notes),
    }


def text_summary(report: dict) -> str:
    lines = [
        f"ran_at            {report['ran_at']}",
        f"profile           {report['profile']}   backend {report['backend']}",
        f"pairs_tested      {report['pairs_tested']}",
        f"probes            {report['probes']}",
        f"violations        {report['violations']}",
        f"passed            {str(report['passed']).lower()}",
        "assertions:",
    ]
    for name, ok in report["assertions"].items():
        lines.append(f"  {name:<34} {status_text(ok)}")
    lines.append(f"mgmt_acl_hits     {report['mgmt_acl_hits']}  (deny lines watched: {report['mgmt_deny_lines']})")
    for v in report["violation_details"][:20]:
        lines.append(
            f"  VIOLATION {v['source']} -> {v['destination']} {v['probe']}: "
            f"expected {v['expected']}, observed {v['observed']}, layer {v['blocking_layer']}"
        )
    if len(report["violation_details"]) > 20:
        lines.append(f"  ... {len(report['violation_details']) - 20} more violations in the JSON report")
    for t in report["trunk_violation_details"]:
        lines.append(
            f"  TRUNK {t['device']} {t['interface']}: allowed {t['observed_allowed']}, "
            f"expected {t['expected_allowed']} (R2)"
        )
    lines.append("RESULT: " + ("PASS" if report["passed"] else "FAIL"))
    return "\n".join(lines)
