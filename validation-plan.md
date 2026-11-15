# Validation Plan

The architecture's claims are claims until proven. This is how each one gets proven, and what
counts as a pass.

## Method

The verifier builds the **observed matrix** by probing every ordered pair of segments, then
diffs it against `expected-matrix.json` emitted by the compiler. Any cell that differs is a
violation. The compiler and verifier therefore cannot drift: one writes the policy, the other
tests it.

Probe types per pair: ICMP echo, TCP connect to a known port, UDP probe.

For 4 teams: ~20 segments → 380 ordered pairs → 1,140 probes.
For 16 teams: ~40 segments → 1,560 ordered pairs → 4,680 probes.

## Test matrix

| # | Claim | Source | Destination | Expected | Method |
|---|-------|--------|-------------|----------|--------|
| V1 | Teams cannot reach each other | every pod | every other pod + target set | **Denied** | Full pair sweep |
| V2 | Targets cannot initiate to scoring | every target | `10.10.30.10` | **Denied** | SYN from target |
| V3 | Scoring can poll targets | `10.10.30.10` | every beacon `10.40.N.60` | Permitted | Poll + response |
| V4 | Exercise cannot reach institutional | all pods + targets | `10.10.50.0/25`, `10.10.52.0/25` | **Denied** | Pair sweep |
| V5 | Management plane unreachable | all pods + targets | `172.16.1.0/24` | **Denied** | Sweep + ACL counter |
| V6 | Full compromise stays bounded | compromised target (root) | everything | **Denied except own pod** | Simulator, §3 |
| V7 | Environments are identical | — | — | all hashes equal | Hash each team's target set |
| V8 | Reset restores baseline | — | — | hash matches golden | Modify → reset → re-hash |
| V9 | Pod reaches own targets | pod N | target set N | Permitted | Pair sweep |
| V10 | Target replies to open scoring session | target | scoring | Permitted | Poll response path |

## V5 — the zero-counter assertion

The core ACL carries two deny lines for `172.16.0.0/16` that are strictly redundant: the
management plane has no physical path to the exercise zone, so no packet can arrive to be
denied. They are configured anyway as defence in depth.

**Their hit counters should remain permanently at zero.** A non-zero counter means the
management plane has been mis-cabled. This makes the ACL a cheap, permanent audit of the
architecture's most important assumption. The verifier reads the counter and fails on any
non-zero value.

## V6 — the headline demonstration

Everything else supports this one. Run it as the viva demo.

```
1. Grant root on 10.40.1.10 (Team 1's web target) — simulating full compromise
2. From that host:
     a. sweep own subnet          10.40.1.0/26     -> expect: hosts found
     b. sweep own team's pod      10.20.1.0/26     -> expect: reachable
     c. sweep peer team pod       10.20.2.0/26     -> expect: NOTHING
     d. sweep peer team targets   10.40.2.0/26     -> expect: NOTHING
     e. connect to scoring        10.10.30.10      -> expect: REFUSED
     f. sweep institutional       10.10.50.0/25    -> expect: NOTHING
     g. sweep management plane    172.16.1.0/24    -> expect: NOTHING
3. Report which layer blocked each attempt (trunk prune / ACL / no route)
```

**Pass criterion:** steps c through g yield zero reachable hosts and zero open ports, and the
report attributes each block to a named enforcement layer.

Steps c, d and f are expected to fail at **two** independent layers — the pruned trunk drops the
frame at L2, and the SVI ACL would drop the packet at L3 even if the trunk were misconfigured.
The report should show both. Neither depends on the other.

*Implementation note.* In the compiled config each peer's uplink carries only its own VLAN (R2), so
the trunk does not drop these frames and the SVI ACL is the only failing layer. The verifier reports
every failing layer for each probe, and `verifier/tests/test_trunk_invariant.py` shows the L2 block
when a trunk is pruned. The R2 check (`verifier/trunks.py`) fails any uplink that is widened.

## Report format

```json
{
  "ran_at": "2026-11-02T08:52:00Z",
  "profile": "simulation",
  "pairs_tested": 380,
  "probes": 1140,
  "violations": 0,
  "passed": true,
  "assertions": {
    "team_to_team_denied": true,
    "target_to_scoring_denied": true,
    "scoring_to_target_permitted": true,
    "exercise_to_institutional_denied": true,
    "mgmt_plane_unreachable": true,
    "mgmt_acl_counter_zero": true,
    "environments_identical": true
  },
  "matrix": { "10.20.1.0/26": { "10.40.1.0/26": "permit",
                                "10.20.2.0/26": "deny" } }
}
```

HTML output renders the matrix as a heatmap: green permitted-and-expected, grey
denied-and-expected, red any mismatch. A correct run is green on the diagonal blocks and grey
everywhere else — a glance is enough.

## CI gate

```bash
python -m verifier run --expected out/expected-matrix.json --format json,html
echo $?    # 0 = pass, 1 = violations found, 2 = probe error
```

Wire into the round lifecycle: `VERIFYING → READY` requires exit 0. A round whose containment
cannot be proven does not start.

## Weekly schedule

| Week | What gets validated |
|------|---------------------|
| 4 | V1, V9 — VLAN segmentation holds |
| 5 | V4 — routing added, institutional still unreachable |
| 6 | V3, V10 — services up, scoring polls work |
| 8 | V2, V5 — asymmetry and mgmt isolation, first full matrix |
| 10 | V7, V8 — provisioning and reset integrity |
| 13 | **V6** — full compromise demonstration |
