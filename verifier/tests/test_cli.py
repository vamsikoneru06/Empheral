"""verifier run: exit codes, report JSON shape, HTML output, and the exact orchestrator invocation."""

from __future__ import annotations

import json
import re

from verifier.cli import main
from verifier.matrix import ASSERTION_NAMES

from .support import EXPECTED, OUT

RAN_AT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def test_exit_zero_on_real_out_text_mode(capsys):
    assert main(["run", "--expected", str(EXPECTED)]) == 0
    assert "passed            true" in capsys.readouterr().out


def test_json_format_prints_parseable_report_with_passed_true(capsys, tmp_path):
    code = main(["run", "--expected", str(EXPECTED), "--format", "json", "--out", str(tmp_path / "reports")])
    assert code == 0
    report = json.loads(capsys.readouterr().out)
    assert report["passed"] is True
    assert (tmp_path / "reports" / "verification-report.json").is_file()


def test_report_shape_matches_validation_plan(capsys, tmp_path):
    main(["run", "--expected", str(EXPECTED), "--format", "json", "--out", str(tmp_path)])
    report = json.loads(capsys.readouterr().out)
    for key in ("ran_at", "profile", "pairs_tested", "probes", "violations", "passed", "assertions", "matrix"):
        assert key in report
    assert RAN_AT.match(report["ran_at"])
    assert report["profile"] == "simulation"
    assert report["pairs_tested"] == 99
    assert report["probes"] == 396
    assert report["violations"] == 0
    assert set(report["assertions"]) == set(ASSERTION_NAMES)
    assert all(v is True for v in report["assertions"].values())
    # matrix has the same shape as expected-matrix.json: src -> dst -> probe -> verdict
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))["matrix"]
    assert set(report["matrix"]) == set(expected)
    for src, row in expected.items():
        assert set(report["matrix"][src]) == set(row)
        for dst, cells in row.items():
            assert report["matrix"][src][dst] == cells


def test_observed_matrix_matches_expected_cell_for_cell(capsys, tmp_path):
    main(["run", "--expected", str(EXPECTED), "--format", "json", "--out", str(tmp_path)])
    report = json.loads(capsys.readouterr().out)
    expected = json.loads(EXPECTED.read_text(encoding="utf-8"))["matrix"]
    assert report["matrix"] == expected


def test_html_is_self_contained(tmp_path, capsys):
    code = main(["run", "--expected", str(EXPECTED), "--format", "html", "--out", str(tmp_path)])
    assert code == 0
    html = (tmp_path / "verification-report.html").read_text(encoding="utf-8")
    assert html.startswith("<!doctype html>")
    assert "<script" not in html
    assert "http://" not in html and "https://" not in html
    assert 'src="' not in html and "<link" not in html
    assert html.count("<table>") == 4  # one heatmap per probe
    assert "PASS" in html


def test_missing_expected_is_exit_two(tmp_path, capsys):
    assert main(["run", "--expected", str(tmp_path / "missing.json")]) == 2
    assert "not found" in capsys.readouterr().err


def test_unknown_format_is_exit_two(capsys):
    assert main(["run", "--expected", str(EXPECTED), "--format", "xml"]) == 2


def test_refuses_to_write_reports_into_out(capsys):
    assert main(["run", "--expected", str(EXPECTED), "--format", "json", "--out", str(OUT)]) == 2
    assert "refusing to write" in capsys.readouterr().err
