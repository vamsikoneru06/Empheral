# Data Model

MySQL 8. All timestamps UTC. Append-only tables never receive UPDATE or DELETE.

## Entity relationships

```
  rounds 1---* teams_in_round *---1 teams
    |                                 |
    |                                 +---* targets
    |                                 |
    +---* flags                       +---* score_events
    |        |
    |        +---* submissions
    |
    +---* verification_runs
    |
    +---* service_polls
```

## Schema

```sql
CREATE TABLE teams (
  id            INT PRIMARY KEY,                 -- team number N (1..16)
  name          VARCHAR(64)  NOT NULL,
  pod_vlan      SMALLINT     NOT NULL,           -- 100 + N
  target_vlan   SMALLINT     NOT NULL,           -- 200 + N
  pod_subnet    VARCHAR(18)  NOT NULL,           -- 10.20.N.0/26
  target_subnet VARCHAR(18)  NOT NULL,           -- 10.40.N.0/26
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (pod_vlan), UNIQUE KEY (target_vlan)
);

CREATE TABLE rounds (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(128) NOT NULL,
  status         ENUM('planned','provisioning','verifying','blocked',
                      'ready','running','frozen','closed') NOT NULL DEFAULT 'planned',
  image_set      VARCHAR(64)  NOT NULL,
  starts_at      DATETIME     NULL,
  ends_at        DATETIME     NULL,
  freeze_minutes SMALLINT     NOT NULL DEFAULT 15,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE targets (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  round_id    INT NOT NULL,
  team_id     INT NOT NULL,
  role        ENUM('web','db','workstation','dc','fileserver','beacon') NOT NULL,
  ip_address  VARCHAR(15) NOT NULL,              -- 10.40.N.{10,20,30,40,50,60}
  image_hash  CHAR(64)    NOT NULL,              -- sha256 of golden image
  provisioned_at DATETIME NULL,
  FOREIGN KEY (round_id) REFERENCES rounds(id),
  FOREIGN KEY (team_id)  REFERENCES teams(id),
  UNIQUE KEY (round_id, team_id, role)
);

CREATE TABLE flags (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  round_id    INT NOT NULL,
  team_id     INT NOT NULL,                      -- the team this flag is PLANTED on
  target_role ENUM('web','db','workstation','dc','fileserver') NOT NULL,
  value       CHAR(64) NOT NULL,                 -- unique per round per team
  injected_at DATETIME NOT NULL,
  FOREIGN KEY (round_id) REFERENCES rounds(id),
  UNIQUE KEY (value),
  UNIQUE KEY (round_id, team_id, target_role)
);

CREATE TABLE submissions (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  round_id       INT NOT NULL,
  submitter_team INT NOT NULL,
  value          CHAR(64) NOT NULL,
  verdict        ENUM('accepted','wrong','duplicate','self_submit',
                      'expired','rate_limited') NOT NULL,
  flag_id        BIGINT NULL,                    -- set when accepted
  submitted_at   DATETIME(3) NOT NULL,
  source_ip      VARCHAR(15) NOT NULL,
  FOREIGN KEY (round_id)       REFERENCES rounds(id),
  FOREIGN KEY (submitter_team) REFERENCES teams(id),
  KEY (round_id, submitter_team, submitted_at)
);

-- append-only ledger; never UPDATE or DELETE
CREATE TABLE score_events (
  seq         BIGINT AUTO_INCREMENT PRIMARY KEY, -- monotonic, gapless per round
  round_id    INT NOT NULL,
  team_id     INT NOT NULL,
  kind        ENUM('flag_capture','first_blood','service_uptime',
                   'defence','penalty','manual_adjust') NOT NULL,
  points      DECIMAL(8,2) NOT NULL,
  ref_id      BIGINT NULL,                       -- submission.id or poll.id
  note        VARCHAR(255) NULL,
  occurred_at DATETIME(3) NOT NULL,
  FOREIGN KEY (round_id) REFERENCES rounds(id),
  FOREIGN KEY (team_id)  REFERENCES teams(id),
  KEY (round_id, team_id, seq)
);

CREATE TABLE service_polls (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  round_id    INT NOT NULL,
  team_id     INT NOT NULL,
  target_role VARCHAR(16) NOT NULL,
  reachable   BOOLEAN NOT NULL,
  latency_ms  INT NULL,
  polled_at   DATETIME(3) NOT NULL,
  FOREIGN KEY (round_id) REFERENCES rounds(id),
  KEY (round_id, team_id, polled_at)
);

CREATE TABLE verification_runs (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  round_id      INT NULL,                        -- NULL for ad-hoc runs
  passed        BOOLEAN NOT NULL,
  pairs_tested  INT NOT NULL,
  violations    INT NOT NULL,
  matrix_json   JSON NOT NULL,
  report_path   VARCHAR(255) NULL,
  ran_at        DATETIME NOT NULL,
  KEY (round_id, ran_at)
);

-- append-only
CREATE TABLE audit_log (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor      VARCHAR(64) NOT NULL,
  action     VARCHAR(64) NOT NULL,
  subject    VARCHAR(128) NULL,
  detail     JSON NULL,
  occurred_at DATETIME(3) NOT NULL,
  KEY (occurred_at)
);
```

## Invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I1 | A team never scores on its own flag | `submissions.verdict = 'self_submit'` check |
| I2 | A flag value is globally unique | `UNIQUE KEY (value)` |
| I3 | `score_events` is append-only | No UPDATE/DELETE grant on the app DB user |
| I4 | Every team has the same target roles in a round | `UNIQUE (round_id, team_id, role)` + count assertion |
| I5 | Leaderboard = `SUM(points)` per team; never a stored total | Computed view, not a column |
| I6 | A manual adjustment always has an audit row | Transaction writes both or neither |

## Leaderboard query

```sql
SELECT t.id, t.name,
       COALESCE(SUM(se.points), 0) AS score,
       MAX(se.occurred_at)         AS last_event
FROM teams t
LEFT JOIN score_events se
       ON se.team_id = t.id AND se.round_id = ?
GROUP BY t.id, t.name
ORDER BY score DESC, last_event ASC;   -- earlier last event wins a tie
```
