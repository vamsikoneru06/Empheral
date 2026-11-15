"""expected-matrix.json: schema shape and policy content."""

from __future__ import annotations

import json

from compiler.tests.support import build_into

PROBES = ["icmp", "tcp-syn", "tcp-ack", "udp"]
SOURCES = ["pod-1", "pod-2", "pod-3", "pod-4", "scoring", "target-1", "target-2", "target-3", "target-4"]


def load(tmp_path):
    out = build_into(tmp_path)
    return json.loads((out / "expected-matrix.json").read_text(encoding="utf-8"))


def test_schema_shape(tmp_path):
    m = load(tmp_path)
    assert m["schema"] == "cyberrange.expected-matrix/v1"
    assert m["profile"] == "simulation"
    assert m["teams"] == 4
    assert m["probes"] == PROBES
    assert set(m) == {"schema", "profile", "teams", "probes", "segments", "matrix"}

    assert len(m["segments"]) == 12
    for seg in m["segments"]:
        assert set(seg) == {"name", "kind", "team", "cidr", "vlan", "representative_ip"}
    kinds = [s["kind"] for s in m["segments"]]
    assert kinds.count("pod") == 4 and kinds.count("target") == 4
    assert kinds.count("scoring") == 1 and kinds.count("institutional") == 2 and kinds.count("management") == 1

    assert list(m["matrix"]) == SOURCES  # sorted keys
    for src, row in m["matrix"].items():
        assert src not in row
        assert len(row) == 11
        for dst, verdicts in row.items():
            assert list(verdicts) == sorted(PROBES)
            assert set(verdicts.values()) <= {"permit", "deny"}


def test_segment_addressing_follows_r1_and_roles(tmp_path):
    segs = {s["name"]: s for s in load(tmp_path)["segments"]}
    assert segs["pod-1"]["cidr"] == "10.20.1.0/26" and segs["pod-1"]["vlan"] == 101
    assert segs["pod-1"]["representative_ip"] == "10.20.1.10"
    assert segs["target-4"]["cidr"] == "10.40.4.0/26" and segs["target-4"]["vlan"] == 204
    assert segs["target-4"]["representative_ip"] == "10.40.4.10"
    assert segs["scoring"]["vlan"] == 30 and segs["scoring"]["representative_ip"] == "10.10.30.10"
    assert segs["management"]["representative_ip"] == "172.16.1.250"


def test_policy_content(tmp_path):
    m = load(tmp_path)["matrix"]
    assert m["target-1"]["scoring"] == {"icmp": "deny", "tcp-syn": "deny", "tcp-ack": "permit", "udp": "deny"}
    assert m["pod-1"]["pod-2"] == {"icmp": "deny", "tcp-syn": "deny", "tcp-ack": "deny", "udp": "deny"}
    assert m["pod-1"]["target-1"] == {"icmp": "permit", "tcp-syn": "permit", "tcp-ack": "permit", "udp": "permit"}
    assert m["target-1"]["pod-1"] == {"icmp": "permit", "tcp-syn": "permit", "tcp-ack": "permit", "udp": "permit"}
    assert m["scoring"]["target-3"] == {"icmp": "permit", "tcp-syn": "permit", "tcp-ack": "permit", "udp": "permit"}
    assert m["scoring"]["pod-1"] == {"icmp": "deny", "tcp-syn": "deny", "tcp-ack": "deny", "udp": "deny"}
    assert all(v == "deny" for v in m["target-1"]["target-2"].values())
    assert all(v == "deny" for v in m["target-1"]["management"].values())
    assert all(v == "deny" for v in m["target-1"]["institutional-a"].values())
    assert all(v == "deny" for v in m["pod-2"]["scoring"].values())


def test_total_permitted_cells(tmp_path):
    # pod-N -> target-N: 4 x 4 = 16; target-N -> pod-N: 16; target-N -> scoring tcp-ack: 4; scoring -> target-N: 16
    m = load(tmp_path)["matrix"]
    permits = sum(1 for row in m.values() for dst in row.values() for v in dst.values() if v == "permit")
    assert permits == 16 + 16 + 4 + 16
    assert sum(len(row) for row in m.values()) == 99  # ordered pairs
