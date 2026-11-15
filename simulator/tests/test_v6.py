"""V6 on the compiled out/: passes. A mutated copy: fails. No socket is ever opened."""

from __future__ import annotations

import json
import socket

import pytest

from simulator.cli import main
from simulator.sandbox import Sandbox
from simulator.v6 import PORTS, run_v6

from .support import OUT, copy_out, drop_line_in_block


@pytest.fixture
def no_sockets(monkeypatch):
    """Any attempt to open a socket fails the test."""

    def _blocked(*args, **kwargs):
        raise AssertionError("the simulator tried to open a socket")

    monkeypatch.setattr(socket, "socket", _blocked)
    monkeypatch.setattr(socket, "create_connection", _blocked)
    monkeypatch.setattr(socket, "getaddrinfo", _blocked)


def test_v6_passes_on_real_out(no_sockets):
    sb = Sandbox(OUT)
    result = run_v6(sb, sb.resolve_target("10.40.1.10"))
    assert result["passed"] is True
    steps = {s["step"]: s for s in result["steps"]}
    assert steps["a"]["hosts_found"] >= 1
    assert steps["b"]["reachable"], "own pod must be reachable, or the test proves nothing"
    for step_id in "cdefg":
        assert steps[step_id]["reachable"] == []
        assert steps[step_id]["open_ports"] == 0
        assert steps[step_id]["blocking_layers"], f"step {step_id} blocked nothing"
    blocked = [a for a in result["attempts"] if a["result"] == "blocked"]
    assert blocked and all(a["blocked_by"] and a["blocked_by"] != "unnamed" for a in blocked)


def test_v6_from_a_pod_sweeps_its_own_target_set(no_sockets):
    """Regression: step a swept the pod's own subnet when the start was a pod, so a pod start failed."""
    sb = Sandbox(OUT)
    result = run_v6(sb, sb.resolve_target("10.20.1.10"))
    steps = {s["step"]: s for s in result["steps"]}
    assert steps["a"]["subnets"] == ["10.40.1.0/26"]
    assert steps["a"]["hosts_found"] >= 1


def test_v6_from_a_pod_passes_with_its_gateway_blocked(no_sockets):
    """Decision: a pod may not reach its own gateway. A pod start must still pass V6, with the gateway blocked."""
    sb = Sandbox(OUT)
    result = run_v6(sb, sb.resolve_target("10.20.1.10"))
    steps = {s["step"]: s for s in result["steps"]}
    assert "10.20.1.1" not in steps["b"]["reachable"]
    assert steps["b"]["blocking_layers"] == {"acl:SW-DIST-EXER:POD-1-IN:20": 9}
    assert result["passed"] is True


def test_every_port_in_the_plan_is_probed(no_sockets):
    sb = Sandbox(OUT)
    result = run_v6(sb, sb.resolve_target("10.40.1.10"))
    assert result["ports"] == [22, 23, 80, 443, 445, 3389, 8080, 3306] == list(PORTS)


def test_cli_v6_exit_zero_and_writes_outputs(tmp_path, capsys, no_sockets):
    js, html = tmp_path / "v6.json", tmp_path / "v6-report.html"
    code = main(["compromise", "--target", "10.40.1.10", "--json", str(js), "--report", str(html), "--config-dir", str(OUT)])
    assert code == 0
    out = capsys.readouterr().out
    assert "V6 PASS" in out
    data = json.loads(js.read_text(encoding="utf-8"))
    assert data["passed"] is True
    assert data["attempts"][0]["checks"], "each attempt carries its per-stage checks"
    page = html.read_text(encoding="utf-8")
    assert "<script" not in page and "http://" not in page and "https://" not in page


def test_removing_target1_ingress_binding_fails_v6(tmp_path, capsys):
    copy = copy_out(tmp_path)
    dist = copy / "SW-DIST-EXER.cfg"
    dist.write_text(
        drop_line_in_block(dist.read_text(encoding="utf-8"), "interface Vlan201", "ip access-group TGT-1-IN in"),
        encoding="utf-8",
    )
    code = main(["compromise", "--target", "10.40.1.10", "--config-dir", str(copy)])
    assert code == 1
    out = capsys.readouterr().out
    assert "V6 FAIL" in out


def test_cli_exit_two_on_missing_config(tmp_path, capsys):
    assert main(["compromise", "--target", "10.40.1.10", "--config-dir", str(tmp_path / "none")]) == 2
