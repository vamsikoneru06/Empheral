# simulator (C3)

V6, the compromise demonstration. Starting from one team host, it sweeps every subnet that holds
addressed interfaces. Each candidate gets an ICMP attempt and a TCP SYN attempt on each of the
ports 22, 23, 80, 443, 445, 3389, 8080 and 3306. Every attempt is reachable or blocked, and a block
names the layer that stopped it.

```
python -m simulator compromise --target 10.40.1.10 [--json v6.json] [--report v6-report.html] [--config-dir out]
```

Exit codes: `0` V6 PASS, `1` V6 FAIL, `2` config error, `3` refused (target or destination out of range).

## Hard allowlist (CLAUDE.md rule 7)

- Every target and every destination must sit inside a segment listed in `out/expected-matrix.json`.
- The target must be a team host (pod or target segment, not a gateway or device address) in `out/ip-allocation.csv`.
- Anything else raises `RefusedError`, the CLI exits 3, and nothing is evaluated. There is no override flag.
- Enforcement is in code, not convention. The engine is reached only through `Sandbox.attempt`, which
  checks the allowlist first. The allowlist is a frozen tuple built from the expected matrix.
- The simulator imports no socket or network module. A test scans its source for these, and another
  patches `socket` to fail and still runs V6.

## V6 steps and pass criteria

| Step | Sweep | Pass |
|------|-------|------|
| a | own target set | at least one team host found |
| b | own pod | at least one host reachable (non-vacuity check). From a pod start: the pod's own gateway must be blocked (design decision: a pod may not reach its gateway), and any other pod host must be reachable |
| c | peer pods (all other teams) | zero reachable, zero open ports, every block named |
| d | peer target sets | same |
| e | scoring | same |
| f | institutional-a and -b | same |
| g | management plane | same |

Host discovery uses every addressed row in `ip-allocation.csv` inside each subnet, including gateways
and device addresses. "Open" means the path admits a SYN to that port. The model has no listening
services, so this is a filter-level result and says nothing about what a host is running.

Outputs: a console table, a JSON result (`cyberrange.v6/v1`, with per-attempt per-stage `checks`), and
a single-file HTML report.

## Limits

- **Config evaluation, not traffic.** Same caveats as `verifier/README.md`.
- **Blocks name every failing layer.** Each blocked attempt carries `blocking_layers` in the JSON, which
  lists all failing layers. In the compiled config the trunks carry the expected VLANs, so the ACL is
  the only failing layer for steps c, d and f. A pruned trunk shows up as a second layer under mutation.
- **No services.** Ports are admitted or blocked at the path. Nothing listens.
- **Scope.** Only the compiled model is evaluated. The simulator does not change `out/`.
