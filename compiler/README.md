# compiler: the IOS subset it emits

`python -m compiler validate|build|matrix|diff`. Input is `topology.yaml` at the repo root. Output is `out/`.
This README is the contract for anyone who parses `out/`. Do not hand-edit `out/`.

## Profiles

- `topology.yaml`: simulation profile, 4 teams, 12 segments, 99 ordered pairs, 396 probes. Output in `out/`.
- `topology.production.yaml`: production profile, 16 teams, 36 segments, 1155 ordered pairs, 4620 probes. Output in `out-production/`.

Build a profile into its own directory and point the verifier and simulator at it:

```
python -m compiler build topology.production.yaml -o out-production/
python -m verifier run --expected out-production/expected-matrix.json --config-dir out-production
python -m simulator compromise --target 10.40.1.10 --config-dir out-production
```

The production device addresses are `pods 172.16.1.31-46`, `targets 172.16.1.61-76`, and `SW-MGMT 172.16.1.100`. Scoring ports are `Gi1/0/33` and `Gi1/0/34`. Both are set in the topology file, not in code.

## Output files

| File | Content |
|------|---------|
| `SW-CORE-A.cfg`, `SW-CORE-B.cfg`, `SW-DIST-EXER.cfg` | IOS for the L3 core and the exercise distribution switch |
| `SW-POD-01..04.cfg`, `SW-TGT-01..04.cfg` | IOS for each team's L2 access switches |
| `SW-MGMT.cfg` | Management switch. No trunk, no uplink, every port unused |
| `ip-allocation.csv` | `device,interface,segment,role,ip,cidr,vlan` for every addressed interface |
| `expected-matrix.json` | Policy verdicts, built from the same model as the ACLs |
| `MANIFEST.json` | SHA-256 of `topology.yaml` and of every other output. No timestamps |
| `FALLBACK-NOTICE.txt` | Only with `--packet-tracer-safe` |

Files are UTF-8, LF line endings, no timestamps, no credentials. Output is byte-identical across builds.

## Lexical layout

- Line 1 is a `!` comment. Line 2 is `hostname <DEVICE>`. The file name is `<DEVICE>.cfg`.
- A top-level line starts at column 0. A sub-command line starts with exactly one space.
- Top-level sections: `vlan N` blocks, `ip routing` (core and dist only), `interface <name>` blocks,
  `ip access-list extended <name>` blocks. Each block is followed by a line containing only `!`.
- The file ends with a line `end`.

## VLAN definitions

```
vlan 101
 name POD-1
```

| VLAN | Name | Meaning | Defined on |
|------|------|---------|------------|
| 100+N (101..104) | `POD-N` | Team N pod | SW-POD-0N, SW-DIST-EXER |
| 200+N (201..204) | `TGT-N` | Team N targets | SW-TGT-0N, SW-DIST-EXER |
| 30 | `SCORING` | Scoring hosts | SW-DIST-EXER |
| 99 | `MGMT` | Device management SVIs | every device. No port or trunk carries it |
| 999 | `NATIVE-UNUSED` | Native VLAN. Carries no hosts and no SVI | every device that has a trunk |
| 666 | `BLACKHOLE` | Unused access ports | every access and mgmt switch with an unused port |

A VLAN id appears in exactly one role. Team N's VLANs are 100+N and 200+N everywhere.

## Access ports (host-facing)

```
interface FastEthernet0/2
 description pod-1 workstation 10.20.1.10
 switchport mode access
 switchport access vlan 101
 switchport port-security
 switchport port-security maximum 1
 spanning-tree portfast
 spanning-tree bpduguard enable
 no shutdown
```

- Used ports: `description <segment> <role> <ip>`, `switchport access vlan <id>`, `no shutdown`.
- Unused ports (c2960 `FastEthernet0/1..0/24` not in use): `description UNUSED - blackhole`,
  `switchport access vlan 666`, and the last line is `shutdown`. The port-security and STP lines are the same.
- Target switches use `FastEthernet0/2..0/7` for the six roles, in order of role offset: web, db, workstation, dc, fileserver, beacon.
  Pod switches use `FastEthernet0/2` for the workstation.
- Dist access ports (scoring hosts) are `GigabitEthernet1/0/9` (engine) and `GigabitEthernet1/0/10` (validator).

## Trunks

```
interface GigabitEthernet0/1
 description TRUNK to SW-DIST-EXER GigabitEthernet1/0/1
 switchport trunk native vlan 999
 switchport trunk allowed vlan 101
 switchport mode trunk
 switchport nonegotiate
 no shutdown
```

- Every trunk has an explicit `switchport trunk allowed vlan <id[,id...]>` list. Ranges are never used.
- Both ends of a link carry the same allowed list.
- `switchport nonegotiate` turns DTP off. Native VLAN is always 999.
- Team uplinks carry only that team's VLAN (R2). Access uplinks are `GigabitEthernet0/1`.
  In the shipped topology, the dist port for pod N is `GigabitEthernet1/0/N` and for target N is `GigabitEthernet1/0/(4+N)`.
  The port comes from the `links:` entries in `topology.yaml`, not from the compiler.

## SVIs (VLAN interfaces)

```
interface Vlan101
 description pod-1 gateway
 ip address 10.20.1.1 255.255.255.192
 ip access-group POD-1-IN in
 no shutdown
```

- Exercise and scoring SVIs are on `SW-DIST-EXER`: `Vlan101..104` (pods), `Vlan201..204` (targets), `Vlan30` (scoring).
- Each SVI address is the first host of its segment (`.1`). The mask is dotted decimal.
- `ip access-group <ACL> in` binds the ingress ACL. It filters packets that enter the SVI from its VLAN.
- Management: `interface Vlan99` on every device, `ip address <mgmt> 255.255.255.0`, no ACL. The VLAN is not trunked,
  so these addresses are not reachable through any exercise path.

## Routed ports (core)

```
interface GigabitEthernet1/0/10
 description institutional-a gateway 10.10.50.1
 no switchport
 ip address 10.10.50.1 255.255.255.128
 ip access-group EXER-EGRESS out
 no shutdown
```

- `SW-CORE-A` owns institutional-a (10.10.50.0/25). `SW-CORE-B` owns institutional-b (10.10.52.0/25).
- `ip access-group EXER-EGRESS out` filters packets leaving the core toward institutional networks (R10).
- No dist-to-core transit link is emitted in this version. Exercise routes do not reach the cores.

## ACL syntax

```
ip access-list extended POD-1-IN
 10 permit ip 10.20.1.0 0.0.0.63 10.40.1.0 0.0.0.63
 20 deny ip any any log
```

- Grammar: `<seq> <permit|deny> <ip|tcp> <src> <dst> [established|eq 80] [log]`.
- `<src>` and `<dst>` are `any` or `<network> <wildcard>`. The wildcard is the inverse netmask. For example `0.0.0.63` is /26.
- Sequence numbers are 10, 20, 30, and so on. Lines are evaluated in ascending sequence order and the first match wins.
- `ip` matches any IP protocol (ICMP, UDP, TCP). `tcp` matches TCP only.
- `established` matches TCP with ACK or RST set. A SYN without ACK does not match it.
- `eq 80` matches TCP with destination port 80. It appears only in fallback builds.
- A packet that matches no line is denied (IOS implicit deny). The compiler always writes the explicit final line
  `<seq> deny ip any any log`, and that line is last in every ingress ACL.

ACL names and bindings:

| ACL | Bound to | Direction | Lines |
|-----|----------|-----------|-------|
| `POD-N-IN` | `Vlan10N` | in | R7: `permit ip` pod-N to target-N, then deny |
| `TGT-N-IN` | `Vlan20N` | in | R8: `permit ip` target-N to pod-N; `permit tcp ... established` target-N to scoring; then deny |
| `SCORING-IN` | `Vlan30` | in | R9: `permit ip` scoring to target-N, one line per N; then deny |
| `EXER-EGRESS` | institutional routed ports | out | R10: `deny ip` exercise blocks to each institutional and management CIDR; then `permit ip any any` |

Example for target 2:
```
ip access-list extended TGT-2-IN
 10 permit ip 10.40.2.0 0.0.0.63 10.20.2.0 0.0.0.63
 20 permit tcp 10.40.2.0 0.0.0.63 10.10.30.0 0.0.0.255 established
 30 deny ip any any log
```

## Where each VLAN lives, and the ACL path

Exercise VLANs have no inter-switch routing in this version. All exercise SVIs and their ACLs sit on `SW-DIST-EXER`.
A packet from segment S to segment D is handled as follows:
1. The packet enters the SVI of S's VLAN on `SW-DIST-EXER`. Apply `<ACL of S> in`, first match wins.
2. If permitted, it is routed to a connected SVI that contains D's address. For exercise and scoring D, that is on `SW-DIST-EXER`.
3. If D is not connected to any device's SVI, the packet is unreachable. This covers institutional and management destinations.

## Expected matrix and probe semantics

`expected-matrix.json` schema is `cyberrange.expected-matrix/v1`. Keys are sorted. Verdicts are `permit` or `deny`.
The 9 sources are `pod-1..4`, `target-1..4`, `scoring`. The 11 destinations are every other segment. That gives 99 pairs and 396 probes.

| Probe | Meaning | Matched by |
|-------|---------|------------|
| `icmp` | ICMP echo | `permit ip` only |
| `udp` | UDP | `permit ip` only |
| `tcp-syn` | TCP, SYN set, ACK clear | `permit ip` only. Under fallback also `eq 80` |
| `tcp-ack` | TCP, ACK set | `permit ip`, `established`, or `eq 80` |

The verifier probes each segment's `representative_ip` (from the matrix `segments` list).
Under fallback, the tcp probes to scoring are assumed to target TCP/80.

## Deviations from the example in config-compiler.md

- Management block is `172.16.1.0/24` (contract), not `172.16.0.0/16`. Device management IPs are `172.16.1.10..50`.
- Target and scoring ACLs match the subnet `10.10.30.0/24`, not `host 10.10.30.10`. This keeps the segment-level
  matrix correct for the validator at .11.
- R9 uses one `permit` line per target subnet, not `10.40.0.0/16`. Each line is a subset of 10.40.0.0/16.
- `vlans.management` (99), `scoring.vlan`, `scoring.cidr`, `institutional` and `links` are added to the topology schema.
- Interface names: `FastEthernet0/n` and `GigabitEthernet0/1` on c2960; `GigabitEthernet1/0/n` on c3650.

## Packet Tracer fallback (`--packet-tracer-safe`)

R8's `established` line becomes `permit tcp <target> <wc> 10.10.30.0 0.0.0.255 eq 80`, one per team.
This is weaker. It allows a SYN to TCP/80 on the scoring subnet, and the matrix records that. `FALLBACK-NOTICE.txt` lists every substitution.
