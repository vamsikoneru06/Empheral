# API Specification

Base: `http://10.10.30.10:8080/api`
Auth: bearer token. Four roles — `public`, `competitor`, `judge`, `admin`.
All responses JSON. All timestamps RFC 3339 UTC.

**Binding constraint:** this API is not routable from any exercise VLAN. Competitor requests
arrive through the dashboard on the judging boundary, never directly to scoring.

---

## Public

### `GET /leaderboard?round_id=`
Cached 2 s.

```json
{
  "round_id": 3,
  "frozen": false,
  "as_of": "2026-11-02T09:41:12Z",
  "teams": [
    { "rank": 1, "team_id": 2, "name": "Team 2", "score": 420.0,
      "services_up": 5, "services_total": 5 }
  ]
}
```

### `GET /rounds/current`

```json
{
  "id": 3, "name": "Round 3 - Lateral", "status": "running",
  "starts_at": "2026-11-02T09:00:00Z", "ends_at": "2026-11-02T12:00:00Z",
  "freeze_at": "2026-11-02T11:45:00Z", "server_time": "2026-11-02T09:41:12Z"
}
```

---

## Competitor

### `GET /teams/:id`
403 unless `:id` is the caller's own team.

```json
{
  "team_id": 1, "name": "Team 1", "score": 310.0,
  "pod_subnet": "10.20.1.0/26", "target_subnet": "10.40.1.0/26",
  "targets": [
    { "role": "web", "ip": "10.40.1.10", "status": "up" },
    { "role": "db",  "ip": "10.40.1.20", "status": "down" }
  ]
}
```

### `POST /submissions`
Rate limit: 10/min per team. Returns 429 beyond.

```json
{ "value": "a3f1...64hex" }
```

| Verdict | HTTP | Meaning |
|---------|------|---------|
| `accepted` | 200 | Valid, first time, not own flag |
| `wrong` | 200 | No such flag this round |
| `duplicate` | 200 | Already submitted by this team |
| `self_submit` | 200 | Flag planted on the submitting team |
| `expired` | 200 | Round frozen or closed |
| `rate_limited` | 429 | Over the limit |

```json
{ "verdict": "accepted", "points": 50.0, "first_blood": true,
  "new_score": 360.0 }
```

---

## Judge

### `GET /judge/timeline?round_id=&since_seq=`
Scoring ledger in sequence order; pages with `since_seq`.

```json
{
  "round_id": 3, "next_seq": 1841,
  "events": [
    { "seq": 1839, "team_id": 2, "kind": "flag_capture",
      "points": 50.0, "occurred_at": "2026-11-02T09:38:04.221Z" }
  ]
}
```

### `POST /judge/adjust`
Writes a `score_events` row and an `audit_log` row in one transaction.

```json
{ "round_id": 3, "team_id": 4, "points": -25.0,
  "note": "Out-of-scope attack on judging segment" }
```

---

## Admin

### `POST /rounds`
```json
{ "name": "Round 4", "image_set": "golden-v3",
  "starts_at": "2026-11-03T09:00:00Z", "duration_minutes": 180,
  "team_ids": [1,2,3,4] }
```
Returns the round in `planned`. Provisioning is triggered separately.

### `POST /rounds/:id/provision`
Async. Returns `202` with a job id. Orchestrator provisions targets, injects flags, hashes
images. Round moves `provisioning → verifying`.

### `POST /rounds/:id/reset`
Restores every target to golden baseline over the management plane. Verifies by hash.
Refuses with `409` if the round is `running`.

### `GET /verification/latest`

```json
{
  "id": 88, "round_id": 3, "passed": true,
  "pairs_tested": 1640, "violations": 0,
  "ran_at": "2026-11-02T08:52:00Z",
  "assertions": {
    "team_to_team_denied": true,
    "target_to_scoring_denied": true,
    "scoring_to_target_permitted": true,
    "exercise_to_institutional_denied": true,
    "mgmt_plane_unreachable": true
  }
}
```

### `POST /verification/run`
Triggers a verifier run. Returns `202` + job id. A round cannot reach `ready` without a pass.

---

## Errors

```json
{ "error": { "code": "round_not_running",
             "message": "Submissions are closed for this round." } }
```

| Code | HTTP |
|------|------|
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `round_not_running` | 409 |
| `verification_required` | 409 |
| `rate_limited` | 429 |
