"""python -m simulator compromise --target IP [--report FILE.html] [--json FILE.json] [--config-dir DIR]

Exit codes: 0 V6 PASS, 1 V6 FAIL, 2 config error, 3 target or destination refused (out of range).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from verifier.errors import ConfigError

from .report import console_table, render_html, write_json
from .sandbox import RefusedError, Sandbox
from .v6 import run_v6

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "out"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m simulator", description="CyberRange-Net attack simulator (C3)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("compromise", help="V6: sweep from one compromised team host")
    p.add_argument("--target", required=True, help="compromised team host, e.g. 10.40.1.10")
    p.add_argument("--report", type=Path, default=None, help="write the HTML report here")
    p.add_argument("--json", type=Path, default=None, help="write the JSON result here")
    p.add_argument("--config-dir", type=Path, default=DEFAULT_CONFIG, help="compiled output directory (default: out/)")
    args = parser.parse_args(argv)
    try:
        sandbox = Sandbox(args.config_dir)
        compromised = sandbox.resolve_target(args.target)
    except RefusedError as exc:
        print(f"REFUSED: {exc}. Nothing was evaluated.", file=sys.stderr)
        return 3
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    try:
        result = run_v6(sandbox, compromised)
    except RefusedError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 3
    except ConfigError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(console_table(result))
    if args.json:
        write_json(result, args.json)
        print(f"wrote {args.json}", file=sys.stderr)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(render_html(result), encoding="utf-8")
        print(f"wrote {args.report}", file=sys.stderr)
    return 0 if result["passed"] else 1
