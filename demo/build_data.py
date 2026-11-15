"""Collect the demo's data from the real compiler output, verifier and simulator into src/data.json.

The three tamper tests run the verifier on copies of out/ in a temporary folder. Nothing in out/ changes.
"""
import datetime
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

DEMO = pathlib.Path(__file__).resolve().parent
PROJECT = DEMO.parent
OUT = PROJECT / "out"
DATA = DEMO / "src" / "data.json"


def run(args):
    return subprocess.run([sys.executable, *args], cwd=PROJECT, capture_output=True, text=True, encoding="utf-8")


def verify(expected: pathlib.Path) -> dict:
    proc = run(["-m", "verifier", "run", "--expected", str(expected), "--format", "json"])
    if not proc.stdout.strip():
        raise SystemExit(f"verifier produced no JSON for {expected}: {proc.stderr}")
    return json.loads(proc.stdout)


def summary(r: dict) -> dict:
    return {
        "passed": r["passed"],
        "violations": r["violations"],
        "trunk_violations": r["trunk_violations"],
        "failing": [k for k, v in r["assertions"].items() if v is not True],
    }


def once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, f"expected exactly one match for: {old!r}"
    return text.replace(old, new)


TAMPERS = [
    ("pod1_reaches_pod2", "Someone adds a rule letting Team 1 reach Team 2.",
     " 20 deny ip any any log\n!\nip access-list extended POD-2-IN",
     " 15 permit ip 10.20.1.0 0.0.0.63 10.20.2.0 0.0.0.63\n 20 deny ip any any log\n!\nip access-list extended POD-2-IN"),
    ("tgt1_opens_to_scoring", "Someone lets a Team 1 target start connections to the scoring server.",
     " 20 permit tcp 10.40.1.0 0.0.0.63 10.10.30.0 0.0.0.255 established",
     " 20 permit ip 10.40.1.0 0.0.0.63 10.10.30.0 0.0.0.255"),
    ("tgt1_trunk_widened", "Someone lets a Team 1 cable carry Team 2's traffic too. No rule changes.",
     " description TRUNK to SW-TGT-01 GigabitEthernet0/1\n switchport trunk native vlan 999\n switchport trunk allowed vlan 201\n",
     " description TRUNK to SW-TGT-01 GigabitEthernet0/1\n switchport trunk native vlan 999\n switchport trunk allowed vlan 201-202\n"),
]


def tamper_results(tmp: pathlib.Path) -> list[dict]:
    results = []
    for name, change, old, new in TAMPERS:
        copy = tmp / name
        shutil.copytree(OUT, copy)
        cfg = copy / "SW-DIST-EXER.cfg"
        cfg.write_text(once(cfg.read_text(encoding="utf-8"), old, new), encoding="utf-8")
        results.append({"change": change, **summary(verify(copy / "expected-matrix.json"))})
    return results


def breach_run(tmp: pathlib.Path) -> dict:
    """The real V6 run from a compromised Team 1 target, and a refused out-of-range run."""
    path = tmp / "v6.json"
    run(["-m", "simulator", "compromise", "--target", "10.40.1.10", "--json", str(path), "--config-dir", str(OUT)])
    r = json.loads(path.read_text(encoding="utf-8"))
    refused = run(["-m", "simulator", "compromise", "--target", "8.8.8.8", "--config-dir", str(OUT)])
    return {
        "compromised": {"ip": r["compromised"]["ip"], "segment": r["compromised"]["segment"]},
        "passed": r["passed"],
        "steps": [{"step": s["step"], "name": s["name"], "passed": s["passed"]} for s in r["steps"]],
        "attempts": [[a["step"], a["target"], a["segment"], a["probe"], a["port"], a["result"], a["blocked_by"]] for a in r["attempts"]],
        "refused": (refused.stdout + refused.stderr).strip(),
        "refusedCode": refused.returncode,
    }


def main() -> None:
    expected_path = OUT / "expected-matrix.json"
    exp = json.loads(expected_path.read_text(encoding="utf-8"))
    base = verify(expected_path)

    acl, current = {}, None
    for line in (OUT / "SW-DIST-EXER.cfg").read_text(encoding="utf-8").splitlines():
        if line.startswith("ip access-list extended "):
            current = line.split()[-1]
            acl[current] = []
        elif current and line.startswith(" "):
            acl[current].append(line.strip())
        else:
            current = None

    acl_for = {}
    for s in exp["segments"]:
        if s["kind"] == "pod":
            acl_for[s["name"]] = f"POD-{s['team']}-IN"
        elif s["kind"] == "target":
            acl_for[s["name"]] = f"TGT-{s['team']}-IN"
        elif s["name"] == "scoring":
            acl_for[s["name"]] = "SCORING-IN"

    with tempfile.TemporaryDirectory() as tmp:
        mutants = tamper_results(pathlib.Path(tmp))
        breach = breach_run(pathlib.Path(tmp))

    matrix = base["matrix"]
    data = {
        "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "sources": list(matrix.keys()),
        "dests": sorted({d for s in matrix for d in matrix[s]}),
        "probes": exp["probes"],
        "seg": {s["name"]: {"ip": s.get("representative_ip"), "cidr": s.get("cidr"), "kind": s.get("kind"), "vlan": s.get("vlan")} for s in exp["segments"]},
        "matrix": matrix,
        "assertions": base["assertions"],
        "pairs": base["pairs_tested"],
        "probeCount": base["probes"],
        "violations": base["violations"],
        "acl": acl,
        "aclFor": acl_for,
        "baseline": summary(base),
        "mutants": mutants,
        "run": breach,
    }
    DATA.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print("baseline passed", base["passed"], "| tampers caught", [not m["passed"] for m in mutants], "| breach passed", breach["passed"], "| attempts", len(breach["attempts"]))


if __name__ == "__main__":
    main()
