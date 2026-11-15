"""Mutation tests. Each one breaks a copy of out/ and must make the verifier exit 1 with violations.

The real out/ is never modified. The test checks that by hashing the whole tree before and after.
"""

from __future__ import annotations

import json

from verifier.cli import main

from .support import EXPECTED, OUT, copy_out, drop_line_in_block, tree_hashes


def _run_on(config_dir, tmp_path, capsys):
    code = main(
        [
            "run",
            "--expected",
            str(EXPECTED),
            "--config-dir",
            str(config_dir),
            "--format",
            "json",
            "--out",
            str(tmp_path / "reports"),
        ]
    )
    report = json.loads(capsys.readouterr().out)
    return code, report


def test_removing_target1_ingress_binding_fails_the_gate(tmp_path, capsys):
    before = tree_hashes(OUT)
    copy = copy_out(tmp_path)
    dist = copy / "SW-DIST-EXER.cfg"
    dist.write_text(
        drop_line_in_block(dist.read_text(encoding="utf-8"), "interface Vlan201", "ip access-group TGT-1-IN in"),
        encoding="utf-8",
    )
    code, report = _run_on(copy, tmp_path, capsys)
    assert code == 1
    assert report["passed"] is False
    assert report["violations"] > 0
    assert any(v["source"] == "target-1" and v["observed"] == "permit" for v in report["violation_details"])
    assert tree_hashes(OUT) == before, "out/ was modified"


def test_removing_one_trunk_allowed_entry_fails_the_gate(tmp_path, capsys):
    before = tree_hashes(OUT)
    copy = copy_out(tmp_path)
    dist = copy / "SW-DIST-EXER.cfg"
    dist.write_text(
        drop_line_in_block(
            dist.read_text(encoding="utf-8"),
            "interface GigabitEthernet1/0/1",
            "switchport trunk allowed vlan 101",
        ),
        encoding="utf-8",
    )
    code, report = _run_on(copy, tmp_path, capsys)
    assert code == 1
    assert report["violations"] > 0
    pod1_cells = [v for v in report["violation_details"] if v["source"] == "pod-1"]
    assert pod1_cells, "pod-1 traffic should be cut off by the pruned uplink"
    assert all(v["blocking_layer"] == "trunk-prune" for v in pod1_cells if v["observed"] == "deny")
    assert tree_hashes(OUT) == before


def test_permit_any_as_target1_implicit_deny_fails_the_gate(tmp_path, capsys):
    copy = copy_out(tmp_path)
    dist = copy / "SW-DIST-EXER.cfg"
    text = dist.read_text(encoding="utf-8")
    marker = " 30 deny ip any any log\n!\nip access-list extended TGT-2-IN"
    assert text.count(marker) == 1, "TGT-1-IN final deny line not found where expected"
    dist.write_text(text.replace(marker, " 30 permit ip any any\n!\nip access-list extended TGT-2-IN"), encoding="utf-8")
    code, report = _run_on(copy, tmp_path, capsys)
    assert code == 1
    assert any(v["source"] == "target-1" and v["destination"] == "target-2" for v in report["violation_details"])
