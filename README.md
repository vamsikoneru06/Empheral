# CyberRange-Net

**A Breach-Tolerant Network Architecture for Adversarial Training Environments**

Computer Network Laboratory case study · SRMIST · Vamsi Koneru (RA2411030010013, W1)

---

## The idea in one paragraph

Every network design assumes intrusion is a failure to prevent. A cyber range — where students
practise attacking and defending — inverts that: compromise is the product, happening
continuously and on purpose. No reference architecture exists for this, so ranges end up either
too locked down to practise on or too loose to contain an escape. CyberRange-Net designs for
containment instead of prevention, and builds the software that *proves* the containment holds.

## Three principles

| | Principle | Means |
|---|-----------|-------|
| **P1** | Asymmetric reachability | Scoring reaches targets; no return path exists |
| **P2** | Blast-radius bounding | One fully compromised team reaches nothing else |
| **P3** | Out-of-band state control | Reset runs on a plane attackers cannot address |

## What's built

| Component | Does |
|-----------|------|
| **Config Compiler** | `topology.yaml` → every device's Cisco IOS config, plus the expected policy matrix |
| **Containment Verifier** | Probes every segment pair, diffs against expected, fails the build on any violation |
| **Attack Simulator** | Simulates full compromise of one target and reports what it could reach |
| **Scoring Engine** | Polls flag beacons, validates submissions, append-only score ledger |
| **Orchestrator** | Round lifecycle, provisioning, baseline reset over the management plane |
| **Dashboard** | Leaderboard, judging timeline, admin controls, containment heatmap |

## Docs

| File | Contents |
|------|----------|
| [`docs/PRD.md`](docs/PRD.md) | Problem, goals, requirements, phases, risks |
| [`docs/architecture.md`](docs/architecture.md) | Zones, tiers, containment layers, round lifecycle |
| [`docs/data-model.md`](docs/data-model.md) | MySQL schema and invariants |
| [`docs/api-spec.md`](docs/api-spec.md) | REST endpoints by role |
| [`docs/config-compiler.md`](docs/config-compiler.md) | Topology format, generation rules, CLI |
| [`docs/validation-plan.md`](docs/validation-plan.md) | How each claim gets proven |
| [`CLAUDE.md`](CLAUDE.md) | Repo rules for Claude Code |

## Quick start

```bash
# generate all network config + the expected policy matrix
python -m compiler build topology.yaml -o out/

# prove containment holds
python -m verifier run --expected out/expected-matrix.json
#   exit 0 = every segment pair behaves exactly as the policy says

# the headline demo: full compromise of one target, bounded
python -m simulator compromise --target 10.40.1.10 --report v6-report.html
```

## The claim, and the proof

> Grant root on one team's target. Sweep everything. It reaches its own pod and nothing else —
> not the peer team, not scoring, not the admin network, not the management plane.

That is test V6 in [`docs/validation-plan.md`](docs/validation-plan.md). Everything else in the
project exists to support it.

## Status

Weeks 1–3 complete (design document, IP allocation, built topology). Week 4 onward builds the
control plane. See PRD §12 for the phase schedule.
