"""The 16-team production profile (FR-1.8): same rules, one topology file, counts that follow from 16 teams."""

from __future__ import annotations

import json
from pathlib import Path

from compiler.cli import main

ROOT = Path(__file__).resolve().parents[2]
TOPOLOGY = ROOT / "topology.production.yaml"


def test_production_topology_validates():
    assert main(["validate", str(TOPOLOGY)]) == 0


def test_production_build_has_the_counts_for_16_teams(tmp_path):
    assert main(["build", str(TOPOLOGY), "-o", str(tmp_path)]) == 0
    matrix = json.loads((tmp_path / "expected-matrix.json").read_text(encoding="utf-8"))
    assert matrix["teams"] == 16
    assert matrix["profile"] == "production"
    # 16 pods + 16 target sets + scoring + 2 institutional blocks + management
    assert len(matrix["segments"]) == 36
    # 33 controlled sources (16 pods, 16 targets, scoring), each to the 35 other segments
    assert len(matrix["matrix"]) == 33
    assert sum(len(dsts) for dsts in matrix["matrix"].values()) == 33 * 35
    # four probe types per pair
    assert sum(len(cell) for dsts in matrix["matrix"].values() for cell in dsts.values()) == 33 * 35 * 4


def test_production_policy_matches_the_simulation_rules(tmp_path):
    assert main(["build", str(TOPOLOGY), "-o", str(tmp_path)]) == 0
    matrix = json.loads((tmp_path / "expected-matrix.json").read_text(encoding="utf-8"))["matrix"]
    # team 16 keeps the same shape as team 1
    assert matrix["pod-16"]["target-16"] == {"icmp": "permit", "tcp-syn": "permit", "tcp-ack": "permit", "udp": "permit"}
    assert matrix["pod-16"]["pod-1"]["icmp"] == "deny"
    assert matrix["target-16"]["scoring"] == {"icmp": "deny", "tcp-syn": "deny", "tcp-ack": "permit", "udp": "deny"}
    assert matrix["scoring"]["target-1"]["tcp-syn"] == "permit"
