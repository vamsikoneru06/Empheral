'use strict';

// Round clock. The stored status is never rewritten by the passage of time: a round that is
// 'running' becomes 'frozen' or 'closed' when read, based on freeze_minutes and ends_at.

const FREEZE_LEAD_MS = 60000;

function timesOf(round) {
  const endsMs = round.ends_at ? Date.parse(round.ends_at) : null;
  const freezeMs = endsMs === null ? null : endsMs - round.freeze_minutes * FREEZE_LEAD_MS;
  return { endsMs, freezeMs };
}

// Status as seen at nowMs: 'running', 'frozen', 'closed', or the stored status.
function effectiveStatus(round, nowMs) {
  if (round.status !== 'running') return round.status;
  const { endsMs, freezeMs } = timesOf(round);
  if (endsMs !== null && nowMs >= endsMs) return 'closed';
  if (freezeMs !== null && nowMs >= freezeMs) return 'frozen';
  return 'running';
}

// Submissions are accepted only while the round is running and not yet frozen.
function acceptingSubmissions(round, nowMs) {
  return effectiveStatus(round, nowMs) === 'running';
}

function freezeAtIso(round) {
  const { freezeMs } = timesOf(round);
  return freezeMs === null ? null : new Date(freezeMs).toISOString();
}

module.exports = { effectiveStatus, acceptingSubmissions, freezeAtIso };
