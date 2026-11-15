"""Build out/: render every file, write MANIFEST.json with hashes, remove stale generated files."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .model import Model
from .policy import Rule, build_rules
from .render import render_csv, render_device, render_fallback_notice, render_matrix

GENERATOR_VERSION = "1.0"
STATIC_GENERATED = {"ip-allocation.csv", "expected-matrix.json", "MANIFEST.json", "FALLBACK-NOTICE.txt"}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def render_outputs(model: Model, rules: list[Rule]) -> dict[str, str]:
    outputs: dict[str, str] = {}
    for dev in model.devices:
        outputs[f"{dev.name}.cfg"] = render_device(model, dev, rules)
    outputs["ip-allocation.csv"] = render_csv(model)
    outputs["expected-matrix.json"] = render_matrix(model, rules)
    if model.packet_tracer_safe:
        outputs["FALLBACK-NOTICE.txt"] = render_fallback_notice(model)
    return outputs


def build_out_dir(topology_path: Path, out_dir: Path, model: Model) -> list[str]:
    """Write every output file. Returns the sorted list of written file names."""
    rules = build_rules(model)
    outputs = render_outputs(model, rules)
    manifest = {
        "generator": "cyberrange-compiler",
        "generator_version": GENERATOR_VERSION,
        "input": {
            "file": topology_path.name,
            "sha256": sha256_bytes(topology_path.read_bytes()),
        },
        "packet_tracer_safe": model.packet_tracer_safe,
        "outputs": {name: sha256_bytes(text.encode("utf-8")) for name, text in sorted(outputs.items())},
    }
    outputs["MANIFEST.json"] = json.dumps(manifest, indent=2, sort_keys=True) + "\n"

    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.iterdir():
        is_generated = stale.is_file() and (
            (stale.name.startswith("SW-") and stale.name.endswith(".cfg")) or stale.name in STATIC_GENERATED
        )
        if is_generated and stale.name not in outputs:
            stale.unlink()
    for name, text in outputs.items():
        (out_dir / name).write_text(text, encoding="utf-8", newline="\n")
    return sorted(outputs)


def diff_dirs(dir_a: Path, dir_b: Path) -> list[str]:
    files_a = {p.name for p in dir_a.iterdir() if p.is_file()}
    files_b = {p.name for p in dir_b.iterdir() if p.is_file()}
    problems = [f"only in {dir_a}: {n}" for n in sorted(files_a - files_b)]
    problems += [f"only in {dir_b}: {n}" for n in sorted(files_b - files_a)]
    for name in sorted(files_a & files_b):
        if (dir_a / name).read_bytes() != (dir_b / name).read_bytes():
            problems.append(f"differs: {name}")
    return problems
