"""Parser: round-trips the compiled out/, and rejects anything outside the documented subset."""

from __future__ import annotations

import ipaddress
import re

import pytest

from verifier.errors import ConfigError
from verifier.inventory import load_inventory
from verifier.parser import load_model, parse_device_file

from .support import OUT, copy_out

ACL_LINE = re.compile(r"^ \d+ (permit|deny) ")


def test_parses_all_twelve_devices():
    model = load_model(OUT)
    assert len(model.devices) == 12
    assert {"SW-CORE-A", "SW-CORE-B", "SW-DIST-EXER", "SW-MGMT"} <= set(model.devices)


def test_acl_line_count_round_trips_the_file_text():
    """Every ACL line in every file is parsed. None is silently dropped."""
    model = load_model(OUT)
    parsed = sum(len(lines) for dev in model.devices.values() for lines in dev.acls.values())
    text_lines = sum(
        1 for path in OUT.glob("*.cfg") for line in path.read_text(encoding="utf-8").splitlines() if ACL_LINE.match(line)
    )
    assert parsed == text_lines > 0


def test_hosts_match_ip_allocation_csv():
    """The access-port hosts the parser reads from the .cfg files match the CSV the compiler wrote."""
    model = load_model(OUT)
    rows = load_inventory(OUT / "ip-allocation.csv")
    host_rows = [r for r in rows if r.is_host and r.device.startswith(("SW-POD", "SW-TGT", "SW-DIST"))]
    assert host_rows, "expected team and scoring hosts in the CSV"
    for row in host_rows:
        host = model.hosts.get(row.ip)
        assert host is not None, f"{row.ip} in CSV but not parsed as an access host"
        assert host.device == row.device
        assert host.interface == row.interface
        assert host.vlan == row.vlan
        assert host.enabled


def test_svi_addresses_match_csv():
    model = load_model(OUT)
    for row in load_inventory(OUT / "ip-allocation.csv"):
        if row.role != "gateway" or row.vlan is None:
            continue
        iface = model.devices[row.device].interfaces[f"Vlan{row.vlan}"]
        assert iface.address.ip == row.ip
        assert iface.address.network == ipaddress.IPv4Network(row.cidr)


def test_every_team_trunk_carries_only_the_team_vlan():
    """R2: each team uplink is pruned to that team's VLAN, on both ends."""
    model = load_model(OUT)
    dist = model.devices["SW-DIST-EXER"]
    for team in range(1, 5):
        for kind, base in (("POD", 100), ("TGT", 200)):
            access = f"SW-{kind}-0{team}"
            link = model.trunk_link(access, "SW-DIST-EXER")
            assert link is not None, f"no paired trunk for {access}"
            acc_if, dist_if = link[0], link[1]
            assert acc_if.trunk_allowed == frozenset({base + team})
            assert dist_if.trunk_allowed == frozenset({base + team})
    assert dist.ip_routing


def test_svis_and_acl_bindings_present_on_distribution():
    dist = load_model(OUT).devices["SW-DIST-EXER"]
    for vlan in (101, 102, 103, 104, 201, 202, 203, 204, 30):
        iface = dist.interfaces[f"Vlan{vlan}"]
        assert iface.access_group_in is not None
        assert iface.access_group_in in dist.acls
    assert dist.interfaces["Vlan201"].access_group_in == "TGT-1-IN"


def test_acl_lines_are_sorted_by_sequence():
    for dev in load_model(OUT).devices.values():
        for name, lines in dev.acls.items():
            seqs = [line.seq for line in lines]
            assert seqs == sorted(seqs), f"{dev.name} {name} is not in sequence order"


def _write(tmp_path, name: str, body: str):
    path = tmp_path / name
    path.write_text(body, encoding="utf-8")
    return path


def test_unknown_sub_command_is_a_config_error(tmp_path):
    src = (OUT / "SW-POD-01.cfg").read_text(encoding="utf-8")
    bad = src.replace(" no shutdown\n", " no shutdown\n ip igmp snooping\n", 1)
    with pytest.raises(ConfigError, match="unsupported interface sub-command"):
        parse_device_file(_write(tmp_path, "SW-POD-01.cfg", bad))


def test_truncated_file_is_a_config_error(tmp_path):
    src = (OUT / "SW-POD-01.cfg").read_text(encoding="utf-8")
    with pytest.raises(ConfigError, match="missing 'end'"):
        parse_device_file(_write(tmp_path, "SW-POD-01.cfg", src.replace("\nend\n", "\n")))


def test_hostname_must_match_file_name(tmp_path):
    src = (OUT / "SW-POD-01.cfg").read_text(encoding="utf-8")
    with pytest.raises(ConfigError, match="does not match file name"):
        parse_device_file(_write(tmp_path, "SW-POD-02.cfg", src))


def test_missing_config_dir_is_a_config_error(tmp_path):
    with pytest.raises(ConfigError):
        load_model(tmp_path / "nope")


def test_copy_of_out_parses_identically(tmp_path):
    copied = load_model(copy_out(tmp_path))
    real = load_model(OUT)
    assert sorted(copied.devices) == sorted(real.devices)
    assert set(copied.hosts) == set(real.hosts)
