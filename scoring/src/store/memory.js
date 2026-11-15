'use strict';

// In-memory store. Used by tests and by local development only: nothing survives a restart.
// Implements the same method set as mysql.js. Append-only tables (score_events, audit_log)
// expose append and read methods only.

const { ROUND_STATUSES, TARGET_ROLES, FLAG_ROLES, VERDICTS, SCORE_KINDS } = require('../constants');

function emptyState() {
  return {
    teams: new Map(),          // id -> team
    rounds: [],                // ascending id
    roundTeams: new Map(),     // roundId -> Set<teamId>
    targets: [],
    flags: [],
    submissions: [],
    scoreEvents: [],           // append-only
    seqByRound: new Map(),     // roundId -> last seq issued in that round
    servicePolls: [],
    verificationRuns: [],
    auditLog: [],              // append-only
    nextId: { round: 1, target: 1, flag: 1, submission: 1, poll: 1, run: 1, audit: 1 },
  };
}

const cents = (n) => Math.round(n * 100) / 100;
const toIso = (v) => (v == null ? null : new Date(v).toISOString());
const copy = (v) => structuredClone(v);

function createMemoryStore({ clock = Date.now } = {}) {
  let state = emptyState();
  let txChain = Promise.resolve();
  const nowDate = () => new Date(clock());

  const findRound = (id) => state.rounds.find((r) => r.id === Number(id)) || null;

  const roundView = (r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    image_set: r.image_set,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    freeze_minutes: r.freeze_minutes,
    created_at: r.created_at,
    team_ids: [...(state.roundTeams.get(r.id) || [])].sort((a, b) => a - b),
  });

  const requireRound = (roundId) => {
    const r = findRound(roundId);
    if (!r) throw new Error(`round ${roundId} does not exist`);
    return r;
  };

  const store = {
    // ---- rounds -------------------------------------------------------------
    createRound({ name, image_set, starts_at, duration_minutes, freeze_minutes = 15, team_ids = [] }) {
      const start = starts_at == null ? null : new Date(starts_at);
      if (start && Number.isNaN(start.getTime())) throw new Error('starts_at is not a valid date');
      const ends = start && duration_minutes != null
        ? new Date(start.getTime() + duration_minutes * 60000)
        : null;
      for (const t of team_ids) {
        if (!state.teams.has(Number(t))) throw new Error(`team ${t} does not exist`);
      }
      const row = {
        id: state.nextId.round++,
        name,
        status: 'planned',
        image_set,
        starts_at: toIso(start),
        ends_at: toIso(ends),
        freeze_minutes,
        created_at: toIso(nowDate()),
      };
      state.rounds.push(row);
      state.roundTeams.set(row.id, new Set(team_ids.map(Number)));
      return roundView(row);
    },

    getRound(id) {
      const r = findRound(id);
      return r ? roundView(r) : null;
    },

    listRounds() {
      return state.rounds.map(roundView);
    },

    setRoundStatus(id, status) {
      if (!ROUND_STATUSES.includes(status)) throw new Error(`invalid round status ${status}`);
      const r = requireRound(id);
      r.status = status;
      return roundView(r);
    },

    getCurrentRound() {
      const latest = (pred) => state.rounds.filter(pred).sort((a, b) => b.id - a.id)[0];
      const r = latest((x) => x.status === 'running' || x.status === 'frozen')
        || latest((x) => x.status !== 'closed')
        || latest(() => true);
      return r ? roundView(r) : null;
    },

    // ---- teams --------------------------------------------------------------
    upsertTeam({ id, name, pod_vlan, target_vlan, pod_subnet, target_subnet }) {
      const prev = state.teams.get(Number(id));
      const row = {
        id: Number(id), name, pod_vlan, target_vlan, pod_subnet, target_subnet,
        created_at: prev ? prev.created_at : toIso(nowDate()),
      };
      state.teams.set(row.id, row);
      return copy(row);
    },

    listTeams() {
      return [...state.teams.values()].sort((a, b) => a.id - b.id).map(copy);
    },

    getTeam(id) {
      const t = state.teams.get(Number(id));
      return t ? copy(t) : null;
    },

    // ---- targets and flags --------------------------------------------------
    insertTargets(roundId, rows) {
      requireRound(roundId);
      for (const row of rows) {
        if (!TARGET_ROLES.includes(row.role)) throw new Error(`invalid target role ${row.role}`);
        const dup = state.targets.some((t) => t.round_id === Number(roundId)
          && t.team_id === Number(row.team_id) && t.role === row.role);
        if (dup) throw new Error(`duplicate target ${row.team_id}/${row.role} in round ${roundId}`);
        state.targets.push({
          id: state.nextId.target++,
          round_id: Number(roundId),
          team_id: Number(row.team_id),
          role: row.role,
          ip_address: row.ip_address,
          image_hash: row.image_hash,
          provisioned_at: null,
        });
      }
      return rows.length;
    },

    listTargets(roundId) {
      return state.targets
        .filter((t) => t.round_id === Number(roundId))
        .sort((a, b) => a.team_id - b.team_id || a.role.localeCompare(b.role))
        .map(copy);
    },

    insertFlags(roundId, rows) {
      requireRound(roundId);
      for (const row of rows) {
        if (!FLAG_ROLES.includes(row.target_role)) throw new Error(`invalid flag role ${row.target_role}`);
        const value = String(row.value).toLowerCase();
        if (state.flags.some((f) => f.value === value)) throw new Error('flag value already exists');
        const dup = state.flags.some((f) => f.round_id === Number(roundId)
          && f.team_id === Number(row.team_id) && f.target_role === row.target_role);
        if (dup) throw new Error(`duplicate flag ${row.team_id}/${row.target_role} in round ${roundId}`);
        state.flags.push({
          id: state.nextId.flag++,
          round_id: Number(roundId),
          team_id: Number(row.team_id),
          target_role: row.target_role,
          value,
          injected_at: toIso(nowDate()),
        });
      }
      return rows.length;
    },

    listFlags(roundId) {
      return state.flags
        .filter((f) => f.round_id === Number(roundId))
        .sort((a, b) => a.id - b.id)
        .map(copy);
    },

    findFlag(roundId, value) {
      const v = String(value).toLowerCase();
      const f = state.flags.find((x) => x.round_id === Number(roundId) && x.value === v);
      return f ? copy(f) : null;
    },

    // ---- submissions --------------------------------------------------------
    insertSubmission({ round_id, submitter_team, value, verdict, flag_id = null, submitted_at, source_ip }) {
      if (!VERDICTS.includes(verdict)) throw new Error(`invalid verdict ${verdict}`);
      const row = {
        id: state.nextId.submission++,
        round_id: Number(round_id),
        submitter_team: Number(submitter_team),
        value: String(value).toLowerCase(),
        verdict,
        flag_id,
        submitted_at: toIso(submitted_at),
        source_ip,
      };
      state.submissions.push(row);
      return copy(row);
    },

    // Counts attempts in the window, excluding rate-limited ones, so a team that keeps
    // hammering is not locked out longer than the window itself.
    countRecentSubmissions(teamId, sinceMs) {
      return state.submissions.filter((s) => s.submitter_team === Number(teamId)
        && s.verdict !== 'rate_limited'
        && Date.parse(s.submitted_at) >= sinceMs).length;
    },

    hasAcceptedSubmission(roundId, teamId, flagId) {
      return state.submissions.some((s) => s.round_id === Number(roundId)
        && s.submitter_team === Number(teamId)
        && s.flag_id === flagId
        && s.verdict === 'accepted');
    },

    acceptedCountForFlag(flagId) {
      return state.submissions.filter((s) => s.flag_id === flagId && s.verdict === 'accepted').length;
    },

    // ---- scoring ledger (append-only) ---------------------------------------
    appendScoreEvent({ round_id, team_id, kind, points, ref_id = null, note = null, occurred_at }) {
      requireRound(round_id);
      if (!state.teams.has(Number(team_id))) throw new Error(`team ${team_id} does not exist`);
      if (!SCORE_KINDS.includes(kind)) throw new Error(`invalid score kind ${kind}`);
      if (note != null && String(note).length > 255) throw new Error('note exceeds 255 characters');
      const rid = Number(round_id);
      const seq = (state.seqByRound.get(rid) || 0) + 1;
      state.seqByRound.set(rid, seq);
      const row = {
        seq,
        round_id: rid,
        team_id: Number(team_id),
        kind,
        points: cents(Number(points)),
        ref_id,
        note,
        occurred_at: toIso(occurred_at || nowDate()),
      };
      state.scoreEvents.push(row);
      return copy(row);
    },

    listTimeline(roundId, sinceSeq = 0, limit = 500) {
      return state.scoreEvents
        .filter((e) => e.round_id === Number(roundId) && e.seq > sinceSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map(copy);
    },

    leaderboard(roundId) {
      const rid = Number(roundId);
      const rows = [...(state.roundTeams.get(rid) || [])].map((teamId) => {
        const events = state.scoreEvents.filter((e) => e.round_id === rid && e.team_id === teamId);
        const score = cents(events.reduce((sum, e) => sum + e.points, 0));
        const last = events.reduce((max, e) => (max === null || e.occurred_at > max ? e.occurred_at : max), null);
        return {
          team_id: teamId,
          name: state.teams.has(teamId) ? state.teams.get(teamId).name : null,
          score,
          last_event: last,
        };
      });
      // Score descending; earlier last event wins a tie; teams with no events sort last.
      rows.sort((a, b) => (b.score - a.score)
        || ((a.last_event === null) - (b.last_event === null))
        || ((a.last_event || '') < (b.last_event || '') ? -1 : (a.last_event || '') > (b.last_event || '') ? 1 : 0)
        || a.team_id - b.team_id);
      return rows;
    },

    // ---- service polls ------------------------------------------------------
    recordPoll({ round_id, team_id, target_role, reachable, latency_ms = null, polled_at }) {
      const row = {
        id: state.nextId.poll++,
        round_id: Number(round_id),
        team_id: Number(team_id),
        target_role,
        reachable: Boolean(reachable),
        latency_ms,
        polled_at: toIso(polled_at || nowDate()),
      };
      state.servicePolls.push(row);
      return copy(row);
    },

    latestPolls(roundId) {
      const latest = new Map();
      for (const p of state.servicePolls) {
        if (p.round_id !== Number(roundId)) continue;
        latest.set(`${p.team_id}/${p.target_role}`, p); // rows are in insertion order
      }
      return [...latest.values()].map(copy);
    },

    // ---- verification -------------------------------------------------------
    insertVerificationRun({ round_id = null, passed, pairs_tested, violations, matrix_json, report_path = null, ran_at }) {
      const row = {
        id: state.nextId.run++,
        round_id: round_id == null ? null : Number(round_id),
        passed: Boolean(passed),
        pairs_tested,
        violations,
        matrix_json: copy(matrix_json),
        report_path,
        ran_at: toIso(ran_at),
      };
      state.verificationRuns.push(row);
      return copy(row);
    },

    latestVerificationRun(roundId) {
      const runs = state.verificationRuns
        .filter((r) => roundId === undefined || r.round_id === Number(roundId))
        .sort((a, b) => (Date.parse(b.ran_at) - Date.parse(a.ran_at)) || (b.id - a.id));
      return runs.length ? copy(runs[0]) : null;
    },

    // ---- audit (append-only) ------------------------------------------------
    appendAudit({ actor, action, subject = null, detail = null }) {
      const row = {
        id: state.nextId.audit++,
        actor,
        action,
        subject,
        detail: detail == null ? null : copy(detail),
        occurred_at: toIso(nowDate()),
      };
      state.auditLog.push(row);
      return copy(row);
    },

    listAudit(limit = 500) {
      return state.auditLog.slice(0, limit).map(copy);
    },

    // ---- transactions -------------------------------------------------------
    // Runs fn(store) with all writes rolled back if fn throws. Transactions run one at a
    // time. Writes made outside a transaction are not rolled back by a concurrent failure.
    transaction(fn) {
      const run = txChain.then(async () => {
        const snapshot = copy(state);
        try {
          return await fn(store);
        } catch (err) {
          state = snapshot;
          throw err;
        }
      });
      txChain = run.catch(() => {});
      return run;
    },
  };

  return store;
}

module.exports = { createMemoryStore };
