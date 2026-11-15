import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeState, cellColour, heatmapGrid } from './matrix.js';
import { mergeEvents, nextSinceSeq } from './timeline.js';
import expected from '../fixtures/matrix.json' with { type: 'json' };

const cellOf = (grid, src, dst) => grid.rows.find((r) => r.src === src).cells.find((c) => c.dst === dst);
const redCount = (grid) => grid.rows.reduce((n, r) => n + r.cells.filter((c) => c.colour === 'red').length, 0);
const clone = (x) => structuredClone(x);

test('probeState: matching verdicts pass, anything else is a mismatch', () => {
  assert.equal(probeState('permit', 'permit'), 'permitted');
  assert.equal(probeState('deny', 'deny'), 'denied');
  assert.equal(probeState('deny', 'permit'), 'mismatch');
  assert.equal(probeState('permit', 'deny'), 'mismatch');
  assert.equal(probeState(undefined, 'deny'), 'mismatch');
  assert.equal(probeState(undefined, undefined), 'mismatch');
  assert.equal(probeState('maybe', 'maybe'), 'mismatch');
});

test('cellColour: green, grey and red per the validation-plan rule', () => {
  assert.equal(cellColour(['permitted', 'permitted']), 'green');
  assert.equal(cellColour(['denied', 'denied']), 'grey');
  assert.equal(cellColour(['permitted', 'denied', 'denied', 'denied']), 'green');
  assert.equal(cellColour(['denied', 'mismatch']), 'red');
  assert.equal(cellColour(['permitted', 'mismatch']), 'red');
  assert.equal(cellColour([]), 'red');
});

test('heatmapGrid: the passing fixture has no red cell and the expected shape', () => {
  const grid = heatmapGrid(expected.matrix, expected.matrix);
  assert.equal(grid.rows.length, 9);
  assert.equal(grid.cols.length, 12);
  assert.equal(redCount(grid), 0);
  assert.equal(cellOf(grid, 'pod-1', 'target-1').colour, 'green');
  assert.equal(cellOf(grid, 'pod-1', 'target-2').colour, 'grey');
  assert.equal(cellOf(grid, 'target-1', 'scoring').colour, 'green');
  assert.equal(cellOf(grid, 'scoring', 'target-3').colour, 'green');
  assert.equal(cellOf(grid, 'scoring', 'pod-2').colour, 'grey');
  assert.equal(cellOf(grid, 'pod-1', 'pod-1').colour, 'blank');
});

test('heatmapGrid: one flipped probe turns exactly that cell red', () => {
  const observed = clone(expected.matrix);
  observed['pod-1']['target-1'].udp = 'deny';
  const grid = heatmapGrid(observed, expected.matrix);
  assert.equal(redCount(grid), 1);
  assert.equal(cellOf(grid, 'pod-1', 'target-1').colour, 'red');
  assert.match(cellOf(grid, 'pod-1', 'target-1').title, /udp expected permit, observed deny/);
});

test('heatmapGrid: a missing observed source makes its row red', () => {
  const observed = clone(expected.matrix);
  delete observed['target-2'];
  const grid = heatmapGrid(observed, expected.matrix);
  const row = grid.rows.find((r) => r.src === 'target-2');
  assert.equal(row.cells.filter((c) => c.colour === 'red').length, 11);
});

test('mergeEvents: dedupes by seq and sorts ascending', () => {
  const held = [{ seq: 2 }, { seq: 1, team_id: 1 }];
  const merged = mergeEvents(held, [{ seq: 3 }, { seq: 2 }]);
  assert.deepEqual(merged.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(mergeEvents([], []), []);
});

test('nextSinceSeq: moves to the highest seq and never backwards', () => {
  assert.equal(nextSinceSeq(0, [{ seq: 5 }, { seq: 9 }, { seq: 7 }]), 9);
  assert.equal(nextSinceSeq(9, []), 9);
  assert.equal(nextSinceSeq(9, [{ seq: 4 }]), 9);
});
