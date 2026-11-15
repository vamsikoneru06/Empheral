"""Lab results import: export the model's observed matrix, have a lab fill it in, verify the lab's values.

A lab CSV replaces the config model's observed values. A cell the lab did not probe is a violation.
The mgmt counter assertion is NOT MEASURED in a lab run, because probes cannot read switch counters.
"""

from __future__ import annotations

import json

from verifier.cli import main
from verifier.expected import load_expected
from verifier.matrix import LAB_HEADER, NOT_MEASURED, load_lab_results, run_matrix
from verifier.parser import load_model

from .support import EXPECTED, OUT, tree_hashes


def _export(tmp_path):
    path = tmp_path / "lab.csv"
    code = main(["run", "--expected", str(EXPECTED), "--export-template", str(path)])
    assert code == 0
    return path


def _lines(path):
    return path.read_text(encoding="utf-8").splitlines()


def _write(path, lines):
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _run_lab(lab_csv, tmp_path, capsys):
    code = main(
        [
            "run",
            "--expected",
            str(EXPECTED),
            "--live-results",
            str(lab_csv),
            "--format",
            "json",
            "--out",
            str(tmp_path / "reports"),
        ]
    )
    return code, json.loads(capsys.readouterr().out)


def test_export_writes_one_row_per_controlled_cell(tmp_path):
    lines = _lines(_export(tmp_path))
    assert tuple(lines[0].split(",")) == LAB_HEADER
    assert len(lines) - 1 == 99 * 4  # 99 controlled pairs, 4 probes each


def test_unchanged_export_passes_as_a_lab_run(tmp_path, capsys):
    before = tree_hashes(OUT)
    code, report = _run_lab(_export(tmp_path), tmp_path, capsys)
    assert code == 0
    assert report["backend"] == "lab-import"
    assert report["violations"] == 0
    assert report["passed"] is True
    assert report["assertions"]["mgmt_acl_counter_zero"] == NOT_MEASURED
    assert tree_hashes(OUT) == before


def test_a_flipped_cell_fails_the_gate(tmp_path, capsys):
    path = _export(tmp_path)
    lines = _lines(path)
    target = "pod-1,target-1,icmp,permit"  # the lab says a pod cannot reach its own target
    assert lines.count(target) == 1
    lines[lines.index(target)] = "pod-1,target-1,icmp,deny"
    _write(path, lines)
    code, report = _run_lab(path, tmp_path, capsys)
    assert code == 1
    assert report["passed"] is False
    assert any(
        v["source"] == "pod-1" and v["destination"] == "target-1" and v["probe"] == "icmp" and v["observed"] == "deny"
        for v in report["violation_details"]
    )


def test_a_missing_cell_is_not_a_pass(tmp_path, capsys):
    path = _export(tmp_path)
    lines = _lines(path)
    gone = "scoring,target-3,tcp-syn,permit"
    assert lines.count(gone) == 1
    lines.remove(gone)
    _write(path, lines)
    code, report = _run_lab(path, tmp_path, capsys)
    assert code == 1
    assert any(
        v["source"] == "scoring" and v["destination"] == "target-3" and v["probe"] == "tcp-syn"
        and v["observed"] == "not-probed" and v["blocking_layer"] == "not-probed"
        for v in report["violation_details"]
    )


def test_bad_csv_is_a_config_error(tmp_path, capsys):
    expected = load_expected(EXPECTED)
    cases = {
        "wrong header": ["src,dst,probe,result", "pod-1,target-1,icmp,permit"],
        "unknown source": ["source,destination,probe,observed", "institutional-a,target-1,icmp,permit"],
        "unknown probe": ["source,destination,probe,observed", "pod-1,target-1,ping,permit"],
        "bad verdict": ["source,destination,probe,observed", "pod-1,target-1,icmp,maybe"],
        "duplicate": ["source,destination,probe,observed", "pod-1,target-1,icmp,permit", "pod-1,target-1,icmp,deny"],
    }
    for label, lines in cases.items():
        path = tmp_path / f"{label.replace(' ', '_')}.csv"
        _write(path, lines)
        try:
            load_lab_results(path, expected)
        except Exception as exc:  # noqa: BLE001 - the type is checked below
            assert type(exc).__name__ == "ConfigError", label
        else:
            raise AssertionError(f"{label}: expected a ConfigError")


def test_bad_csv_exits_2_from_the_cli(tmp_path, capsys):
    path = tmp_path / "bad.csv"
    _write(path, ["source,destination,probe,observed", "pod-1,pod-1,icmp,permit"])
    code = main(["run", "--expected", str(EXPECTED), "--live-results", str(path)])
    assert code == 2


def test_lab_run_uses_the_same_model_only_for_layers(tmp_path):
    """The blocking layer names still come from the config model. The observed values come from the lab."""
    expected = load_expected(EXPECTED)
    model = load_model(OUT)
    lab = load_lab_results(_export(tmp_path), expected)
    run = run_matrix(model, expected, OUT, lab=lab)
    assert run.passed
    assert run.backend == "lab-import"
