'use strict';

const { OrchestratorError } = require('./errors');

// Round lifecycle (architecture.md section 5). The reset edges go back to
// PROVISIONING: from BLOCKED after a failed gate, and from CLOSED between rounds.
const STATES = Object.freeze([
  'planned', 'provisioning', 'verifying', 'blocked',
  'ready', 'running', 'frozen', 'closed',
]);

const TRANSITIONS = Object.freeze({
  planned: ['provisioning'],
  provisioning: ['verifying', 'blocked'],
  verifying: ['ready', 'blocked'],
  blocked: ['provisioning'],
  ready: ['running'],
  running: ['frozen'],
  frozen: ['closed'],
  closed: ['provisioning'],
});

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/**
 * Throws if from -> to is not legal. Two edges are gated by a passing verifier run:
 * VERIFYING -> READY (the gate, exit code 0) and READY -> RUNNING (FR-5.7).
 * `gate.verificationPassed` must be true for those two edges.
 */
function assertTransition(from, to, gate = {}) {
  if (!STATES.includes(to)) {
    throw new OrchestratorError('invalid_input', `unknown round state "${to}"`, 400);
  }
  if (!canTransition(from, to)) {
    throw new OrchestratorError('illegal_transition', `a round cannot move ${from} -> ${to}`, 409);
  }
  const needsPassingRun = (from === 'verifying' && to === 'ready') || (from === 'ready' && to === 'running');
  if (needsPassingRun && gate.verificationPassed !== true) {
    throw new OrchestratorError(
      'verification_required',
      `${from} -> ${to} needs a passing verification run (verifier exit 0)`,
      409,
    );
  }
}

module.exports = { STATES, TRANSITIONS, canTransition, assertTransition };
