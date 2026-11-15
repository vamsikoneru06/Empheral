'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, UsageError } = require('../src/cli');

test('parseArgs reads the four commands and --round', () => {
  assert.deepEqual(parseArgs(['provision', '--round', '3']), { command: 'provision', round: 3 });
  assert.deepEqual(parseArgs(['reset', '--round=2']), { command: 'reset', round: 2 });
  assert.deepEqual(parseArgs(['verify', '--round', '7']), { command: 'verify', round: 7 });
});

test('status works with or without --round', () => {
  assert.deepEqual(parseArgs(['status']), { command: 'status', round: null });
  assert.deepEqual(parseArgs(['status', '--round', '4']), { command: 'status', round: 4 });
});

test('usage errors: unknown command, missing round, bad round, unknown flag', () => {
  assert.throws(() => parseArgs(['destroy', '--round', '1']), UsageError);
  assert.throws(() => parseArgs(['provision']), UsageError);
  assert.throws(() => parseArgs(['reset', '--round']), UsageError);
  assert.throws(() => parseArgs(['verify', '--round', '0']), UsageError);
  assert.throws(() => parseArgs(['verify', '--round', 'abc']), UsageError);
  assert.throws(() => parseArgs(['status', '--force']), UsageError);
});
