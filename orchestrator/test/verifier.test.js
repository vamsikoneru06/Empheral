'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { defaultVerifierRunner, parseVerifierOutput, verifierCommand, DEFAULT_VERIFIER_CMD } = require('../src/verifier');

const ROOT = path.resolve(__dirname, '..', '..');
const fixture = (name) => path.join(__dirname, '..', 'fixtures', name);

test('verifier command: default, and VERIFIER_CMD overrides it', () => {
  assert.equal(verifierCommand({}), DEFAULT_VERIFIER_CMD);
  assert.equal(verifierCommand({ VERIFIER_CMD: '   ' }), DEFAULT_VERIFIER_CMD);
  assert.equal(verifierCommand({ VERIFIER_CMD: 'node x.js' }), 'node x.js');
  assert.match(DEFAULT_VERIFIER_CMD, /^python -m verifier run --expected out\/expected-matrix\.json --format json$/);
});

test('default runner: exit 0 and the JSON report pass through', async () => {
  const env = { ...process.env, VERIFIER_CMD: `node "${fixture('verifier-pass.js')}"` };
  const result = await defaultVerifierRunner({ root: ROOT, env });
  assert.equal(result.exitCode, 0);
  assert.equal(parseVerifierOutput(result.stdout).passed, true);
});

test('default runner: a failing verifier returns its non-zero exit code', async () => {
  const env = { ...process.env, VERIFIER_CMD: `node "${fixture('verifier-fail.js')}"` };
  const result = await defaultVerifierRunner({ root: ROOT, env });
  assert.equal(result.exitCode, 1);
  assert.equal(parseVerifierOutput(result.stdout).violations, 3);
});

test('default runner: a command that cannot start is a probe error (2), never a pass', async () => {
  const env = { ...process.env, VERIFIER_CMD: 'definitely-not-a-real-command-cyberrange --x' };
  const result = await defaultVerifierRunner({ root: ROOT, env });
  assert.notEqual(result.exitCode, 0);
});

test('parseVerifierOutput: whole document, last line after logs, or nothing', () => {
  assert.deepEqual(parseVerifierOutput('{"passed":true}'), { passed: true });
  assert.deepEqual(parseVerifierOutput('probing 396 pairs\n{"passed":false}'), { passed: false });
  assert.equal(parseVerifierOutput('not json at all'), null);
  assert.equal(parseVerifierOutput(''), null);
  assert.equal(parseVerifierOutput('[1,2]'), null);
});
