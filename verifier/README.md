# verifier (C2)

Containment verifier. It reads the compiled IOS in `out/*.cfg`, evaluates every probe in
`out/expected-matrix.json` through the config model, and diffs the result.

```
python -m verifier run --expected out/expected-matrix.json                      # text, exit 0 on pass
python -m verifier run --expected out/expected-matrix.json --format json        # JSON on stdout
python -m verifier run --expected out/expected-matrix.json --format json,html --out reports
```

Exit codes: `0` pass, `1` violations or a failed assertion, `2` config or probe error.
`--out` must not be inside the config directory. Reports are never written into `out/`.

## What it evaluates

This is **config-level evaluation, not live packets.** The engine walks the compiled model for one
packet:

| # | Stage | Blocking layer when it fails |
|---|-------|------------------------------|
| 1 | source host is on an enabled access port | `l2-access-port` |
| 2 | source uplink trunk carries the source VLAN, both ends | `trunk-prune` |
| 3 | ingress ACL on the source SVI, first match, implicit deny last | `acl:<device>:<acl>:<seq>` (or `:implicit`) |
| 4 | longest-prefix route over connected SVIs on the routing device | `no-route` |
| 5 | destination uplink trunk carries the destination VLAN, both ends | `trunk-prune` |
| 6 | a host answers in that VLAN on an enabled port | `blackhole` or `l2-access-port` |

Same-segment traffic is switched at L2 and skips stages 3 and 4. Every stage is computed, and the
blocking layer is the first failing one. The engine is `verifier/engine.py`. The simulator uses it
together with the parser and the expected-matrix and inventory loaders.

Probe mapping: `icmp` is ICMP. `tcp-syn` is TCP with SYN and no ACK. `tcp-ack` is TCP with ACK.
`udp` is UDP. TCP probes carry port 80, which only matters for fallback `eq 80` lines. Source and
destination are each segment's `representative_ip`.

## Assertions

Each assertion is derived from observed cells with the matching source and destination kinds:

- `team_to_team_denied`: pod or target to a pod or target of another team, all probes denied.
- `target_to_scoring_denied`: target to scoring denies `icmp`, `tcp-syn` and `udp`, and permits
  `tcp-ack` (the V10 reply path). One assertion covers both halves of the asymmetry.
- `scoring_to_target_permitted`: scoring to every target, all probes permitted.
- `exercise_to_institutional_denied`: pod or target to institutional, all denied.
- `mgmt_plane_unreachable`: every source to management, all denied.
- `mgmt_acl_counter_zero`: real hits on management-deny lines are zero. The report also gives the
  number of such lines it watches (`mgmt_deny_lines`).
- `environments_identical`: each target set's `role -> offset` structure hashes equal (V7).

`passed` is true only when there are no violations and every assertion holds.

## Lab results (real probes)

The default run evaluates the compiled config. To check a real lab, export the model's values as a template, have the lab replace each `observed` with a probe result, and verify those values:

```
python -m verifier run --expected out/expected-matrix.json --export-template lab.csv
# edit lab.csv: observed = permit or deny, from ping and TCP tests in the lab
python -m verifier run --expected out/expected-matrix.json --live-results lab.csv --format json,html --out reports
```

- The CSV has one row per controlled cell: `source,destination,probe,observed`. Every row must be present. A missing cell is a `not-probed` violation, never a pass.
- The lab's values replace the model's. The config model still names the blocking layer and runs the trunk checks.
- `mgmt_acl_counter_zero` is `NOT MEASURED` in a lab run. Probes cannot read counters. Read the core's ACL counters on the device to check it.
- The report's `backend` is `lab-import`.

This replaces the need for an automated Packet Tracer driver, which the PRD rules out.

## Limits, stated plainly

- **Config evaluation, not traffic.** Nothing is sent. A correct report proves the compiled config
  implies the expected matrix. It does not prove the switches run that config.
- **V5 counter is zero by construction.** The management-deny lines are in the core's EXER-EGRESS.
  No transit link joins the cores to the distribution switch, so no modelled packet reaches them.
- **Every failing layer is reported.** A denied verdict's `layers` lists every failing layer, not
  only the first. A pruned destination uplink therefore appears next to the ACL block that
  already stops the same packet (`verifier/tests/test_trunk_invariant.py`). In the compiled
  config the trunks carry the expected VLANs, so those layers are visible only under mutation.
- **Trunk lists are checked against R2.** `verifier/trunks.py` requires each access-switch uplink to
  carry exactly its own VLAN, on both ends. A trunk widened to another team's VLAN is a violation
  (`trunk_violations` in the report), even when the matrix cells are unchanged, and it fails the gate.
- **Missing lists fail closed.** A trunk with no `switchport trunk allowed vlan` line carries
  nothing. An ACL bound to an SVI but not defined counts as a deny.
- **Representative IPs.** Institutional (`10.10.50.10`) and management (`172.16.1.250`) have no
  host in the compiled output. Those cells are decided at the ACL or route stage.

## Files

- `parser.py`: strict reader for the `compiler/README.md` IOS subset. Unknown lines are a `ConfigError`.
- `engine.py`: the packet pipeline. `Engine(model).evaluate(src, dst, proto, flags, dst_port)`.
- `matrix.py`: probes the 9 sources against 11 destinations (99 pairs, 396 probes) and derives assertions.
- `expected.py`, `inventory.py`: loaders for the expected matrix and `ip-allocation.csv`.
- `report.py`, `html_report.py`: JSON and text summary, and the single-file heatmap.
- `tests/`: parser round-trip, engine verdicts, CLI shape, and mutation tests on a copy of `out/`.
