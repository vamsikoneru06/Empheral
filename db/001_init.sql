-- CyberRange-Net control plane schema, MySQL 8.
-- Source: data-model.md. The only addition is teams_in_round (marked ADDED):
-- the ER diagram in data-model.md names it but the DDL omitted it, and
-- createRound() needs somewhere to record the participating teams.
--
-- Run as a privileged user (for example root) against a fresh server.

CREATE DATABASE IF NOT EXISTS cyberrange CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE cyberrange;

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

-- ADDED (see header): round participation.
CREATE TABLE teams_in_round (
  round_id INT NOT NULL,
  team_id  INT NOT NULL,
  PRIMARY KEY (round_id, team_id),
  FOREIGN KEY (round_id) REFERENCES rounds(id),
  FOREIGN KEY (team_id)  REFERENCES teams(id)
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

-- ---------------------------------------------------------------------------
-- Application user (placeholder name and password; change before use).
-- ---------------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'cyberrange_app'@'%' IDENTIFIED BY 'CHANGE_ME_BEFORE_USE';

-- Database-level grant: SELECT and INSERT only. Nothing here allows UPDATE or DELETE.
-- Keep UPDATE/DELETE OFF database-level grants: a table-level REVOKE cannot remove
-- a database-level privilege.
GRANT SELECT, INSERT ON cyberrange.* TO 'cyberrange_app'@'%';

-- Mutable tables: round status changes and team upserts.
GRANT UPDATE ON cyberrange.rounds TO 'cyberrange_app'@'%';
GRANT UPDATE ON cyberrange.teams  TO 'cyberrange_app'@'%';

-- Append-only ledgers. MySQL only lets REVOKE remove a privilege that exists at the
-- same level, so the full set is granted at table level first, then UPDATE and DELETE
-- are revoked. Final state: SELECT and INSERT only.
GRANT SELECT, INSERT, UPDATE, DELETE ON cyberrange.score_events TO 'cyberrange_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON cyberrange.audit_log    TO 'cyberrange_app'@'%';
REVOKE UPDATE, DELETE ON cyberrange.score_events FROM 'cyberrange_app'@'%';
REVOKE UPDATE, DELETE ON cyberrange.audit_log    FROM 'cyberrange_app'@'%';
