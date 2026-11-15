"""The allowlist refuses out-of-range targets and destinations. Refusals exit 3 and evaluate nothing."""

from __future__ import annotations

import ipaddress
from pathlib import Path

import pytest

from simulator import sandbox as sandbox_module
from simulator.cli import main
from simulator.sandbox import RefusedError, Sandbox

from .support import OUT

SIMULATOR_DIR = Path(sandbox_module.__file__).resolve().parent


@pytest.fixture(scope="module")
def sb() -> Sandbox:
    return Sandbox(OUT)


@pytest.mark.parametrize(
    "target, why",
    [
        ("8.8.8.8", "public internet"),
        ("10.10.60.1", "inside 10.10.0.0/16 but in no listed segment"),
        ("10.40.1.99", "inside 10.40.0.0/16 but outside target-1's /26"),
        ("10.40.1.11", "inside target-1 but not an addressed host in ip-allocation.csv"),
        ("10.40.1.1", "addressed, but a gateway, not a team host"),
        ("10.10.30.10", "scoring engine, not a team host"),
        ("172.16.1.10", "management device address"),
        ("not-an-ip", "not an IPv4 address"),
    ],
)
def test_target_outside_the_range_is_refused(sb, target, why):
    with pytest.raises(RefusedError):
        sb.resolve_target(target)


@pytest.mark.parametrize("target", ["8.8.8.8", "10.10.60.1", "10.40.1.99", "10.40.1.11"])
def test_cli_exits_three_for_refused_targets(target, capsys):
    assert main(["compromise", "--target", target, "--config-dir", str(OUT)]) == 3
    assert "REFUSED" in capsys.readouterr().err


def test_refused_target_writes_no_report(tmp_path):
    report = tmp_path / "v6.html"
    js = tmp_path / "v6.json"
    main(["compromise", "--target", "8.8.8.8", "--config-dir", str(OUT), "--report", str(report), "--json", str(js)])
    assert not report.exists() and not js.exists()


def test_attempt_refuses_destination_outside_allowlist_even_when_called_directly(sb):
    with pytest.raises(RefusedError):
        sb.attempt(ipaddress.IPv4Address("10.40.1.10"), ipaddress.IPv4Address("8.8.8.8"), "icmp")


def test_attempt_refuses_out_of_range_source(sb):
    with pytest.raises(RefusedError):
        sb.attempt(ipaddress.IPv4Address("10.10.60.1"), ipaddress.IPv4Address("10.40.1.10"), "icmp")


def test_valid_target_resolves_to_the_inventory_row(sb):
    row = sb.resolve_target("10.40.1.10")
    assert row.role == "web"
    assert row.segment == "target-1"


def test_simulator_source_has_no_socket_or_network_import():
    """The simulator evaluates the compiled model only. It must not be able to open a socket."""
    for path in SIMULATOR_DIR.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        for banned in ("import socket", "from socket", "import http", "import urllib", "import requests", "subprocess"):
            assert banned not in text, f"{path.name} contains {banned!r}"
