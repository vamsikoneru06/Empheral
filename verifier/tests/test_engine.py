"""Engine verdicts on the compiled topology: the V-claims from validation-plan.md."""

from __future__ import annotations

import pytest

from verifier.engine import Engine
from verifier.parser import load_model

from .support import OUT

SYN = frozenset({"SYN"})
ACK = frozenset({"ACK"})


@pytest.fixture(scope="module")
def engine() -> Engine:
    return Engine(load_model(OUT))


def tcp_syn(engine, src, dst):
    return engine.evaluate(src, dst, "tcp", flags=SYN, dst_port=80)


def tcp_ack(engine, src, dst):
    return engine.evaluate(src, dst, "tcp", flags=ACK, dst_port=80)


def test_v1_pod_to_other_pod_denied_at_ingress_acl(engine):
    v = engine.evaluate("10.20.1.10", "10.20.2.10", "icmp")
    assert not v.permitted
    assert v.layer == "acl:SW-DIST-EXER:POD-1-IN:20"


def test_v1_target_to_other_team_pod_denied(engine):
    v = tcp_syn(engine, "10.40.1.10", "10.20.2.10")
    assert v.layer == "acl:SW-DIST-EXER:TGT-1-IN:30"


def test_v2_target_syn_to_scoring_denied(engine):
    v = tcp_syn(engine, "10.40.1.10", "10.10.30.10")
    assert not v.permitted
    assert v.layer == "acl:SW-DIST-EXER:TGT-1-IN:30"


def test_v10_target_ack_to_scoring_permitted(engine):
    assert tcp_ack(engine, "10.40.1.10", "10.10.30.10").permitted


def test_v3_scoring_polls_target_beacon(engine):
    v = engine.evaluate("10.10.30.10", "10.40.1.60", "icmp")
    assert v.permitted
    assert v.layer is None


def test_v4_exercise_to_institutional_denied(engine):
    assert not engine.evaluate("10.20.1.10", "10.10.50.10", "icmp").permitted
    assert not engine.evaluate("10.40.1.10", "10.10.52.10", "udp").permitted


def test_v5_exercise_to_management_denied(engine):
    v = engine.evaluate("10.20.1.10", "172.16.1.250", "icmp")
    assert not v.permitted
    assert v.layer == "acl:SW-DIST-EXER:POD-1-IN:20"
    assert not engine.evaluate("10.40.1.10", "172.16.1.20", "icmp").permitted


def test_v9_pod_reaches_own_target_both_ways(engine):
    assert engine.evaluate("10.20.1.10", "10.40.1.10", "icmp").permitted
    assert engine.evaluate("10.40.1.10", "10.20.1.10", "udp").permitted


def test_scoring_reaches_every_target_beacon(engine):
    for team in range(1, 5):
        assert engine.evaluate("10.10.30.10", f"10.40.{team}.60", "udp").permitted


def test_scoring_denied_to_pods_and_institutional(engine):
    assert not engine.evaluate("10.10.30.10", "10.20.1.10", "icmp").permitted
    assert not engine.evaluate("10.10.30.10", "10.10.50.10", "icmp").permitted


def test_same_segment_is_switched_without_an_acl(engine):
    v = engine.evaluate("10.40.1.10", "10.40.1.20", "icmp")
    assert v.permitted
    assert any(c.name == "acl" and c.ok is None for c in v.checks)


def test_same_segment_nonexistent_host_is_blackhole(engine):
    v = engine.evaluate("10.40.1.10", "10.40.1.11", "icmp")
    assert v.layer == "blackhole"


def test_non_host_source_is_denied_at_access_port(engine):
    v = engine.evaluate("10.40.1.11", "10.40.1.20", "icmp")
    assert v.layer == "l2-access-port"


def test_gateway_is_subject_to_the_ingress_acl(engine):
    # Traffic to the SVI itself enters the SVI, so the target ACL applies.
    assert engine.evaluate("10.40.1.10", "10.40.1.1", "icmp").layer == "acl:SW-DIST-EXER:TGT-1-IN:30"
    # The pod gateway is inside the permitted pod subnet, so it is reachable.
    assert engine.evaluate("10.40.1.10", "10.20.1.1", "icmp").permitted


def test_every_check_is_reported_in_pipeline_order(engine):
    v = engine.evaluate("10.20.1.10", "10.40.1.10", "icmp")
    assert [c.name for c in v.checks] == ["src-port", "src-trunk", "acl", "route", "dst-trunk", "dst-host"]
    assert all(c.ok for c in v.checks if c.ok is not None)


def test_trunk_pruning_blocks_a_frame_whose_vlan_the_trunk_does_not_carry():
    """The trunk layer is a real check. Remove a VLAN from the uplink and the source is cut off."""
    model = load_model(OUT)
    pod_uplink = model.devices["SW-POD-01"].interfaces["GigabitEthernet0/1"]
    pod_uplink.trunk_allowed = frozenset()
    engine = Engine(model)
    v = engine.evaluate("10.20.1.10", "10.40.1.10", "icmp")
    assert v.layer == "trunk-prune"


def test_management_deny_lines_exist_and_have_zero_hits(engine):
    assert len(engine.mgmt_deny_lines) == 4  # 2 deny lines on each core's EXER-EGRESS
    assert all(line.ref.startswith("acl:SW-CORE-") for line in engine.mgmt_deny_lines)
    assert sum(engine.mgmt_hits.values()) == 0
