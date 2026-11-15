"""Each validation failure in config-compiler.md (and the management-uplink rule) must trigger."""

from __future__ import annotations

import ipaddress

import pytest
import yaml

from compiler.cli import main
from compiler.model import ConfigError, build_model
from compiler.policy import AclLine, find_shadowed
from compiler.tests.support import TOPOLOGY, raw_topology
from compiler.validate import validate


def errors_after(mutate) -> str:
    raw = raw_topology()
    mutate(raw)
    return "\n".join(validate(build_model(raw)))


def net(text: str) -> ipaddress.IPv4Network:
    return ipaddress.IPv4Network(text)


def test_real_topology_is_valid():
    assert validate(build_model(raw_topology())) == []


def test_duplicate_vlan_id_fails():
    assert "duplicate VLAN" in errors_after(lambda r: r["vlans"].update(pod_base=200))


def test_overlapping_subnet_fails():
    assert "overlap" in errors_after(lambda r: r["scoring"].update(cidr="10.40.1.0/24"))


def test_team_roles_must_be_identical_full_set_fails():
    assert "target_roles must define exactly" in errors_after(lambda r: r["target_roles"].pop("beacon"))


def test_target_role_outside_subnet_fails():
    assert "outside usable range" in errors_after(lambda r: r["target_roles"].update(beacon=70))


def test_trunk_without_allowed_list_fails():
    assert "no explicit allowed VLAN list" in errors_after(lambda r: r["links"][0].update(vlans=[]))


def test_uplink_carrying_a_second_vlan_fails_r2():
    assert "R2" in errors_after(lambda r: r["links"][0].update(vlans=[101, 102]))


def test_native_vlan_1_fails():
    assert "native VLAN must not be 1" in errors_after(lambda r: r["vlans"].update(native_unused=1))


def test_native_vlan_carrying_a_host_fails():
    assert "carries host" in errors_after(lambda r: r["vlans"].update(native_unused=101))


def test_device_management_ip_outside_block_fails():
    assert "management IP" in errors_after(lambda r: r["devices"][0].update(mgmt="10.1.1.1"))


def test_management_switch_with_uplink_fails():
    def add_uplink(r):
        r["links"].append({"a": "SW-MGMT", "a_port": "GigabitEthernet0/1", "b": "SW-DIST-EXER",
                           "b_port": "GigabitEthernet1/0/11", "kind": "trunk", "vlans": [30]})
    assert "management switch SW-MGMT has an uplink" in errors_after(add_uplink)


def test_shadowed_acl_line_is_detected():
    lines = [
        AclLine("permit", "ip", net("10.20.1.0/26"), net("10.40.1.0/26")),
        AclLine("permit", "tcp", net("10.20.1.0/27"), net("10.40.1.0/26"), "established"),
    ]
    assert find_shadowed(lines) == [(0, 1)]


def test_unshadowed_acl_is_clean():
    lines = [
        AclLine("permit", "tcp", net("10.40.1.0/26"), net("10.10.30.0/24"), "established"),
        AclLine("permit", "ip", net("10.40.1.0/26"), net("10.20.1.0/26")),
        AclLine("deny", "ip", None, None, log=True),
    ]
    assert find_shadowed(lines) == []


def test_missing_key_is_a_config_error():
    raw = raw_topology()
    del raw["teams"]
    with pytest.raises(ConfigError):
        build_model(raw)


def test_invalid_topology_exits_1_and_writes_nothing(tmp_path):
    raw = raw_topology()
    raw["vlans"]["native_unused"] = 1
    bad = tmp_path / "bad.yaml"
    bad.write_text(yaml.safe_dump(raw), encoding="utf-8")
    out = tmp_path / "out"
    assert main(["validate", str(bad)]) == 1
    assert main(["build", str(bad), "-o", str(out)]) == 1
    assert not out.exists()


def test_real_topology_file_exits_0():
    assert main(["validate", str(TOPOLOGY)]) == 0
