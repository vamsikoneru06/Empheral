'use strict';

// Flag submission verdicts. Every attempt that reaches a round is recorded in submissions,
// so a verdict is always visible to the judges, whatever it was.
// Calls are serialised so that duplicate and first-blood checks cannot race.

const { FLAG_CAPTURE_POINTS, FIRST_BLOOD_POINTS, SUBMISSIONS_PER_WINDOW, SUBMISSION_WINDOW_MS } = require('./rules');
const { acceptingSubmissions } = require('./rounds');

class RoundNotOpenError extends Error {
  constructor() {
    super('No round is open for submissions.');
    this.code = 'round_not_running';
  }
}

function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

function createSubmissionService({ store, clock = Date.now }) {
  const serialise = createLock();

  const scoreOf = (board, teamId) => {
    const row = board.find((r) => r.team_id === teamId);
    return row ? row.score : 0;
  };

  function submit({ teamId, value, sourceIp }) {
    return serialise(async () => {
      const nowMs = clock();
      const round = await store.getCurrentRound();
      if (!round) throw new RoundNotOpenError();

      const normalised = String(value).trim().toLowerCase();
      const base = {
        round_id: round.id,
        submitter_team: teamId,
        value: normalised,
        submitted_at: new Date(nowMs),
        source_ip: sourceIp,
      };
      const record = (verdict, flagId = null) => store.insertSubmission({ ...base, verdict, flag_id: flagId });
      const plain = async (verdict, extra = {}) => ({
        verdict,
        points: 0,
        bonus_points: 0,
        first_blood: false,
        new_score: scoreOf(await store.leaderboard(round.id), teamId),
        ...extra,
      });

      const recent = await store.countRecentSubmissions(teamId, nowMs - SUBMISSION_WINDOW_MS);
      if (recent >= SUBMISSIONS_PER_WINDOW) {
        await record('rate_limited');
        return plain('rate_limited');
      }

      if (!acceptingSubmissions(round, nowMs)) {
        await record('expired');
        return plain('expired');
      }

      const flag = await store.findFlag(round.id, normalised);
      if (!flag) {
        await record('wrong');
        return plain('wrong');
      }

      if (flag.team_id === teamId) {
        await record('self_submit');
        return plain('self_submit');
      }

      if (await store.hasAcceptedSubmission(round.id, teamId, flag.id)) {
        await record('duplicate');
        return plain('duplicate');
      }

      // Accepted: the submission row and its score events commit together (NFR-4).
      return store.transaction(async (tx) => {
        const firstBlood = (await tx.acceptedCountForFlag(flag.id)) === 0;
        const sub = await tx.insertSubmission({ ...base, verdict: 'accepted', flag_id: flag.id });
        await tx.appendScoreEvent({
          round_id: round.id, team_id: teamId, kind: 'flag_capture',
          points: FLAG_CAPTURE_POINTS, ref_id: sub.id,
        });
        if (firstBlood) {
          await tx.appendScoreEvent({
            round_id: round.id, team_id: teamId, kind: 'first_blood',
            points: FIRST_BLOOD_POINTS, ref_id: sub.id,
          });
        }
        return {
          verdict: 'accepted',
          points: FLAG_CAPTURE_POINTS,
          bonus_points: firstBlood ? FIRST_BLOOD_POINTS : 0,
          first_blood: firstBlood,
          new_score: scoreOf(await tx.leaderboard(round.id), teamId),
        };
      });
    });
  }

  return { submit };
}

module.exports = { createSubmissionService, RoundNotOpenError };
