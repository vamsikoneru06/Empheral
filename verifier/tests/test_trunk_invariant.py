"""Trunk pruning and the R2 uplink invariant. Each mutation runs on a copy of out/, never on out/ itself."""

from __future__ import annotations

from verifier.engine import Engine
from verifier.parser import load_model

from .support import EXPECTED, OUT, copy_out, tree_hashes
from .test_mutation import _run_on


def _replace_once(path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert text.count(old) == 1, f"expected exactly one {old!r} in {path.name}"
    path.write_text(text.replace(old, new), encoding="utf-8")


def test_widened_pod_uplink_fails_the_trunk_invariant_only(tmp_path, capsys):
    before = tree_hashes(OUT)
    copy = copy_out(tmp_path)
    # SW-DIST-EXER's uplink to SW-POD-01 now also carries target VLAN 201. Matrix cells are unchanged,
    # so only the R2 invariant can catch it.
    _replace_once(copy / "SW-DIST-EXER.cfg", "switchport trunk allowed vlan 101\n", "switchport trunk allowed vlan 101,201\n")
    code, report = _run_on(copy, tmp_path, capsys)
    assert code == 1
    assert report["passed"] is False
    assert report["violations"] == 0, "matrix cells should be unaffected by the widening"
    assert report["trunk_violations"] >= 1
    assert any(
        t["device"] == "SW-DIST-EXER" and t["expected_allowed"] == [101] for t in report["trunk_violation_details"]
    )
    assert tree_hashes(OUT) == before


def test_pruned_target_uplink_drops_scoring_traffic_at_the_trunk(tmp_path, capsys):
    copy = copy_out(tmp_path)
    # SW-TGT-02 no longer carries VLAN 202, so scoring cannot reach target-2 over the trunk.
    _replace_once(copy / "SW-TGT-02.cfg", "switchport trunk allowed vlan 202\n", "switchport trunk allowed vlan 203\n")
    code, report = _run_on(copy, tmp_path, capsys)
    assert code == 1
    cells = [
        v for v in report["violation_details"]
        if v["source"] == "scoring" and v["destination"] == "target-2" and v["observed"] == "deny"
    ]
    assert cells, "scoring -> target-2 should be cut off by the pruned trunk"
    assert all(v["blocking_layer"] == "trunk-prune" for v in cells)
    assert any(t["device"] == "SW-TGT-02" for t in report["trunk_violation_details"])


def test_pruned_destination_trunk_is_reported_alongside_the_acl(tmp_path):
    copy = copy_out(tmp_path)
    # pod-1 -> pod-2 is denied by the ACL on SW-DIST-EXER. Pruning pod-2's uplink adds a second, independent block.
    _replace_once(copy / "SW-POD-02.cfg", "switchport trunk allowed vlan 102\n", "switchport trunk allowed vlan 203\n")
    engine = Engine(load_model(copy))
    verdict = engine.evaluate("10.20.1.10", "10.20.2.10", "tcp", flags=("SYN",), dst_port=80)
    assert verdict.action == "deny"
    assert any(layer.startswith("acl:") for layer in verdict.layers)
    assert "trunk-prune" in verdict.layers
    assert len(verdict.layers) >= 2


def test_real_out_has_no_trunk_violations():
    from verifier.matrix import run_matrix
    from verifier.expected import load_expected

    run = run_matrix(load_model(OUT), load_expected(EXPECTED), OUT)
    assert run.trunk_violations == []
    assert run.passed
