"""The emitted IOS ACLs, read back from the .cfg files and evaluated first-match, must reproduce
expected-matrix.json for every ordered pair and every probe. This is the no-drift guarantee tested end to end."""

from __future__ import annotations

import ipaddress
import json

import pytest

from compiler.tests.support import build_into

PROBE_PACKETS = {
    "icmp": ("icmp", False, None),
    "udp": ("udp", False, None),
    "tcp-syn": ("tcp", False, 80),
    "tcp-ack": ("tcp", True, 80),
}


def _spec(tokens: list[str], i: int):
    if tokens[i] == "any":
        return None, i + 1
    prefix = 32 - bin(int(ipaddress.IPv4Address(tokens[i + 1]))).count("1")
    return ipaddress.IPv4Network((tokens[i], prefix)), i + 2


def parse_acls(text: str) -> dict[str, list[dict]]:
    acls: dict[str, list[dict]] = {}
    current = None
    for line in text.splitlines():
        if line.startswith("ip access-list extended "):
            current = line.rsplit(" ", 1)[1]
            acls[current] = []
        elif current and line.startswith(" "):
            t = line.split()
            src, i = _spec(t, 3)
            dst, i = _spec(t, i)
            qualifier = ""
            if i < len(t) and t[i] == "established":
                qualifier, i = "established", i + 1
            elif i < len(t) and t[i] == "eq":
                qualifier, i = f"eq {t[i + 1]}", i + 2
            acls[current].append({"action": t[1], "proto": t[2], "src": src, "dst": dst,
                                  "qualifier": qualifier, "log": "log" in t[i:]})
        else:
            current = None
    return acls


def parse_svi_acls(text: str) -> list[tuple[ipaddress.IPv4Network, str]]:
    result = []
    net = acl = None
    in_vlan = False
    for line in text.splitlines():
        if line.startswith("interface "):
            in_vlan = line.startswith("interface Vlan")
            net = acl = None
        elif in_vlan and line.startswith(" ip address "):
            _, _, ip, mask = line.split()
            net = ipaddress.IPv4Network(f"{ip}/{mask}", strict=False)
        elif in_vlan and line.startswith(" ip access-group "):
            acl = line.split()[2]
        elif line == "!" and in_vlan and net and acl:
            result.append((net, acl))
            in_vlan = False
    return result


def acl_permits(entries: list[dict], src: str, dst: str, probe: str) -> bool:
    proto, ack, port = PROBE_PACKETS[probe]
    s, d = ipaddress.IPv4Address(src), ipaddress.IPv4Address(dst)
    for e in entries:
        if e["proto"] == "tcp" and proto != "tcp":
            continue
        if e["src"] is not None and s not in e["src"]:
            continue
        if e["dst"] is not None and d not in e["dst"]:
            continue
        if e["qualifier"] == "established" and not ack:
            continue
        if e["qualifier"].startswith("eq ") and port != int(e["qualifier"][3:]):
            continue
        return e["action"] == "permit"
    return False  # unreachable in practice: every ACL ends with deny ip any any log


@pytest.mark.parametrize("packet_tracer_safe", [False, True])
def test_acls_reproduce_expected_matrix(tmp_path, packet_tracer_safe):
    out = build_into(tmp_path, packet_tracer_safe=packet_tracer_safe)
    matrix = json.loads((out / "expected-matrix.json").read_text(encoding="utf-8"))
    acls: dict[str, list[dict]] = {}
    svi_acls: list[tuple[ipaddress.IPv4Network, str]] = []
    for cfg in out.glob("SW-*.cfg"):
        text = cfg.read_text(encoding="utf-8")
        acls.update(parse_acls(text))
        svi_acls += parse_svi_acls(text)

    segments = {s["name"]: s for s in matrix["segments"]}
    checked = 0
    for src, row in matrix["matrix"].items():
        src_net = ipaddress.IPv4Network(segments[src]["cidr"])
        acl_name = next(name for net, name in svi_acls if net == src_net)
        entries = acls[acl_name]
        assert entries[-1] == {"action": "deny", "proto": "ip", "src": None, "dst": None,
                               "qualifier": "", "log": True}, acl_name
        for dst, verdicts in row.items():
            for probe, expected in verdicts.items():
                permitted = acl_permits(entries, segments[src]["representative_ip"],
                                        segments[dst]["representative_ip"], probe)
                assert ("permit" if permitted else "deny") == expected, (src, dst, probe)
                checked += 1
    assert checked == 99 * 4
