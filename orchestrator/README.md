# orchestrator (C5)

Round lifecycle, provisioning, the verification gate and reset for CyberRange-Net.
Node 20+, CommonJS, no dependencies. Tests use `node:test`.

    npm install --prefix orchestrator
    npm test --prefix orchestrator

## Lifecycle

    planned -> provisioning -> verifying -> ready -> running -> frozen -> closed
                                  |                                        |
                                  +-> blocked (gate failed)                |
    blocked, closed -> provisioning (reset) -> verifying  <----------------+

- `VERIFYING -> READY` needs the verifier to exit 0. `READY -> RUNNING` needs this round's latest run to have passed (FR-5.7).
- `reset` returns 409 `round_not_running` while the round is running. It restores every target to the golden baseline and checks each hash. A mismatch leaves the round in `provisioning`.
- Each admin action (create, provision, verify, reset, start, freeze, close) writes exactly one `audit_log` row, including refused ones. `status` is read-only and writes nothing.

## CLI

    node orchestrator/src/cli.js provision --round N
    node orchestrator/src/cli.js verify --round N
    node orchestrator/src/cli.js reset --round N
    node orchestrator/src/cli.js status [--round N]

Exit codes: 0 success, 1 refused, failed, or a failed verification, 2 usage error.

The CLI opens the scoring MySQL store. It reads `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD` and `MYSQL_DATABASE`. It uses `mysql2` from `scoring/node_modules`, so run `npm install --prefix scoring` first.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `VERIFIER_CMD` | `python -m verifier run --expected out/expected-matrix.json --format json` | Command run from the project root. Exit 0 is the only pass. |
| `IMAGE_DIR` | `<project>/images` | Golden images, read as `IMAGE_DIR/<image_set>`. A missing file gives a stub hash, flagged `stub: true`. |
| `ORCH_ACTOR` | `orchestrator` | Actor name written to `audit_log`. |

## Hypervisor driver

`deploy(target, flag)`, `restore(target)` and `hash(target)`. `MockHypervisor` is the free default. Control traffic must go to an IPv4 address in `172.16.0.0/16`. Anything else is refused with 403 `control_host_refused`, and exercise addresses are never used as control addresses.

## Limits

- No HTTP layer of its own. The admin routes in `scoring/src/admin.js` call this library, and map its error codes and HTTP statuses.
- Reset reads `listTargets` and `listFlags` from the store before it changes anything, and re-injects flags after restoring. A blocked round reset to `verifying` was checked end to end on the memory store (12 targets restored, no hash mismatches).
- The orchestrator accepts a verification run only if it belongs to the round. `latestVerificationRun(roundId)` filters by round in both stores.
- Re-provisioning a single mismatched target is not implemented. Run `reset` again after fixing the cause.
