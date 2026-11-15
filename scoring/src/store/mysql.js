'use strict';

// MySQL 8 store. Expects a mysql2/promise pool created with { timezone: 'Z' } so that
// DATETIME values round-trip as UTC. See scoring/README.md.
// Schema: db/001_init.sql. Method set mirrors memory.js exactly.

const { ROUND_STATUSES, VERDICTS, SCORE_KINDS } = require('../constants');

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const execOn = (runner) => async (sql, params = []) => (await runner.query(sql, params))[0];

async function withTx(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

function roundView(row, teamRows) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    image_set: row.image_set,
    starts_at: iso(row.starts_at),
    ends_at: iso(row.ends_at),
    freeze_minutes: row.freeze_minutes,
    created_at: iso(row.created_at),
    team_ids: teamRows.map((t) => t.team_id),
  };
}

async function getRoundOn(exec, id) {
  const [row] = await exec('SELECT * FROM rounds WHERE id = ?', [Number(id)]);
  if (!row) return null;
  const teams = await exec('SELECT team_id FROM teams_in_round WHERE round_id = ? ORDER BY team_id', [row.id]);
  return roundView(row, teams);
}

async function insertRound(exec, { name, image_set, starts_at, duration_minutes, freeze_minutes = 15, team_ids = [] }) {
  const start = starts_at == null ? null : new Date(starts_at);
  const ends = start && duration_minutes != null ? new Date(start.getTime() + duration_minutes * 60000) : null;
  const res = await exec(
    'INSERT INTO rounds (name, image_set, starts_at, ends_at, freeze_minutes) VALUES (?,?,?,?,?)',
    [name, image_set, start, ends, freeze_minutes],
  );
  if (team_ids.length > 0) {
    await exec('INSERT INTO teams_in_round (round_id, team_id) VALUES ?',
      [team_ids.map((t) => [res.insertId, Number(t)])]);
  }
  return getRoundOn(exec, res.insertId);
}

const teamView = (r) => ({
  id: r.id,
  name: r.name,
  pod_vlan: r.pod_vlan,
  target_vlan: r.target_vlan,
  pod_subnet: r.pod_subnet,
  target_subnet: r.target_subnet,
  created_at: iso(r.created_at),
});

const targetView = (r) => ({
  id: Number(r.id),
  round_id: r.round_id,
  team_id: r.team_id,
  role: r.role,
  ip_address: r.ip_address,
  image_hash: r.image_hash,
  provisioned_at: iso(r.provisioned_at),
});

const flagView = (r) => ({
  id: Number(r.id),
  round_id: r.round_id,
  team_id: r.team_id,
  target_role: r.target_role,
  value: r.value,
  injected_at: iso(r.injected_at),
});

const pollView = (r) => ({
  id: Number(r.id),
  round_id: r.round_id,
  team_id: r.team_id,
  target_role: r.target_role,
  reachable: Boolean(r.reachable),
  latency_ms: r.latency_ms,
  polled_at: iso(r.polled_at),
});

function buildMysqlStore(pool, conn) {
  const exec = execOn(conn || pool);

  const store = {
    // ---- rounds -------------------------------------------------------------
    createRound: (input) => (conn
      ? insertRound(exec, input)
      : withTx(pool, (c) => insertRound(execOn(c), input))),

    getRound: (id) => getRoundOn(exec, id),

    async listRounds() {
      const rows = await exec('SELECT * FROM rounds ORDER BY id');
      const out = [];
      for (const row of rows) out.push(await getRoundOn(exec, row.id));
      return out;
    },

    async setRoundStatus(id, status) {
      if (!ROUND_STATUSES.includes(status)) throw new Error(`invalid round status ${status}`);
      if (!(await getRoundOn(exec, id))) throw new Error(`round ${id} does not exist`);
      await exec('UPDATE rounds SET status = ? WHERE id = ?', [status, Number(id)]);
      return getRoundOn(exec, id);
    },

    async getCurrentRound() {
      let [row] = await exec("SELECT * FROM rounds WHERE status IN ('running','frozen') ORDER BY id DESC LIMIT 1");
      if (!row) [row] = await exec("SELECT * FROM rounds WHERE status <> 'closed' ORDER BY id DESC LIMIT 1");
      if (!row) [row] = await exec('SELECT * FROM rounds ORDER BY id DESC LIMIT 1');
      return row ? getRoundOn(exec, row.id) : null;
    },

    // ---- teams --------------------------------------------------------------
    async upsertTeam({ id, name, pod_vlan, target_vlan, pod_subnet, target_subnet }) {
      await exec(
        `INSERT INTO teams (id, name, pod_vlan, target_vlan, pod_subnet, target_subnet)
         VALUES (?,?,?,?,?,?) AS new
         ON DUPLICATE KEY UPDATE name = new.name, pod_vlan = new.pod_vlan,
           target_vlan = new.target_vlan, pod_subnet = new.pod_subnet, target_subnet = new.target_subnet`,
        [Number(id), name, pod_vlan, target_vlan, pod_subnet, target_subnet],
      );
      return store.getTeam(id);
    },

    async listTeams() {
      return (await exec('SELECT * FROM teams ORDER BY id')).map(teamView);
    },

    async getTeam(id) {
      const [row] = await exec('SELECT * FROM teams WHERE id = ?', [Number(id)]);
      return row ? teamView(row) : null;
    },

    // ---- targets and flags --------------------------------------------------
    // Returns the number of rows inserted.
    async insertTargets(roundId, rows) {
      if (rows.length === 0) return 0;
      const res = await exec(
        'INSERT INTO targets (round_id, team_id, role, ip_address, image_hash) VALUES ?',
        [rows.map((r) => [Number(roundId), Number(r.team_id), r.role, r.ip_address, r.image_hash])],
      );
      return res.affectedRows;
    },

    async listTargets(roundId) {
      return (await exec('SELECT * FROM targets WHERE round_id = ? ORDER BY team_id, role', [Number(roundId)]))
        .map(targetView);
    },

    // Returns the number of rows inserted.
    async insertFlags(roundId, rows) {
      if (rows.length === 0) return 0;
      const now = new Date();
      const res = await exec(
        'INSERT INTO flags (round_id, team_id, target_role, value, injected_at) VALUES ?',
        [rows.map((r) => [Number(roundId), Number(r.team_id), r.target_role,
          String(r.value).toLowerCase(), now])],
      );
      return res.affectedRows;
    },

    async listFlags(roundId) {
      return (await exec('SELECT * FROM flags WHERE round_id = ? ORDER BY id', [Number(roundId)]))
        .map(flagView);
    },

    async findFlag(roundId, value) {
      const [row] = await exec('SELECT * FROM flags WHERE round_id = ? AND value = ?',
        [Number(roundId), String(value).toLowerCase()]);
      return row ? flagView(row) : null;
    },

    // ---- submissions --------------------------------------------------------
    async insertSubmission({ round_id, submitter_team, value, verdict, flag_id = null, submitted_at, source_ip }) {
      if (!VERDICTS.includes(verdict)) throw new Error(`invalid verdict ${verdict}`);
      const at = new Date(submitted_at);
      const v = String(value).toLowerCase();
      const res = await exec(
        `INSERT INTO submissions (round_id, submitter_team, value, verdict, flag_id, submitted_at, source_ip)
         VALUES (?,?,?,?,?,?,?)`,
        [Number(round_id), Number(submitter_team), v, verdict, flag_id, at, source_ip],
      );
      return {
        id: Number(res.insertId), round_id: Number(round_id), submitter_team: Number(submitter_team),
        value: v, verdict, flag_id, submitted_at: iso(at), source_ip,
      };
    },

    async countRecentSubmissions(teamId, sinceMs) {
      const [row] = await exec(
        `SELECT COUNT(*) AS n FROM submissions
         WHERE submitter_team = ? AND verdict <> 'rate_limited' AND submitted_at >= ?`,
        [Number(teamId), new Date(sinceMs)],
      );
      return Number(row.n);
    },

    async hasAcceptedSubmission(roundId, teamId, flagId) {
      const rows = await exec(
        `SELECT 1 FROM submissions WHERE round_id = ? AND submitter_team = ? AND flag_id = ?
         AND verdict = 'accepted' LIMIT 1`,
        [Number(roundId), Number(teamId), flagId],
      );
      return rows.length > 0;
    },

    async acceptedCountForFlag(flagId) {
      const [row] = await exec("SELECT COUNT(*) AS n FROM submissions WHERE flag_id = ? AND verdict = 'accepted'",
        [flagId]);
      return Number(row.n);
    },

    // ---- scoring ledger (append-only: INSERT and SELECT only) ---------------
    async appendScoreEvent({ round_id, team_id, kind, points, ref_id = null, note = null, occurred_at }) {
      if (!SCORE_KINDS.includes(kind)) throw new Error(`invalid score kind ${kind}`);
      if (note != null && String(note).length > 255) throw new Error('note exceeds 255 characters');
      const at = new Date(occurred_at || Date.now());
      const cents = Math.round(Number(points) * 100) / 100;
      const res = await exec(
        `INSERT INTO score_events (round_id, team_id, kind, points, ref_id, note, occurred_at)
         VALUES (?,?,?,?,?,?,?)`,
        [Number(round_id), Number(team_id), kind, cents, ref_id, note, at],
      );
      return {
        seq: Number(res.insertId), round_id: Number(round_id), team_id: Number(team_id), kind,
        points: cents, ref_id, note, occurred_at: iso(at),
      };
    },

    async listTimeline(roundId, sinceSeq = 0, limit = 500) {
      const rows = await exec(
        'SELECT * FROM score_events WHERE round_id = ? AND seq > ? ORDER BY seq LIMIT ?',
        [Number(roundId), Number(sinceSeq), Number(limit)],
      );
      return rows.map((r) => ({
        seq: Number(r.seq), round_id: r.round_id, team_id: r.team_id, kind: r.kind,
        points: Number(r.points), ref_id: r.ref_id, note: r.note, occurred_at: iso(r.occurred_at),
      }));
    },

    // Score = SUM(points) at read time. Participants come from teams_in_round.
    // Tie-break: earlier last event first; teams with no events sort last.
    async leaderboard(roundId) {
      const rows = await exec(
        `SELECT t.id AS team_id, t.name, COALESCE(SUM(se.points), 0) AS score,
                MAX(se.occurred_at) AS last_event
         FROM teams_in_round tir
         JOIN teams t ON t.id = tir.team_id
         LEFT JOIN score_events se ON se.team_id = t.id AND se.round_id = tir.round_id
         WHERE tir.round_id = ?
         GROUP BY t.id, t.name
         ORDER BY score DESC, (last_event IS NULL) ASC, last_event ASC, t.id ASC`,
        [Number(roundId)],
      );
      return rows.map((r) => ({
        team_id: r.team_id,
        name: r.name,
        score: Math.round(Number(r.score) * 100) / 100,
        last_event: iso(r.last_event),
      }));
    },

    // ---- service polls ------------------------------------------------------
    async recordPoll({ round_id, team_id, target_role, reachable, latency_ms = null, polled_at }) {
      const at = new Date(polled_at || Date.now());
      const res = await exec(
        `INSERT INTO service_polls (round_id, team_id, target_role, reachable, latency_ms, polled_at)
         VALUES (?,?,?,?,?,?)`,
        [Number(round_id), Number(team_id), target_role, Boolean(reachable), latency_ms, at],
      );
      return pollView({
        id: res.insertId, round_id: Number(round_id), team_id: Number(team_id), target_role,
        reachable, latency_ms, polled_at: at,
      });
    },

    async latestPolls(roundId) {
      return (await exec(
        `SELECT p.* FROM service_polls p
         JOIN (SELECT team_id, target_role, MAX(id) AS max_id FROM service_polls
               WHERE round_id = ? GROUP BY team_id, target_role) m ON m.max_id = p.id`,
        [Number(roundId)],
      )).map(pollView);
    },

    // ---- verification -------------------------------------------------------
    async insertVerificationRun({ round_id = null, passed, pairs_tested, violations, matrix_json, report_path = null, ran_at }) {
      const at = new Date(ran_at);
      const res = await exec(
        `INSERT INTO verification_runs (round_id, passed, pairs_tested, violations, matrix_json, report_path, ran_at)
         VALUES (?,?,?,?,?,?,?)`,
        [round_id == null ? null : Number(round_id), Boolean(passed), pairs_tested, violations,
          JSON.stringify(matrix_json), report_path, at],
      );
      return {
        id: Number(res.insertId), round_id, passed: Boolean(passed), pairs_tested, violations,
        matrix_json, report_path, ran_at: iso(at),
      };
    },

    async latestVerificationRun(roundId) {
      const [r] = roundId === undefined
        ? await exec('SELECT * FROM verification_runs ORDER BY ran_at DESC, id DESC LIMIT 1')
        : await exec('SELECT * FROM verification_runs WHERE round_id = ? ORDER BY ran_at DESC, id DESC LIMIT 1',
          [Number(roundId)]);
      if (!r) return null;
      return {
        id: Number(r.id), round_id: r.round_id, passed: Boolean(r.passed), pairs_tested: r.pairs_tested,
        violations: r.violations,
        matrix_json: typeof r.matrix_json === 'string' ? JSON.parse(r.matrix_json) : r.matrix_json,
        report_path: r.report_path, ran_at: iso(r.ran_at),
      };
    },

    // ---- audit (append-only: INSERT and SELECT only) ------------------------
    async appendAudit({ actor, action, subject = null, detail = null }) {
      const at = new Date();
      const res = await exec(
        'INSERT INTO audit_log (actor, action, subject, detail, occurred_at) VALUES (?,?,?,?,?)',
        [actor, action, subject, detail == null ? null : JSON.stringify(detail), at],
      );
      return { id: Number(res.insertId), actor, action, subject, detail, occurred_at: iso(at) };
    },

    async listAudit(limit = 500) {
      const rows = await exec('SELECT * FROM audit_log ORDER BY id LIMIT ?', [Number(limit)]);
      return rows.map((r) => ({
        id: Number(r.id),
        actor: r.actor,
        action: r.action,
        subject: r.subject,
        detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail,
        occurred_at: iso(r.occurred_at),
      }));
    },

    // ---- transactions -------------------------------------------------------
    transaction(fn) {
      if (conn) return fn(store);
      return withTx(pool, (c) => fn(buildMysqlStore(pool, c)));
    },
  };

  return store;
}

// `pool` is a mysql2/promise pool created with { timezone: 'Z' }.
function createMysqlStore(pool) {
  return buildMysqlStore(pool, null);
}

module.exports = { createMysqlStore };
