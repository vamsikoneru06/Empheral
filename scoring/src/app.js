'use strict';

const express = require('express');
const { authenticate, need } = require('./auth');
const { effectiveStatus, freezeAtIso } = require('./rounds');
const { createSubmissionService, RoundNotOpenError } = require('./submissions');
const rules = require('./rules');
const { mountAdminRoutes } = require('./admin');

const isoOf = (ms) => new Date(ms).toISOString();

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// Accepts a positive integer as a string or number. Returns null when invalid.
function parseId(value) {
  const s = String(value);
  return /^[1-9]\d{0,9}$/.test(s) ? Number(s) : null;
}

// Accepts a non-negative integer. Returns null when invalid.
function parseNonNegative(value) {
  const s = String(value);
  return /^\d{1,15}$/.test(s) ? Number(s) : null;
}

// Client address as stored in submissions.source_ip (VARCHAR(15)).
function sourceIpOf(req) {
  return String(req.ip || '').replace(/^::ffff:/, '').slice(0, 15) || 'unknown';
}

function createApp({
  store,
  tokens = new Map(),
  clock = Date.now,
  leaderboardCacheMs = rules.LEADERBOARD_CACHE_MS,
  orchestrator = null,
  verifier = null,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));
  app.use(authenticate(tokens));

  const submissions = createSubmissionService({ store, clock });

  // ---- leaderboard (public, cached) --------------------------------------
  const boardCache = new Map(); // roundId -> { at, body }

  async function leaderboardFor(roundId) {
    const now = clock();
    const hit = boardCache.get(roundId);
    if (hit && now - hit.at < leaderboardCacheMs) return hit.body;

    const round = await store.getRound(roundId);
    const board = await store.leaderboard(roundId);
    const polls = await store.latestPolls(roundId);
    const status = effectiveStatus(round, now);
    const body = {
      round_id: roundId,
      frozen: status === 'frozen' || status === 'closed',
      as_of: isoOf(now),
      teams: board.map((row, index) => {
        const mine = polls.filter((p) => p.team_id === row.team_id);
        return {
          rank: index + 1,
          team_id: row.team_id,
          name: row.name,
          score: row.score,
          services_up: mine.filter((p) => p.reachable).length,
          services_total: mine.length,
        };
      }),
    };
    boardCache.set(roundId, { at: now, body });
    return body;
  }

  app.get('/api/leaderboard', async (req, res) => {
    let roundId;
    if (req.query.round_id !== undefined) {
      roundId = parseId(req.query.round_id);
      if (roundId === null) return sendError(res, 400, 'bad_request', 'round_id must be a positive integer.');
    } else {
      const current = await store.getCurrentRound();
      roundId = current ? current.id : null;
    }
    if (roundId === null || !(await store.getRound(roundId))) {
      return sendError(res, 404, 'not_found', 'Round not found.');
    }
    return res.json(await leaderboardFor(roundId));
  });

  // ---- current round (public) --------------------------------------------
  app.get('/api/rounds/current', async (req, res) => {
    const round = await store.getCurrentRound();
    if (!round) return sendError(res, 404, 'not_found', 'No round exists.');
    const now = clock();
    return res.json({
      id: round.id,
      name: round.name,
      status: effectiveStatus(round, now),
      starts_at: round.starts_at,
      ends_at: round.ends_at,
      freeze_at: freezeAtIso(round),
      server_time: isoOf(now),
    });
  });

  // ---- own team (competitor, own team only) ------------------------------
  app.get('/api/teams/:id', need('competitor'), async (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return sendError(res, 404, 'not_found', 'Team not found.');
    if (req.caller.team_id !== id) {
      return sendError(res, 403, 'forbidden', 'You may only view your own team.');
    }
    const team = await store.getTeam(id);
    if (!team) return sendError(res, 404, 'not_found', 'Team not found.');

    const round = await store.getCurrentRound();
    let score = 0;
    let targets = [];
    if (round) {
      const board = await store.leaderboard(round.id);
      const row = board.find((r) => r.team_id === id);
      score = row ? row.score : 0;
      const polls = await store.latestPolls(round.id);
      targets = (await store.listTargets(round.id))
        .filter((t) => t.team_id === id)
        .map((t) => {
          const poll = polls.find((p) => p.team_id === id && p.target_role === t.role);
          let status = 'unknown';
          if (poll) status = poll.reachable ? 'up' : 'down';
          return { role: t.role, ip: t.ip_address, status };
        });
    }
    return res.json({
      team_id: team.id,
      name: team.name,
      score,
      pod_subnet: team.pod_subnet,
      target_subnet: team.target_subnet,
      targets,
    });
  });

  // ---- flag submission (competitor) --------------------------------------
  app.post('/api/submissions', need('competitor'), async (req, res) => {
    const value = (req.body || {}).value;
    if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 64) {
      return sendError(res, 400, 'bad_request', 'value must be a non-empty string of at most 64 characters.');
    }
    try {
      const out = await submissions.submit({
        teamId: req.caller.team_id,
        value,
        sourceIp: sourceIpOf(req),
      });
      if (out.verdict === 'rate_limited') {
        return res.status(429).json({
          verdict: 'rate_limited',
          error: { code: 'rate_limited', message: 'Too many submissions. Try again in a minute.' },
        });
      }
      return res.json(out);
    } catch (err) {
      if (err instanceof RoundNotOpenError) return sendError(res, 409, err.code, err.message);
      throw err;
    }
  });

  // ---- judge timeline (judge, admin) -------------------------------------
  app.get('/api/judge/timeline', need('judge', 'admin'), async (req, res) => {
    let roundId;
    if (req.query.round_id !== undefined) {
      roundId = parseId(req.query.round_id);
    } else {
      const current = await store.getCurrentRound();
      roundId = current ? current.id : null;
    }
    if (roundId === null || !(await store.getRound(roundId))) {
      return sendError(res, 404, 'not_found', 'Round not found.');
    }
    let sinceSeq = 0;
    if (req.query.since_seq !== undefined) {
      sinceSeq = parseNonNegative(req.query.since_seq);
      if (sinceSeq === null) return sendError(res, 400, 'bad_request', 'since_seq must be a non-negative integer.');
    }
    let limit = rules.TIMELINE_DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      limit = parseId(req.query.limit);
      if (limit === null || limit > rules.TIMELINE_MAX_LIMIT) {
        return sendError(res, 400, 'bad_request', `limit must be between 1 and ${rules.TIMELINE_MAX_LIMIT}.`);
      }
    }
    const events = await store.listTimeline(roundId, sinceSeq, limit);
    return res.json({
      round_id: roundId,
      next_seq: events.length ? events[events.length - 1].seq : sinceSeq,
      events: events.map((e) => ({
        seq: e.seq,
        team_id: e.team_id,
        kind: e.kind,
        points: e.points,
        ref_id: e.ref_id,
        note: e.note,
        occurred_at: e.occurred_at,
      })),
    });
  });

  // ---- manual adjustment (judge, admin): one score row and one audit row -
  app.post('/api/judge/adjust', need('judge', 'admin'), async (req, res) => {
    const body = req.body || {};
    const roundId = Number.isInteger(body.round_id) && body.round_id > 0 ? body.round_id : null;
    const teamId = Number.isInteger(body.team_id) && body.team_id > 0 ? body.team_id : null;
    const points = body.points;
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (roundId === null || teamId === null) {
      return sendError(res, 400, 'bad_request', 'round_id and team_id must be positive integers.');
    }
    if (typeof points !== 'number' || !Number.isFinite(points) || points === 0
      || Math.abs(points) > 999999.99 || Math.abs(points * 100 - Math.round(points * 100)) > 1e-6) {
      return sendError(res, 400, 'bad_request', 'points must be a non-zero number with at most 2 decimals.');
    }
    if (note.length === 0 || note.length > 255) {
      return sendError(res, 400, 'bad_request', 'note is required and must be at most 255 characters.');
    }
    if (!(await store.getRound(roundId))) return sendError(res, 404, 'not_found', 'Round not found.');
    if (!(await store.getTeam(teamId))) return sendError(res, 404, 'not_found', 'Team not found.');

    const out = await store.transaction(async (tx) => {
      const event = await tx.appendScoreEvent({
        round_id: roundId, team_id: teamId, kind: 'manual_adjust', points, note,
      });
      const audit = await tx.appendAudit({
        actor: req.caller.actor,
        action: 'judge.adjust',
        subject: `team:${teamId}`,
        detail: { round_id: roundId, team_id: teamId, points, note, seq: event.seq },
      });
      const board = await tx.leaderboard(roundId);
      const row = board.find((r) => r.team_id === teamId);
      return { event, audit, newScore: row ? row.score : 0 };
    });
    return res.status(201).json({
      seq: out.event.seq,
      audit_id: out.audit.id,
      round_id: roundId,
      team_id: teamId,
      points,
      note,
      new_score: out.newScore,
    });
  });

  // ---- verification (admin) ----------------------------------------------
  app.get('/api/verification/latest', need('admin'), async (req, res) => {
    const run = await store.latestVerificationRun();
    if (!run) return sendError(res, 404, 'not_found', 'No verification run exists.');
    return res.json({
      id: run.id,
      round_id: run.round_id,
      passed: run.passed,
      pairs_tested: run.pairs_tested,
      violations: run.violations,
      ran_at: run.ran_at,
      assertions: (run.matrix_json && run.matrix_json.assertions) || {},
    });
  });

  // ---- admin (only when the orchestrator and verifier are wired in) ------
  if (orchestrator && verifier) mountAdminRoutes(app, { orchestrator, verifier, store });

  // ---- fallbacks ----------------------------------------------------------
  app.use((req, res) => sendError(res, 404, 'not_found', 'No such endpoint.'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported')) {
      return sendError(res, 400, 'bad_request', 'Malformed JSON body.');
    }
    if (err && err.type === 'entity.too.large') {
      return sendError(res, 413, 'bad_request', 'Request body too large.');
    }
    console.error('scoring: unhandled error', err && err.stack ? err.stack : err);
    return sendError(res, 500, 'internal', 'Internal error.');
  });

  return app;
}

module.exports = { createApp };
