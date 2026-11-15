"""Simulator test helpers. Mutations are made on a copy in tmp_path. out/ is never written."""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "out"


def copy_out(tmp_path: Path) -> Path:
    dst = tmp_path / "out"
    shutil.copytree(OUT, dst)
    return dst


def drop_line_in_block(text: str, header: str, needle: str) -> str:
    out, inside, removed = [], False, 0
    for line in text.splitlines(keepends=True):
        bare = line.rstrip("\r\n")
        if bare == header:
            inside = True
        elif bare.startswith("!"):
            inside = False
        if inside and bare.strip() == needle:
            removed += 1
            continue
        out.append(line)
    if removed != 1:
        raise AssertionError(f"expected to remove one line {needle!r} from {header!r}, removed {removed}")
    return "".join(out)
