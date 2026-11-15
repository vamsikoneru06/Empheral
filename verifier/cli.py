"""python -m verifier run --expected out/expected-matrix.json [--config-dir DIR] [--format json,html,text] [--out DIR]

Exit codes: 0 pass, 1 violations (or any failed assertion), 2 probe or config error.
With --format json the report JSON goes to stdout and is also written to <out>/verification-report.json.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

from .errors import ConfigError
from .expected import load_expected
from .html_report import render_html
from .matrix import export_template, load_lab_results, run_matrix
from .parser import load_model
from .report import build_report, text_summary

FORMATS = ("text", "json", "html")


def _run(args: argparse.Namespace) -> int:
    formats = {f.strip() for f in args.format.split(",") if f.strip()}
    unknown = formats - set(FORMATS)
    if unknown or not formats:
        raise ConfigError(f"--format must be a comma list of {', '.join(FORMATS)}; got {args.format!r}")

    expected_path: Path = args.expected
    config_dir: Path = args.config_dir or expected_path.resolve().parent
    out_dir: Path = args.out.resolve()
    if {"json", "html"} & formats and out_dir.is_relative_to(config_dir.resolve()):
        raise ConfigError(f"refusing to write reports inside the config directory {config_dir}")

    expected = load_expected(expected_path)
    model = load_model(config_dir)
    if args.export_template:
        count = export_template(expected, run_matrix(model, expected, config_dir).observed, args.export_template)
        print(f"wrote {args.export_template} ({count} rows). Fill in observed with lab results, then run with --live-results.", file=sys.stderr)
        return 0
    lab = load_lab_results(args.live_results, expected) if args.live_results else None
    run = run_matrix(model, expected, config_dir, lab=lab)
    report = build_report(run, expected.profile)
    summary = text_summary(report)

    if "json" in formats:
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / "verification-report.json"
        target.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
        print(f"wrote {target}", file=sys.stderr)
    if "html" in formats:
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / "verification-report.html"
        target.write_text(render_html(report, expected), encoding="utf-8")
        print(f"wrote {target}", file=sys.stderr)
    if "text" in formats:
        print(summary, file=sys.stderr if "json" in formats else sys.stdout)
    return 0 if run.passed else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m verifier", description="CyberRange-Net containment verifier")
    sub = parser.add_subparsers(dest="command", required=True)
    p_run = sub.add_parser("run", help="probe the compiled model and diff against the expected matrix")
    p_run.add_argument("--expected", type=Path, required=True, help="path to expected-matrix.json")
    p_run.add_argument("--config-dir", type=Path, default=None, help="directory of *.cfg (default: expected's folder)")
    p_run.add_argument("--format", default="text", help="comma list: text, json, html (default text)")
    p_run.add_argument("--out", type=Path, default=Path("reports"), help="where json/html reports are written")
    p_run.add_argument(
        "--live-results",
        type=Path,
        default=None,
        help="CSV from a lab (source,destination,probe,observed). Its observed values replace the config model's.",
    )
    p_run.add_argument(
        "--export-template",
        type=Path,
        default=None,
        help="write the config model's observed values as a CSV for a lab to fill in, then exit",
    )
    args = parser.parse_args(argv)
    try:
        return _run(args)
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except Exception:  # a probe error, not a violation
        print("ERROR: probe failed", file=sys.stderr)
        traceback.print_exc()
        return 2
