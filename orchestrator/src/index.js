'use strict';

const path = require('node:path');
const { OrchestratorError } = require('./errors');
const { STATES, TRANSITIONS, canTransition, assertTransition } = require('./lifecycle');
const plan = require('./plan');
const { MockHypervisor, assertControlHost } = require('./hypervisor');
const { defaultVerifierRunner, parseVerifierOutput, tail } = require('./verifier');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RESET_FROM = Object.freeze(['blocked', 'closed', 'provisioning']);

/**
 * Round orchestrator (C5). Every method that changes state is an admin action and writes
 * exactly one audit_log row, including refused attempts. Reads (status) write nothing.
 *
 * The store is the scoring agent's store. It must provide: createRound, getRound,
 * listRounds, setRoundStatus, getCurrentRound, insertTargets, insertFlags,
 * insertVerificationRun, latestVerificationRun, appendAudit, upsertTeam, listTeams,
 * getTeam. Reset also needs listTargets(roundId) and listFlags(roundId), which are
 * not in that list. A store without them makes reset fail with store_unsupported.
 */
function createOrchestrator(options = {}) {
  const {
    store,
    hypervisor = new MockHypervisor(),
    runVerifier = defaultVerifierRunner,
    root = PROJECT_ROOT,
    imageDir = process.env.IMAGE_DIR || path.join(root, 'images'),
    actor = process.env.ORCH_ACTOR || 'orchestrator',
    now = () => new Date(),
  } = options;
  if (!store) throw new Error('createOrchestrator: a store is required');

  const expectedPath = path.join(root, 'out', 'expected-matrix.json');

  async function call(method, ...args) {
    if (typeof store[method] !== 'function') {
      throw new OrchestratorError('store_unsupported', `store has no ${method}(); the orchestrator needs it`, 500);
    }
    return store[method](...args);
  }

  async function loadRound(roundId) {
    const round = await call('getRound', roundId);
    if (!round) throw new OrchestratorError('not_found', `round ${roundId} does not exist`, 404);
    return round;
  }

  // Single point where a round's status changes. Every change passes assertTransition.
  async function moveTo(round, to, gate) {
    assertTransition(round.status, to, gate);
    await call('setRoundStatus', round.id, to);
    round.status = to;
  }

  // Runs one admin action and writes exactly one audit row, on success or refusal.
  async function admin(action, roundId, fn) {
    const ctx = {
      subject: roundId === undefined ? null : `round:${roundId}`,
      detail: {},
    };
    let outcome = 'ok';
    let error = null;
    try {
      return await fn(ctx);
    } catch (err) {
      error = err.code || 'error';
      outcome = err instanceof OrchestratorError && err.httpStatus < 500 ? 'refused' : 'failed';
      throw err;
    } finally {
      await call('appendAudit', {
        actor,
        action,
        subject: ctx.subject,
        detail: { ...ctx.detail, outcome, error },
      });
    }
  }

  // The store's latestVerificationRun may return another round's run (the memory store
  // ignores its argument). Only a run that belongs to this round counts.
  async function latestRunFor(roundId) {
    const latest = await call('latestVerificationRun', roundId);
    return latest && Number(latest.round_id) === Number(roundId) ? latest : null;
  }

  async function teamsFor(round) {
    if (Array.isArray(round.team_ids) && round.team_ids.length > 0) {
      return plan.assertTeamIds(round.team_ids);
    }
    const teams = await call('listTeams');
    return plan.assertTeamIds(teams.map((team) => team.id));
  }

  async function deployAll(targets, flags) {
    for (const target of targets) {
      await hypervisor.deploy(target, plan.flagFor(flags, target));
      const observed = await hypervisor.hash(target);
      if (observed !== target.image_hash) {
        throw new OrchestratorError(
          'provision_failed',
          `image hash mismatch on ${target.ip_address} after deploy`,
          500,
        );
      }
    }
  }

  async function createRound(input = {}) {
    return admin('round.create', undefined, async (ctx) => {
      const {
        name,
        image_set: imageSet,
        starts_at: startsAt = null,
        duration_minutes: durationMinutes = 180,
        freeze_minutes: freezeMinutes = 15,
        team_ids: teamIds,
      } = input;
      if (typeof name !== 'string' || name.trim() === '' || name.length > 128) {
        throw new OrchestratorError('invalid_input', 'name must be 1 to 128 characters', 400);
      }
      plan.assertImageSet(imageSet);
      if (teamIds !== undefined) plan.assertTeamIds(teamIds);
      if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
        throw new OrchestratorError('invalid_input', 'duration_minutes must be a positive integer', 400);
      }
      if (!Number.isInteger(freezeMinutes) || freezeMinutes < 0) {
        throw new OrchestratorError('invalid_input', 'freeze_minutes must be a non-negative integer', 400);
      }
      if (startsAt !== null && Number.isNaN(Date.parse(startsAt))) {
        throw new OrchestratorError('invalid_input', 'starts_at must be RFC 3339', 400);
      }
      const round = await call('createRound', {
        name,
        image_set: imageSet,
        starts_at: startsAt,
        duration_minutes: durationMinutes,
        freeze_minutes: freezeMinutes,
        team_ids: teamIds ?? [],
      });
      ctx.subject = `round:${round.id}`;
      ctx.detail.image_set = imageSet;
      return round;
    });
  }

  /** planned -> provisioning -> verifying. Creates the target rows and flags, deploys, checks hashes. */
  async function provision(roundId) {
    return admin('round.provision', roundId, async (ctx) => {
      const round = await loadRound(roundId);
      assertTransition(round.status, 'provisioning');
      const teamIds = await teamsFor(round);
      const image = await plan.computeImageHash({ imageDir, imageSet: round.image_set });
      const targets = plan.deriveTargets({ roundId, teamIds, imageHash: image.hash });
      if (!plan.environmentsIdentical(targets).identical) {
        throw new OrchestratorError('environments_differ', 'team target sets are not identical', 500);
      }
      const flags = plan.generateFlags({ roundId, teamIds, injectedAt: now().toISOString() });

      await moveTo(round, 'provisioning');
      try {
        await call('insertTargets', roundId, targets);
        await call('insertFlags', roundId, flags);
        await deployAll(targets, flags);
        await moveTo(round, 'verifying');
      } catch (err) {
        await call('setRoundStatus', roundId, 'blocked');
        round.status = 'blocked';
        throw err instanceof OrchestratorError
          ? err
          : new OrchestratorError('provision_failed', `provisioning failed: ${err.message}`, 500);
      }

      ctx.detail.teams = teamIds.length;
      ctx.detail.image_stub = image.stub;
      return {
        round_id: roundId,
        status: 'verifying',
        teams: teamIds.length,
        targets: targets.length,
        flags: flags.length,
        image: { hash: image.hash, stub: image.stub, path: image.path },
      };
    });
  }

  /** Runs the verifier and stores the run. exit 0 moves the round to ready, anything else to blocked. */
  async function verify(roundId) {
    return admin('round.verify', roundId, async (ctx) => {
      const round = await loadRound(roundId);
      if (round.status !== 'verifying') {
        throw new OrchestratorError(
          'illegal_transition',
          `verification runs only from verifying; round is ${round.status}`,
          409,
        );
      }
      const result = await runVerifier({ root, expectedPath });
      const parsed = parseVerifierOutput(result.stdout) || {};
      const passed = result.exitCode === 0 && parsed.passed !== false;
      const pairsTested = Number.isInteger(parsed.pairs_tested) ? parsed.pairs_tested : 0;
      const violations = Number.isInteger(parsed.violations) ? parsed.violations : (passed ? 0 : 1);
      await call('insertVerificationRun', {
        round_id: roundId,
        passed,
        pairs_tested: pairsTested,
        violations,
        matrix_json: {
          exit_code: result.exitCode,
          matrix: parsed.matrix ?? null,
          assertions: parsed.assertions ?? null,
          stdout_tail: parsed.matrix ? null : tail(result.stdout),
          stderr_tail: tail(result.stderr),
        },
        report_path: parsed.report_path ?? null,
        ran_at: now().toISOString(),
      });

      const to = passed ? 'ready' : 'blocked';
      await moveTo(round, to, { verificationPassed: passed });
      ctx.detail.passed = passed;
      ctx.detail.exit_code = result.exitCode;
      return {
        round_id: roundId,
        passed,
        exit_code: result.exitCode,
        status: to,
        pairs_tested: pairsTested,
        violations,
      };
    });
  }

  /** Restores every target to the golden baseline and checks each hash. Any mismatch leaves the round in provisioning. */
  async function reset(roundId) {
    return admin('round.reset', roundId, async (ctx) => {
      const round = await loadRound(roundId);
      if (round.status === 'running') {
        throw new OrchestratorError('round_not_running', 'round is running; reset is refused', 409);
      }
      if (!RESET_FROM.includes(round.status)) {
        throw new OrchestratorError('illegal_transition', `reset is not allowed from ${round.status}`, 409);
      }
      const targets = await call('listTargets', roundId);
      if (!targets || targets.length === 0) {
        throw new OrchestratorError('not_provisioned', 'round has no targets to restore', 409);
      }
      // Read the flags before anything changes, so a store without listFlags fails with no side effects.
      const flags = await call('listFlags', roundId);
      if (round.status !== 'provisioning') await moveTo(round, 'provisioning');

      const mismatches = [];
      for (const target of targets) {
        await hypervisor.restore(target);
        const observed = await hypervisor.hash(target);
        if (observed !== target.image_hash) {
          mismatches.push({ team_id: target.team_id, role: target.role, ip_address: target.ip_address });
        }
      }
      ctx.detail.restored = targets.length;
      ctx.detail.mismatches = mismatches.length;
      if (mismatches.length > 0) {
        return { round_id: roundId, status: 'provisioning', restored: targets.length, mismatches };
      }

      for (const target of targets) {
        await hypervisor.deploy(target, plan.flagFor(flags, target));
      }
      await moveTo(round, 'verifying');
      return { round_id: roundId, status: 'verifying', restored: targets.length, mismatches: [] };
    });
  }

  /** ready -> running. Refused unless this round's latest verification run passed (FR-5.7). */
  async function start(roundId) {
    return admin('round.start', roundId, async () => {
      const round = await loadRound(roundId);
      const latest = await latestRunFor(roundId);
      await moveTo(round, 'running', { verificationPassed: Boolean(latest && latest.passed) });
      return { round_id: roundId, status: 'running' };
    });
  }

  async function freeze(roundId) {
    return admin('round.freeze', roundId, async () => {
      const round = await loadRound(roundId);
      await moveTo(round, 'frozen');
      return { round_id: roundId, status: 'frozen' };
    });
  }

  async function close(roundId) {
    return admin('round.close', roundId, async () => {
      const round = await loadRound(roundId);
      await moveTo(round, 'closed');
      return { round_id: roundId, status: 'closed' };
    });
  }

  /** Read-only. Not an admin action, so it writes no audit row. */
  async function status(roundId) {
    const round = roundId === undefined ? await call('getCurrentRound') : await loadRound(roundId);
    if (!round) throw new OrchestratorError('not_found', 'no current round', 404);
    const latest = await latestRunFor(round.id);
    const result = { round, latest_verification: latest };
    if (typeof store.listTargets === 'function') {
      const targets = await call('listTargets', round.id);
      result.targets = targets.length;
      result.environments = plan.environmentsIdentical(targets);
    }
    return result;
  }

  return { createRound, provision, verify, reset, start, freeze, close, status };
}

module.exports = {
  createOrchestrator,
  OrchestratorError,
  STATES,
  TRANSITIONS,
  canTransition,
  assertTransition,
  MockHypervisor,
  assertControlHost,
  defaultVerifierRunner,
  parseVerifierOutput,
  ...plan,
  PROJECT_ROOT,
};
