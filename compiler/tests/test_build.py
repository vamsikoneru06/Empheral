"""Build outputs: required files, determinism, manifest hashes, management switch, fallback mode."""

from __future__ import annotations

import hashlib
import json

from compiler.build import diff_dirs
from compiler.tests.support import build_into

REQUIRED_CFGS = [
    "SW-CORE-A.cfg", "SW-CORE-B.cfg", "SW-DIST-EXER.cfg",
    "SW-POD-01.cfg", "SW-POD-02.cfg", "SW-POD-03.cfg", "SW-POD-04.cfg",
    "SW-TGT-01.cfg", "SW-TGT-02.cfg", "SW-TGT-03.cfg", "SW-TGT-04.cfg",
    "SW-MGMT.cfg",
]


def test_required_files_are_present_and_no_fallback_notice(tmp_path):
    out = build_into(tmp_path)
    names = {p.name for p in out.iterdir()}
    assert set(REQUIRED_CFGS) <= names
    assert {"ip-allocation.csv", "expected-matrix.json", "MANIFEST.json"} <= names
    assert "FALLBACK-NOTICE.txt" not in names


def test_build_twice_is_byte_identical(tmp_path):
    first = build_into(tmp_path / "a")
    second = build_into(tmp_path / "b")
    assert diff_dirs(first, second) == []
    for path in first.iterdir():
        assert path.read_bytes() == (second / path.name).read_bytes(), path.name


def test_fallback_build_is_deterministic_too(tmp_path):
    first = build_into(tmp_path / "a", packet_tracer_safe=True)
    second = build_into(tmp_path / "b", packet_tracer_safe=True)
    assert diff_dirs(first, second) == []


def test_manifest_hashes_match_the_files(tmp_path):
    out = build_into(tmp_path)
    manifest = json.loads((out / "MANIFEST.json").read_text(encoding="utf-8"))
    for name, digest in manifest["outputs"].items():
        assert hashlib.sha256((out / name).read_bytes()).hexdigest() == digest, name
    assert "MANIFEST.json" not in manifest["outputs"]


def test_management_switch_has_no_trunk_or_uplink(tmp_path):
    text = (build_into(tmp_path) / "SW-MGMT.cfg").read_text(encoding="utf-8")
    assert "switchport mode trunk" not in text
    assert "GigabitEthernet0/1" not in text
    assert "ip address 172.16.1.50 255.255.255.0" in text


def test_access_uplink_carries_only_its_team_vlan(tmp_path):
    out = build_into(tmp_path)
    text = (out / "SW-TGT-03.cfg").read_text(encoding="utf-8")
    assert "switchport trunk allowed vlan 203" in text
    assert "switchport trunk native vlan 999" in text
    assert "switchport nonegotiate" in text


def test_fallback_substitutes_eq_80_and_records_it(tmp_path):
    out = build_into(tmp_path, packet_tracer_safe=True)
    notice = (out / "FALLBACK-NOTICE.txt").read_text(encoding="utf-8")
    assert "team 1: fallback permit tcp 10.40.1.0 0.0.0.63 10.10.30.0 0.0.0.255 eq 80" in notice
    acl = (out / "SW-DIST-EXER.cfg").read_text(encoding="utf-8").split("ip access-list extended TGT-1-IN")[1]
    acl = acl.split("!")[0]
    assert "eq 80" in acl
    assert "established" not in acl
    matrix = json.loads((out / "expected-matrix.json").read_text(encoding="utf-8"))
    assert matrix["matrix"]["target-1"]["scoring"]["tcp-syn"] == "permit"
