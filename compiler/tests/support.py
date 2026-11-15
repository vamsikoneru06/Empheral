"""Shared helpers for the compiler tests: the real topology, mutable copies, and a build helper."""

from __future__ import annotations

from pathlib import Path

import yaml

from compiler.cli import main

ROOT = Path(__file__).resolve().parents[2]
TOPOLOGY = ROOT / "topology.yaml"


def raw_topology() -> dict:
    return yaml.safe_load(TOPOLOGY.read_text(encoding="utf-8"))


def build_into(tmp_path: Path, packet_tracer_safe: bool = False) -> Path:
    out = tmp_path / "out"
    argv = ["build", str(TOPOLOGY), "-o", str(out)]
    if packet_tracer_safe:
        argv.append("--packet-tracer-safe")
    assert main(argv) == 0
    return out
