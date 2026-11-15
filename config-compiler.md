# Config Compiler (C1)

Turns one topology definition into every device's Cisco IOS configuration. The definition is
the single source of truth; hand-edited device config is a bug.

## Input — `topology.yaml`

```yaml
profile: simulation          # simulation (4 teams) | production (16 teams)
teams: 4

addressing:
  institutional: 10.10.0.0/16
  pods:          10.20.0.0/16
  targets:       10.40.0.0/16
  management:    172.16.0.0/16
  pod_prefix:    26           # /26 per team
  target_prefix: 26

vlans:
  pod_base:    100            # team N -> 100 + N
  target_base: 200            # team N -> 200 + N
  native_unused: 999
  blackhole:     666

scoring:
  engine_ip:    10.10.30.10
  validator_ip: 10.10.30.11

target_roles:                 # identical for every team -> fairness
  web:         10
  db:          20
  workstation: 30
  dc:          40
  fileserver:  50
  beacon:      60

devices:
  - { name: SW-CORE-A,     model: c3650, role: core,  mgmt: 172.16.1.10 }
  - { name: SW-CORE-B,     model: c3650, role: core,  mgmt: 172.16.1.11 }
  - { name: SW-DIST-EXER,  model: c3650, role: dist,  zone: exercise, mgmt: 172.16.1.20 }
  - { name: SW-POD-01,     model: c2960, role: access, team: 1, kind: pod,    mgmt: 172.16.1.31 }
  - { name: SW-TGT-01,     model: c2960, role: access, team: 1, kind: target, mgmt: 172.16.1.41 }

options:
  packet_tracer_safe: false   # true -> replace 'established' with port-based fallback
```

## Output

```
out/
  SW-CORE-A.cfg
  SW-CORE-B.cfg
  SW-DIST-EXER.cfg
  SW-POD-01.cfg ... SW-POD-04.cfg
  SW-TGT-01.cfg ... SW-TGT-04.cfg
  ip-allocation.csv          # the Week 2 sheet, generated
  expected-matrix.json       # feeds the verifier
  MANIFEST.json              # input hash + output hashes
```

`expected-matrix.json` is the important one: the compiler knows what it permitted, so it also
writes the policy the verifier will test against. The two can never drift.

## Generation rules

| Rule | Detail |
|------|--------|
| R1 | Team N pod = `10.20.N.0/26`, VLAN `100+N`; targets = `10.40.N.0/26`, VLAN `200+N` |
| R2 | Each team's uplink trunk carries **only** that team's VLAN |
| R3 | Every trunk: `native vlan 999`, `switchport nonegotiate` |
| R4 | Every unused access port: VLAN 666, `shutdown` |
| R5 | Every access port: `port-security maximum 1`, `bpduguard enable`, `portfast` |
| R6 | Every exercise SVI gets an inbound ACL ending `deny ip any any log` |
| R7 | Pod ACL permits only its own target subnet |
| R8 | Target ACL permits its own pod, plus `established` back to scoring |
| R9 | Scoring ACL permits scoring hosts outbound to `10.40.0.0/16` only |
| R10 | Core egress ACL denies exercise → institutional and exercise → management |

## Validation (runs before writing output)

| Check | Failure is |
|-------|-----------|
| No duplicate VLAN id | fatal |
| No overlapping subnet | fatal |
| Every team has identical target roles | fatal |
| No ACL line shadowed by an earlier line | fatal |
| Every trunk has an explicit allowed list | fatal |
| Native VLAN is not 1 and carries no hosts | fatal |
| Every device has a management IP in `172.16.1.0/24` | fatal |
| Management switch has no uplink defined | fatal — **this is the architecture** |

## CLI

```bash
python -m compiler build   topology.yaml -o out/
python -m compiler build   topology.yaml -o out/ --packet-tracer-safe
python -m compiler validate topology.yaml
python -m compiler diff     out/ out-previous/
python -m compiler matrix   topology.yaml -o expected-matrix.json
```

## Determinism

Same input must produce byte-identical output: sorted keys, no timestamps inside `.cfg` files,
fixed ACL line ordering. `MANIFEST.json` carries the hashes so a drift is detectable.

Test: `build` twice into different directories; `diff -r` must be empty.

## Packet Tracer fallback

If `packet_tracer_safe: true`, rule R8's line

```
permit tcp 10.40.N.0 0.0.0.63 host 10.10.30.10 established
```

becomes

```
permit tcp 10.40.N.0 0.0.0.63 host 10.10.30.10 eq 80
```

and the compiler writes `FALLBACK-NOTICE.txt` recording the substitution. The one-way property
is then enforced by port rather than TCP flag — weaker, same design intent. **Record this in
the lab report rather than letting it pass silently.**
