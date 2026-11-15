'use strict';

// Admin routes from api-spec.md (Admin section). They are thin wrappers: the orchestrator does the work
// and writes the audit rows. Provisioning and verification run to completion before the response is sent,
// so the 202 responses carry a job id that refers to a finished job. There is no queue.

const { need } = require('./auth');

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function roundIdOf(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    const err = new Error('Round not found.');
    err.code = 'not_found';
    err.httpStatus = 404;
    throw err;
  }
  return id;
}

// Map an error from the orchestrator (code and httpStatus) to the api-spec error envelope.
function failWith(res, err) {
  if (err && err.code && err.httpStatus) return sendError(res, err.httpStatus, err.code, err.message);
  console.error('scoring: admin error', err && err.stack ? err.stack : err);
  return sendError(res, 500, 'internal', 'Internal error.');
}

/**
 * Mounts the admin routes on an Express app.
 *   orchestrator: { createRound, provision, reset }   (createOrchestrator from ../../orchestrator/src)
 *   verifier:     { run() -> { exitCode, stdout } }   (runs the containment verifier)
 *   store:        the scoring store, used to record ad-hoc verification runs
 */
function mountAdminRoutes(app, { orchestrator, verifier, store }) {
  const guarded = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      failWith(res, err);
    }
  };

  app.post('/api/rounds', need('admin'), guarded(async (req, res) => {
    const round = await orchestrator.createRound(req.body || {});
    return res.status(201).json(round);
  }));

  app.post('/api/rounds/:id/provision', need('admin'), guarded(async (req, res) => {
    const roundId = roundIdOf(req);
    const result = await orchestrator.provision(roundId);
    return res.status(202).json({ job_id: `provision-${roundId}`, round_id: roundId, status: 'completed', result });
  }));

  app.post('/api/rounds/:id/reset', need('admin'), guarded(async (req, res) => {
    const roundId = roundIdOf(req);
    const result = await orchestrator.reset(roundId);
    return res.json({ round_id: roundId, result });
  }));

  // Ad-hoc run. A round can only reach READY through the orchestrator's own gate, which records its run.
  app.post('/api/verification/run', need('admin'), guarded(async (req, res) => {
    const outcome = await verifier.run();
    const report = parseReport(outcome.stdout);
    if (!report) {
      return sendError(res, 502, 'verifier_failed', 'The verifier produced no JSON report.');
    }
    const passed = outcome.exitCode === 0 && report.passed === true;
    const run = await store.insertVerificationRun({
      round_id: null,
      passed,
      pairs_tested: report.pairs_tested,
      violations: report.violations,
      matrix_json: report,
      report_path: null,
      ran_at: report.ran_at,
    });
    return res.status(202).json({ job_id: `verification-${run.id}`, id: run.id, passed, exit_code: outcome.exitCode });
  }));
}

// The verifier prints its JSON report on stdout. Accept the whole output, or its last line.
function parseReport(stdout) {
  const text = String(stdout || '').trim();
  for (const candidate of [text, text.split(/\r?\n/).pop()]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // not JSON; try the next candidate
    }
  }
  return null;
}

module.exports = { mountAdminRoutes };
