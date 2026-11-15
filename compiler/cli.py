"""Command line: validate, build, matrix, diff. Exit 0 on success, 1 on any validation or config failure."""

from __future__ import annotations

import argparse
import sys
from dataclasses import replace
from pathlib import Path

from .build import build_out_dir, diff_dirs
from .model import ConfigError, load_model
from .policy import PROBES, SOURCE_KINDS, build_rules
from .render import render_matrix
from .validate import validate


def _load_checked(path: Path, packet_tracer_safe_flag: bool):
    model = load_model(path)
    if packet_tracer_safe_flag:
        model = replace(model, packet_tracer_safe=True)
    errors = validate(model)
    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        print(f"{len(errors)} validation failure(s). Nothing written.", file=sys.stderr)
        return None
    return model


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m compiler", description="CyberRange-Net config compiler")
    sub = parser.add_subparsers(dest="command", required=True)

    p_val = sub.add_parser("validate", help="check topology.yaml against the validation table")
    p_val.add_argument("topology", type=Path)

    p_build = sub.add_parser("build", help="validate, then write every file to the output directory")
    p_build.add_argument("topology", type=Path)
    p_build.add_argument("-o", "--out", type=Path, required=True)
    p_build.add_argument("--packet-tracer-safe", action="store_true")

    p_matrix = sub.add_parser("matrix", help="write only expected-matrix.json")
    p_matrix.add_argument("topology", type=Path)
    p_matrix.add_argument("-o", "--output", type=Path, required=True)
    p_matrix.add_argument("--packet-tracer-safe", action="store_true")

    p_diff = sub.add_parser("diff", help="compare two output directories; exit 1 if they differ")
    p_diff.add_argument("dir_a", type=Path)
    p_diff.add_argument("dir_b", type=Path)

    args = parser.parse_args(argv)
    try:
        if args.command == "diff":
            problems = diff_dirs(args.dir_a, args.dir_b)
            for line in problems:
                print(line)
            if not problems:
                print("identical")
            return 1 if problems else 0

        model = _load_checked(args.topology, getattr(args, "packet_tracer_safe", False))
        if model is None:
            return 1

        if args.command == "validate":
            sources = [s for s in model.segments if s.kind in SOURCE_KINDS]
            pairs = len(sources) * (len(model.segments) - 1)
            print(f"OK: {args.topology.name} is valid: {model.teams} teams, {len(model.segments)} segments, "
                  f"{pairs} ordered pairs, {pairs * len(PROBES)} probes.")
            return 0

        if args.command == "matrix":
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(render_matrix(model, build_rules(model)), encoding="utf-8", newline="\n")
            print(f"Wrote {args.output}")
            return 0

        written = build_out_dir(args.topology, args.out, model)
        print(f"Wrote {len(written)} files to {args.out}")
        return 0
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
