# Scoring engine

Node 20+, CommonJS. Runtime dependencies: `express` and `mysql2`. Tests use `node:test`.

## Run

```bash
npm install --prefix scoring
npm test --prefix scoring                 # unit and API tests; MySQL test skipped unless MYSQL_URL is set
MYSQL_URL=mysql://user:pass@127.0.0.1:3306/cyberrange npm test --prefix scoring   # adds the MySQL scenario
```

Schema: `db/001_init.sql` (apply as a privileged user; then set the real password for `cyberrange_app`).

Start:

| Env | Default | Meaning |
|-----|---------|---------|
| `SCORING_BIND` | `127.0.0.1` | Listen address. **In deployment, set this to the scoring VLAN address (10.10.30.10) only.** Never bind to an exercise-facing or management interface. |
| `PORT` | `8080` | Listen port |
| `TOKENS_FILE` | unset | JSON `{ "<token>": {"role": "competitor", "team_id": 1} }`; roles `competitor`, `judge`, `admin` |
| `MYSQL_URL` | unset | Durable store. Unset means the in-memory store, which loses events on restart. |
| `POLLER_ENABLED` | `true` | `false` turns off the beacon poller |
| `POLL_INTERVAL_MS` | `30000` | Beacon poll interval |
| `BEACON_PORT` | `8080` | TCP port probed on each `10.40.N.60` beacon (assumption: the docs give no port) |

```bash
TOKENS_FILE=/etc/cyberrange/tokens.json SCORING_BIND=10.10.30.10 MYSQL_URL=... node scoring/src/server.js
```

The poller is outbound only. It opens TCP connections to beacons and binds no listener.

## Scoring values (`src/rules.js`)

| Event | Points |
|-------|--------|
| `flag_capture` (accepted flag) | +50 |
| `first_blood` (first accepted capture of that flag, on top of the capture) | +25 |
| `service_uptime` (each reachable beacon poll) | +1 |
| `manual_adjust` (judge) | any non-zero amount, 2 decimals, note required |

Submission limit: 10 per team per 60 s. Rate-limited attempts are recorded but do not count toward the limit.
Defence and penalty kinds exist in the ledger but nothing awards them automatically.
These are placeholder weights (PRD Q2 is open with faculty).

## Verdicts

Checked in this order: no current round (409 `round_not_running`); rate limit (429); round not running or frozen (`expired`); unknown value (`wrong`); own flag (`self_submit`); already accepted by this team (`duplicate`); otherwise `accepted`. Every attempt that reaches a round is written to `submissions`.

Accepted responses: `{verdict, points, bonus_points, first_blood, new_score}`. `points` is the flag capture only. `bonus_points` is the first-blood bonus.

Freeze: the round is frozen `freeze_minutes` before `ends_at`. The stored status is not rewritten; the effective status is computed when read.

## Deviations and decisions

- **`teams_in_round` added** to `db/001_init.sql`. The ER diagram names it, the DDL omits it, and `createRound` needs it.
- **Ledger `seq`:** the memory store is monotonic and gapless per round, as the data model says. MySQL uses `AUTO_INCREMENT`, so it is monotonic across rounds and can have gaps (rollbacks, bulk inserts). Paging with `since_seq` works in both.
- **Leaderboard in MySQL** is limited to teams in `teams_in_round` (the data-model query used all teams). Ties sort teams with no events last; a plain `ORDER BY last_event ASC` would put NULLs first in MySQL.
- **Services** on the leaderboard and team view are the beacon only, so `services_total` is 0 or 1 per team. The api-spec example shows five services; only the beacon is polled today.
- **Team view target status** is `up`/`down` for the beacon (from its poll) and `unknown` for other roles, which are not polled.
- **Admin routes** (`POST /api/rounds`, `POST /api/rounds/:id/provision`, `POST /api/rounds/:id/reset`, `POST /api/verification/run`) are in `src/admin.js`. They wrap the orchestrator and are mounted only when `server.js` wires one in. Provision and verification run to completion before the 202 is sent; there is no job queue.
- **Extra error code** `bad_request` (400) for malformed input. It is not in api-spec.
- **Extra role rule:** admin may call judge routes. Public may not call judge or admin routes.
- **`source_ip`** is the socket peer address. Behind a proxy it will be the proxy address; there is no trust-proxy setting.
- **Extra read methods** on the store beyond the contract: `listTargets`, `listFlags`, `latestPolls`, `hasAcceptedSubmission`, `acceptedCountForFlag`, `listAudit`. None of them is an update or delete.
- **`latestVerificationRun(roundId?)`** filters by round when given; with no argument it returns the latest run overall.

## Concurrency

Submissions are serialised in-process, so the duplicate and first-blood checks cannot race. This assumes one scoring process. A second process would need a database-level guard, such as a unique key on `(round_id, submitter_team, flag_id)` for accepted rows.

## Tests

- `verdicts.test.js`: verdict table, freeze, duplicates, self-submit, first blood, recording.
- `api.test.js`: auth 401/403, rate limit 429 on the 11th submission, leaderboard and cache, team scoping, timeline paging, adjust (one score row and one audit row), verification latest.
- `store.test.js`: no update or delete methods on either store, no UPDATE/DELETE against ledger tables in source, migration REVOKEs present, SUM and tie order, seq, rollback.
- `poller.test.js`: poll rows and uptime events, probe errors, no listener in the poller, bind default.
- `mysql.integration.test.js`: runs only with `MYSQL_URL`; uses a scratch database and drops it afterwards.

## Verification

- The MySQL store passes its scenario against a real MySQL 8.4.9 server (`MYSQL_URL` set; the test creates and drops a scratch database).
- The append-only grants were checked on the same server: the app user (`cyberrange_app`) gets `ER_TABLEACCESS_DENIED_ERROR` on UPDATE and DELETE for `score_events` and `audit_log`.
- Not run: any MySQL version other than 8.4.9, and a production deployment against the scoring VLAN.
