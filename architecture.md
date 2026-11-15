# Architecture

## 1. Zone model

Seven zones. Trust decreases left to right; control flows one way.

```
  MANAGEMENT PLANE  (172.16.0.0/16)  -- isolated, no route to anything below
        |
        | provisioning, reset, console  (out-of-band only)
        v
  +---------------------------------------------------------------+
  |  CONTROL ZONE                                                  |
  |  Orchestrator (C5) | Scoring (C4) | Dashboard (C6) | Logs (C7) |
  +---------------------------------------------------------------+
        |
        |  polls targets  (one-way: no return path)
        v
  +---------------------------------------------------------------+
  |  EXERCISE ZONE   -- assumed hostile at all times               |
  |                                                                |
  |  Team 1 pod  -->  Team 1 targets      (and only Team 1's)      |
  |  Team 2 pod  -->  Team 2 targets                               |
  |  ...                                                           |
  |  no path between teams, no path out                            |
  +---------------------------------------------------------------+
```

## 2. Network tiers

| Tier | Devices | Role |
|------|---------|------|
| Core | 2 × L3, HSRP | Inter-zone routing, redundancy |
| Distribution | 5 × L3 | Zone boundaries; **all containment ACLs live here** |
| Access | 22 × L2 | One dedicated switch per team |
| Management | 1 switch + console server | Out-of-band, no uplink to core |

`Dist-EXER` is the single chokepoint for all hostile traffic. One switch to audit.

## 3. Containment layers

Four independent layers. Defeating one still meets the next.

| Layer | Mechanism | Defeats |
|-------|-----------|---------|
| 1 — Physical | Dedicated access switch per team | Direct L2 adjacency |
| 2 — L2 VLAN | Separate VLAN per pod and target set | Broadcast sharing, ARP poisoning |
| 3 — L2 trunk | Pruned allowed-VLAN list, native 999, DTP off | VLAN hopping, double-tagging |
| 4 — L3 ACL | Deny-by-default inbound on every exercise SVI | Routed lateral movement |

Layer 1 cannot be defeated by any configuration error at all — that is why it exists.

## 4. Software components

```
   Engineer workstation
        |
   [C1 Config Compiler]  --(IOS text)-->  network devices
        |
        +--> topology.yaml is the single source of truth


   Management plane (172.16.0.0/16)
        |
   [C5 Orchestrator] ---- provision / reset ----> hypervisor hosts
        |
   [C2 Containment Verifier] -- probes --> every segment pair
        |                                       |
        +---------------------------------------+--> [C7 Log Store]


   Scoring VLAN 30
        |
   [C4 Scoring Engine] -- outbound polls only --> flag beacons 10.40.N.60
        |
   [C6 Dashboard] <-- reads --> [C7 Log Store]  (MySQL, VLAN 41)
```

### Component boundaries

| Component | May reach | May be reached by |
|-----------|-----------|-------------------|
| C1 Compiler | Nothing at runtime (offline tool) | Engineer only |
| C2 Verifier | Everything (probes from mgmt plane) | Nothing |
| C3 Simulator | Its own pod segment only | Nothing |
| C4 Scoring | All targets (outbound) | Dashboard, judging (read-only) |
| C5 Orchestrator | Hypervisors via mgmt plane | Admin via jump host |
| C6 Dashboard | C7 | Judges, admins, public leaderboard |
| C7 Log store | Nothing | C2, C4, C5, C6 |

## 5. Round lifecycle

```
  PLANNED --> PROVISIONING --> VERIFYING --> READY --> RUNNING --> FROZEN --> CLOSED
                   |               |                                            |
                   |               +-- verification fails --> BLOCKED           |
                   |                                                            |
                   +<------------------ reset ----------------------------------+
```

**Gate:** a round cannot move `VERIFYING → READY` unless the containment matrix passes with
zero violations. This makes the architecture's guarantee a precondition for running at all,
not an afterthought.

## 6. Asymmetric reachability — how it actually works

Three independent enforcement points, all required:

1. **Network** — `permit tcp <target-subnet> host 10.10.30.10 established` on the target SVI.
   Only segments with ACK or RST set pass. A target's opening SYN toward scoring carries
   neither, so it is dropped.
2. **Software** — the scoring engine binds no listener on any interface routable from the
   exercise zone. Flag submission arrives via the dashboard, which sits behind the judging
   boundary, not via scoring directly.
3. **Verification** — V2 and V3 in the validation plan assert both halves every run: the
   target cannot initiate, and scoring's poll still succeeds.

Losing any one of the three loses the property. All three are tested.

## 7. Failure modes and responses

| Failure | Detection | Response |
|---------|-----------|----------|
| Core switch down | HSRP failover | Round continues; logged |
| Target unresponsive | Flag poll timeout | Service-uptime points stop accruing |
| Scoring engine crash | Dashboard heartbeat gap | Restart; durable ledger replays |
| Verification fails mid-round | Scheduled verifier run | Alert admin; round not auto-stopped |
| Containment violation found | Verifier matrix mismatch | Round blocked from starting; CI gate fails |
| Image hash mismatch after reset | Orchestrator integrity check | Re-provision that target; round stays PROVISIONING |
