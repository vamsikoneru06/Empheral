# CyberRange-Net — Product Requirements Document

**Project:** CyberRange-Net Control Plane
**Subtitle:** A Breach-Tolerant Network Architecture for Adversarial Training Environments
**Author:** Vamsi Koneru (RA2411030010013, Section W1), SRMIST
**Course:** Computer Network Laboratory — 14-week case study
**Version:** 1.0 · 2026-11-02
**Status:** Draft for implementation

---

## 1. Summary

CyberRange-Net is the software control plane for a university cyber range — a facility where
students practise offensive and defensive security in competitive exercises.

Conventional network design assumes intrusion is an exceptional event to be prevented. A cyber
range inverts that: compromise is the intended workload, occurring continuously and by design.
No reference architecture exists for this, so institutions improvise and land in one of two
failure modes — isolation so tight that realistic lateral movement cannot be practised, or so
loose that exploitation escapes into scoring, judging or institutional infrastructure.

This project builds the software that makes the architecture enforceable, verifiable and
repeatable. The physical and logical network is designed and simulated separately (Weeks 1–3 of
the lab); this PRD covers everything that runs as code.

---

## 2. Problem Statement

> Enterprise network architecture is built on the premise that intrusion is exceptional. Cyber
> ranges invert this premise entirely. Existing reference architectures therefore provide no
> usable guidance, and a further requirement goes unaddressed: state reversibility. A range must
> return to a verified clean baseline between rounds, yet restoring machines that were moments
> earlier under adversary control requires privileged access to exactly those machines — creating
> a path an attacker can target.
>
> CyberRange-Net proposes three design principles — **asymmetric reachability**, **blast-radius
> bounding** and **out-of-band state control** — and builds the control plane that enforces and
> continuously proves them.

### 2.1 Novelty claim

Every published network design treats breach as a failure to minimise. This one treats breach as
a normal operating condition and asks a different question: given that compromise *will* happen,
what topology and control plane guarantee it stays bounded? The deliverable is not a honeypot or
a scoring script but a **containment compiler and verifier** — software that generates the
enforcing configuration and then programmatically proves the guarantee holds.

---

## 3. Goals and Non-Goals

### 3.1 Goals

| # | Goal | Success measure |
|---|------|-----------------|
| G1 | Generate all network configuration from a single topology definition | 1 command emits valid IOS config for every device |
| G2 | Prove containment programmatically | Full N×N reachability matrix, zero manual testing |
| G3 | Score a live competitive exercise | Flag polls at ≤30 s interval, leaderboard lag <5 s |
| G4 | Reset the range to a clean baseline between rounds | Reset completes in <10 min for 16 teams |
| G5 | Keep all control traffic out-of-band | No control-plane component addressable from any exercise VLAN |
| G6 | Make the exercise fair and reproducible | Every team's environment structurally identical |

### 3.2 Non-Goals

- Not a hypervisor or VM orchestrator — it *drives* one, it does not replace it
- Not an IDS/SIEM — logs are emitted, analysis is out of scope
- Not a CTF challenge authoring tool — challenges are supplied as images
- No GUI automation of Cisco Packet Tracer (no API exists); configs are generated for paste
- Not production-hardened; this is an academic reference implementation

---

## 4. Users and Use Cases

| Persona | Needs | Primary surface |
|---------|-------|-----------------|
| **Range Engineer** | Build the range, generate config, reset between rounds | CLI + admin dashboard |
| **Competitor** | See own targets, submit flags, see own score | Public leaderboard (read-only) |
| **Judge** | Rank teams, resolve disputes, inspect timeline | Judging view |
| **Faculty / Evaluator** | Proof that containment holds | Verification report |
| **Blue Team** | Observe defended segments | Read-only telemetry view |

### 4.1 Primary flows

1. **Range provisioning** — engineer defines team count → compiler emits config → applied to devices
2. **Containment verification** — verifier runs full matrix → report → fail build if any violation
3. **Exercise round** — scoring polls flag beacons → competitors submit flags → leaderboard updates
4. **Inter-round reset** — orchestrator restores golden images over the management plane
5. **Post-round review** — judges replay the event timeline from the log store

---

## 5. Design Principles (binding constraints)

### P1 — Asymmetric Reachability
The scoring engine polls competitor targets to verify flags. No return path exists from any
target to scoring. Enforced in the network by `permit tcp … established` and in software by
scoring never exposing an inbound listener on any exercise-reachable interface.

### P2 — Blast-Radius Bounding
Total compromise of one team's segment yields zero reachability to any other team, to scoring, to
judging, or to institutional services. Containment is a property of wiring and routing, not of
software that could itself be compromised.

### P3 — Out-of-Band State Control
Reset, imaging and orchestration traverse a physically separate management plane (172.16.0.0/16)
with no route to or from any exercise segment. An attacker inside the range cannot see, address
or reach the plane that controls the range.

> **Rule for every PR:** if a change would let an exercise-zone host originate traffic to a
> control-plane component, the change is rejected regardless of its benefit.

---

## 6. System Components

| ID | Component | Language | Runs on | Purpose |
|----|-----------|----------|---------|---------|
| C1 | **Config Compiler** | Python | Engineer workstation | Topology definition → Cisco IOS config |
| C2 | **Containment Verifier** | Python | Mgmt plane | Tests every segment pair, emits matrix |
| C3 | **Attack Simulator** | Python | Pod segment | Sweeps, port scans, lateral-movement attempts |
| C4 | **Scoring Engine** | Node.js / Express | Scoring VLAN 30 | Flag polling, validation, scoring |
| C5 | **Orchestrator** | Node.js | Mgmt plane | Round lifecycle, baseline restore |
| C6 | **Dashboard** | React | Scoring VLAN 30 | Leaderboard, judging, admin views |
| C7 | **Log Store** | MySQL | Logging VLAN 41 | Events, scores, verification history |

---

## 7. Functional Requirements

### 7.1 Config Compiler (C1)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1.1 | Accept a YAML topology definition (team count, zones, addressing base) | Must |
| FR-1.2 | Emit per-device Cisco IOS config: VLANs, access ports, trunks, SVIs, ACLs | Must |
| FR-1.3 | Prune each team trunk to that team's VLAN only | Must |
| FR-1.4 | Set native VLAN 999 and blackhole VLAN 666 on every access switch | Must |
| FR-1.5 | Generate mirrored addressing: team N pod `10.20.N.0/26`, targets `10.40.N.0/26` | Must |
| FR-1.6 | Emit a deny-by-default inbound ACL per exercise SVI | Must |
| FR-1.7 | Validate output: no VLAN overlap, no address collision, no ACL shadowing | Must |
| FR-1.8 | Support 4-team (simulation) and 16-team (production) profiles from one definition | Must |
| FR-1.9 | Emit a Packet-Tracer-safe variant (fallback where `established` is unsupported) | Should |
| FR-1.10 | Idempotent — same input always produces byte-identical output | Should |

### 7.2 Containment Verifier (C2)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-2.1 | Enumerate every (source segment, destination segment) pair | Must |
| FR-2.2 | Test each pair for ICMP, TCP connect, and UDP reachability | Must |
| FR-2.3 | Compare observed matrix against the expected policy matrix | Must |
| FR-2.4 | Exit non-zero on any violation (usable as a CI gate) | Must |
| FR-2.5 | Emit an HTML + JSON report with a colour-coded matrix | Must |
| FR-2.6 | Specifically assert asymmetry: scoring→target permitted, target→scoring denied | Must |
| FR-2.7 | Assert the management plane is unreachable from every exercise segment | Must |
| FR-2.8 | Record every run to the log store for trend comparison | Should |

### 7.3 Attack Simulator (C3)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.1 | Host-discovery sweep across own and foreign subnets | Must |
| FR-3.2 | TCP port scan of discovered hosts | Must |
| FR-3.3 | Attempt lateral movement to peer team, scoring, admin, management | Must |
| FR-3.4 | Report which attempts succeeded and which were blocked, with the blocking layer | Must |
| FR-3.5 | Run only against the simulated range; refuse any out-of-range target | Must |

### 7.4 Scoring Engine (C4)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4.1 | Poll every team's flag beacon (`10.40.N.60`) on a fixed interval | Must |
| FR-4.2 | Validate submitted flags against the round's flag table | Must |
| FR-4.3 | Score: first-blood bonus, service-uptime points, defence points | Must |
| FR-4.4 | Never open an inbound listener reachable from any exercise VLAN | Must |
| FR-4.5 | Emit every scoring event to the log store with a monotonic sequence number | Must |
| FR-4.6 | Expose a read-only leaderboard API to the judging and public views | Must |
| FR-4.7 | Freeze the leaderboard in the final N minutes of a round | Should |
| FR-4.8 | Detect and flag duplicate or replayed flag submissions | Must |

### 7.5 Orchestrator (C5)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.1 | Define a round: teams, duration, image set, flag set | Must |
| FR-5.2 | Provision each team's targets from the golden image set | Must |
| FR-5.3 | Inject per-round, per-team unique flags at provisioning time | Must |
| FR-5.4 | Restore all targets to clean baseline between rounds | Must |
| FR-5.5 | Operate exclusively over the management plane | Must |
| FR-5.6 | Verify restore integrity by image hash before declaring a round ready | Must |
| FR-5.7 | Refuse to start a round if the last verification run failed | Must |

### 7.6 Dashboard (C6)

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-6.1 | Public leaderboard: rank, score, service status per team | Must |
| FR-6.2 | Judging view: event timeline, dispute notes, manual score adjustment with audit trail | Must |
| FR-6.3 | Admin view: round control, reset trigger, verification report | Must |
| FR-6.4 | Competitor view scoped to own team only | Must |
| FR-6.5 | Containment matrix rendered as an interactive heatmap | Should |
| FR-6.6 | Live updates via polling or SSE; no inbound connection from exercise zone | Must |

---

## 8. Non-Functional Requirements

| ID | Category | Requirement |
|----|----------|-------------|
| NFR-1 | Performance | Flag poll cycle ≤30 s for 16 teams; leaderboard lag <5 s |
| NFR-2 | Performance | Full containment matrix (16 teams, ~40 segments) completes in <5 min |
| NFR-3 | Reliability | A round survives a single core switch failure (HSRP) |
| NFR-4 | Reliability | Scoring engine restart loses no scored events (durable write before ack) |
| NFR-5 | Security | No control-plane component listens on an exercise-reachable interface |
| NFR-6 | Security | All judge and admin actions are written to an append-only audit log |
| NFR-7 | Fairness | Every team's target set is structurally identical; verified by hash |
| NFR-8 | Reproducibility | A round is fully described by its config; re-running yields the same setup |
| NFR-9 | Auditability | Every scoring event carries a monotonic sequence number and timestamp |
| NFR-10 | Portability | Runs against Packet Tracer (4 teams) and GNS3 (16 teams) without code change |

---

## 9. Data Model (summary)

Full schema in `docs/data-model.md`.

| Table | Purpose |
|-------|---------|
| `teams` | Team identity, VLAN assignment, subnet |
| `rounds` | Round lifecycle, start/end, image set, status |
| `targets` | Per-team target hosts, role, address, image hash |
| `flags` | Per-round per-team flag values, injection time |
| `submissions` | Flag submissions: team, value, verdict, timestamp |
| `score_events` | Append-only scoring ledger with sequence number |
| `service_polls` | Flag beacon poll results, uptime computation source |
| `verification_runs` | Containment verifier results and matrix snapshots |
| `audit_log` | Judge and admin actions, append-only |

---

## 10. Interfaces

Full spec in `docs/api-spec.md`.

| Method | Path | Consumer | Notes |
|--------|------|----------|-------|
| GET | `/api/leaderboard` | Public, judging | Read-only, cached 2 s |
| GET | `/api/teams/:id` | Competitor | Scoped to own team |
| POST | `/api/submissions` | Competitor | Rate-limited, replay-checked |
| GET | `/api/rounds/current` | All | Round state and clock |
| POST | `/api/rounds` | Admin | Create round |
| POST | `/api/rounds/:id/reset` | Admin | Trigger baseline restore |
| GET | `/api/verification/latest` | Admin, faculty | Matrix + pass/fail |
| POST | `/api/judge/adjust` | Judge | Manual adjustment, audited |

---

## 11. Validation Plan

The architecture's claims are only claims until proven. Full method in `docs/validation-plan.md`.

| # | Claim | Method | Pass criterion |
|---|-------|--------|----------------|
| V1 | Teams cannot reach each other | Verifier matrix, all team pairs | 100 % denied |
| V2 | Targets cannot reach scoring | Simulator initiates from target | Connection refused/dropped |
| V3 | Targets can reply to scoring | Scoring polls, measures response | Poll succeeds |
| V4 | Exercise zone cannot reach institutional | Verifier matrix | 100 % denied |
| V5 | Management plane unreachable | Verifier + ACL hit counter | Zero hits, zero reachability |
| V6 | Full compromise stays bounded | Simulator with root on a target, full sweep | No escape to any other zone |
| V7 | Environments are identical | Hash every team's target set | All hashes equal |
| V8 | Reset restores clean baseline | Modify a target, reset, re-hash | Hash matches golden |

**V6 is the headline result.** Everything else supports it.

---

## 12. Delivery Phases

Aligned to the lab's 14-week schedule.

| Phase | Weeks | Deliverable |
|-------|-------|-------------|
| 0 | 1–3 | Design document, IP plan, built topology *(complete)* |
| 1 | 4–5 | Config compiler + VLAN/ACL generation; routing to branch |
| 2 | 6–7 | Enterprise services; scoring engine skeleton; data model |
| 3 | 8–9 | Containment verifier; CI gate; first full matrix |
| 4 | 10–11 | Orchestrator, round lifecycle, baseline reset |
| 5 | 12 | Dashboard — leaderboard, judging, admin |
| 6 | 13 | Attack simulator; V6 compromise demonstration |
| 7 | 14 | Final report, viva demo, documentation freeze |

---

## 13. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Packet Tracer rejects `established` | Weakens P1 demo | Port-based fallback; document the substitution |
| Packet Tracer degrades past ~60 devices | Cannot simulate 16 teams | Simulate 4 teams; identical containment properties; state as engineering decision |
| Scoring engine becomes a pivot target | Breaks P1 | No inbound listener on exercise-facing interface; verified by V2 |
| Reset path becomes an attack path | Breaks P3 | Orchestration strictly over management plane; verified by V5 |
| Scope creep into a full CTF platform | Misses the deadline | Non-goals in §3.2 are binding |
| Hand-built topology drifts from compiler output | Verification is meaningless | Compiler output is the single source of truth; re-paste on every change |

---

## 14. Open Questions

| # | Question | Owner | Needed by |
|---|----------|-------|-----------|
| Q1 | GNS3 for 16-team scale, or stay at 4 teams throughout? | Team | Week 8 |
| Q2 | Scoring formula weights — uptime vs offence vs defence | Faculty | Week 6 |
| Q3 | Hypervisor target for the orchestrator (Proxmox API vs mock) | Team | Week 10 |
| Q4 | Does the faculty want a live demo or a recorded one for V6? | Faculty | Week 12 |

---

## 15. Glossary

| Term | Meaning |
|------|---------|
| **Pod** | A competitor team's own workstation segment |
| **Target** | A deliberately vulnerable host the team attacks or defends |
| **Flag beacon** | Host at `10.40.N.60` that scoring polls to verify service liveness |
| **Blast radius** | The set of segments reachable from a fully compromised segment |
| **Golden image** | The verified clean baseline a target is restored to |
| **Management plane** | Out-of-band network (172.16.0.0/16) carrying only control traffic |
| **Blackhole VLAN** | VLAN 666 — every unused access port, no route anywhere |
