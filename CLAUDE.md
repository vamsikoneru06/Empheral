# CyberRange-Net — Repo Rules

Read `docs/PRD.md` before any non-trivial change. The design principles in §5 are binding
constraints, not guidelines.

## What this project is

Software control plane for a cyber range: a network where compromise is the *intended*
workload, not a failure. The job is to make breach **bounded** and the boundary **provable**.

## Hard rules

1. **No control-plane component may be reachable from an exercise VLAN.**
   Exercise VLANs are `101-116` (pods) and `201-216` (targets), subnets `10.20.0.0/16` and
   `10.40.0.0/16`. If a change lets a host there originate traffic to scoring, orchestration,
   logging or the management plane — reject it, whatever it buys.

2. **The compiler is the single source of truth for network config.**
   Never hand-edit a `.cfg` in `out/`. Change `topology.yaml` and rebuild.

3. **The compiler also emits the expected policy matrix.**
   The verifier tests against that file. Never write the expected matrix by hand — the point is
   that the two cannot drift.

4. **`score_events` and `audit_log` are append-only.**
   No UPDATE, no DELETE. Corrections are new rows with negative points.

5. **Never store a computed total.** The leaderboard is `SUM(points)` at read time.

6. **The management switch has no uplink.** If code or config adds one, that is a bug in the
   architecture, not a missing feature.

7. **The attack simulator must refuse out-of-range targets.** Hard allowlist of the simulated
   subnets. No flag to override it.

## Stack

| Part | Tech |
|------|------|
| Compiler, verifier, simulator | Python 3.11, Jinja2 templates, pytest |
| Scoring, orchestrator | Node.js 20, Express, mysql2 |
| Dashboard | React 18, Vite |
| Store | MySQL 8 |
| Network | Cisco Packet Tracer (4 teams) or GNS3 (16 teams) |

## Layout

```
compiler/      Python  - topology.yaml -> IOS config + expected matrix
verifier/      Python  - probes every segment pair, diffs vs expected
simulator/     Python  - attack simulation for V6
scoring/       Node    - flag polling, validation, ledger
orchestrator/  Node    - round lifecycle, baseline reset
dashboard/     React   - leaderboard, judging, admin
db/            SQL migrations
docs/          PRD and specs - read before changing behaviour
out/           GENERATED - never edit by hand
```

## Conventions

- Team number is `N`; it appears as the third octet and as VLAN `100+N` / `200+N`. Keep that
  relationship everywhere — the mirrored addressing is what makes the exercise fair.
- Target roles are fixed: `web .10`, `db .20`, `workstation .30`, `dc .40`, `fileserver .50`,
  `beacon .60`. Same for every team, always.
- Timestamps UTC, RFC 3339, millisecond precision on scoring events.
- Compiler output must be deterministic — build twice, `diff -r` must be empty.

## Before you commit

```bash
pytest compiler/ verifier/ simulator/
npm test --prefix scoring
python -m compiler validate topology.yaml
python -m compiler build topology.yaml -o out/
python -m verifier run --expected out/expected-matrix.json   # must exit 0
```

A change that makes the verifier fail is not finished, even if the feature works.

## Context

Academic case study, 14-week Computer Network Laboratory, SRMIST. Reference implementation —
clarity over production hardening. Weeks 1–3 (design, IP plan, topology) are complete; see
`docs/` for the schedule.
