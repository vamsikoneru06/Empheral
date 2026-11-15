'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STATES, TRANSITIONS, canTransition, assertTransition, OrchestratorError } = require('../src/index');

test('every listed edge is legal', () => {
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) {
      const gate = { verificationPassed: true };
      assert.doesNotThrow(() => assertTransition(from, to, gate), `${from} -> ${to}`);
    }
  }
});

test('the main path planned -> closed is reachable', () => {
  const path = ['planned', 'provisioning', 'verifying', 'ready', 'running', 'frozen', 'closed'];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]} -> ${path[i + 1]}`);
  }
});

test('reset edges: blocked and closed go back to provisioning', () => {
  assert.equal(canTransition('blocked', 'provisioning'), true);
  assert.equal(canTransition('closed', 'provisioning'), true);
});

test('illegal transitions are rejected with 409 illegal_transition', () => {
  const illegal = [
    ['planned', 'ready'],
    ['planned', 'running'],
    ['provisioning', 'ready'],
    ['verifying', 'running'],
    ['ready', 'provisioning'],
    ['ready', 'closed'],
    ['running', 'closed'],
    ['running', 'ready'],
    ['frozen', 'running'],
    ['closed', 'running'],
    ['blocked', 'ready'],
    ['blocked', 'running'],
  ];
  for (const [from, to] of illegal) {
    assert.throws(
      () => assertTransition(from, to, { verificationPassed: true }),
      (err) => err instanceof OrchestratorError && err.code === 'illegal_transition' && err.httpStatus === 409,
      `${from} -> ${to} should be illegal`,
    );
  }
});

test('an unknown target state is rejected', () => {
  assert.throws(() => assertTransition('planned', 'bogus'), (err) => err.code === 'invalid_input');
});

test('VERIFYING -> READY needs a passing verifier run', () => {
  assert.throws(() => assertTransition('verifying', 'ready'), (err) => err.code === 'verification_required');
  assert.throws(
    () => assertTransition('verifying', 'ready', { verificationPassed: false }),
    (err) => err.code === 'verification_required',
  );
  assert.doesNotThrow(() => assertTransition('verifying', 'ready', { verificationPassed: true }));
});

test('READY -> RUNNING needs a passing verifier run too (FR-5.7)', () => {
  assert.throws(() => assertTransition('ready', 'running'), (err) => err.code === 'verification_required');
  assert.doesNotThrow(() => assertTransition('ready', 'running', { verificationPassed: true }));
});

test('VERIFYING -> BLOCKED needs no gate', () => {
  assert.doesNotThrow(() => assertTransition('verifying', 'blocked'));
});

test('the state list matches the data-model enum', () => {
  assert.deepEqual([...STATES].sort(), [
    'blocked', 'closed', 'frozen', 'planned', 'provisioning', 'ready', 'running', 'verifying',
  ]);
});
