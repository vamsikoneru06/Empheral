'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSubmissionService, RoundNotOpenError } = require('../src/submissions');
const { createMemoryStore } = require('../src/store');
const { fixture, FLAG_ON_TEAM_1, FLAG_ON_TEAM_2, fakeFlag } = require('./fixture');

function service(fx) {
  return createSubmissionService({ store: fx.store, clock: () => fx.clock.now });
}

const submit = (svc, teamId, value) => svc.submit({ teamId, value, sourceIp: '10.20.1.10' });

test('first valid capture is accepted with flag points and first-blood bonus', async () => {
  const fx = fixture();
  const out = await submit(service(fx), 1, FLAG_ON_TEAM_2);
  assert.deepEqual(out, {
    verdict: 'accepted', points: 50, bonus_points: 25, first_blood: true, new_score: 75,
  });
});

test('a later capture of an already-captured flag gets no first-blood bonus', async () => {
  const fx = fixture();
  const svc = service(fx);
  await submit(svc, 1, FLAG_ON_TEAM_2);
  const out = await submit(svc, 3, FLAG_ON_TEAM_2);
  assert.deepEqual(out, {
    verdict: 'accepted', points: 50, bonus_points: 0, first_blood: false, new_score: 50,
  });
});

test('a flag planted on the submitting team is self_submit and scores nothing', async () => {
  const fx = fixture();
  const out = await submit(service(fx), 2, FLAG_ON_TEAM_2);
  assert.equal(out.verdict, 'self_submit');
  assert.equal(out.points, 0);
  assert.equal(out.new_score, 0);
});

test('resubmitting an accepted flag is duplicate, case-insensitively', async () => {
  const fx = fixture();
  const svc = service(fx);
  await submit(svc, 1, FLAG_ON_TEAM_2);
  const out = await submit(svc, 1, `  ${FLAG_ON_TEAM_2.toUpperCase()} `);
  assert.equal(out.verdict, 'duplicate');
  assert.equal(out.new_score, 75, 'duplicate adds nothing');
});

test('an unknown value is wrong', async () => {
  const fx = fixture();
  const out = await submit(service(fx), 1, fakeFlag(7));
  assert.equal(out.verdict, 'wrong');
  assert.equal(out.points, 0);
});

test('a flag from another round is wrong in the current round', async () => {
  const fx = fixture();
  fx.store.setRoundStatus(fx.round.id, 'closed');
  const next = fx.store.createRound({
    name: 'Round 2', image_set: 'golden-v3', starts_at: '2026-11-02T09:00:00Z',
    duration_minutes: 180, team_ids: [1, 2, 3],
  });
  fx.store.setRoundStatus(next.id, 'running');
  const out = await submit(service(fx), 1, FLAG_ON_TEAM_2);
  assert.equal(out.verdict, 'wrong');
});

test('after the freeze point submissions are expired even when the flag is valid', async () => {
  const fx = fixture({ freezeMinutes: 15 });
  fx.clock.now = Date.parse('2026-11-02T11:50:00Z'); // freeze at 11:45
  const out = await submit(service(fx), 1, FLAG_ON_TEAM_2);
  assert.equal(out.verdict, 'expired');
  assert.equal(out.points, 0);
});

test('a round that is not running gives expired', async () => {
  const fx = fixture({ status: 'planned' });
  assert.equal((await submit(service(fx), 1, FLAG_ON_TEAM_2)).verdict, 'expired');
});

test('a stored frozen status gives expired', async () => {
  const fx = fixture({ status: 'frozen' });
  assert.equal((await submit(service(fx), 1, FLAG_ON_TEAM_2)).verdict, 'expired');
});

test('with no round at all the service refuses with RoundNotOpenError', async () => {
  const store = createMemoryStore({ clock: () => 0 });
  const svc = createSubmissionService({ store, clock: () => 0 });
  await assert.rejects(() => svc.submit({ teamId: 1, value: 'a'.repeat(64) }), RoundNotOpenError);
});

test('every attempt that reaches a round is recorded with its verdict', async () => {
  const fx = fixture();
  const svc = service(fx);
  await submit(svc, 1, FLAG_ON_TEAM_2);   // accepted
  await submit(svc, 1, FLAG_ON_TEAM_2);   // duplicate
  await submit(svc, 2, FLAG_ON_TEAM_2);   // self_submit
  await submit(svc, 1, fakeFlag(3));      // wrong
  assert.equal(await fx.store.countRecentSubmissions(1, 0), 3, 'team 1 made three attempts');
  assert.equal(await fx.store.countRecentSubmissions(2, 0), 1, 'team 2 made one attempt');
  const accepted = await fx.store.acceptedCountForFlag((await fx.store.findFlag(fx.round.id, FLAG_ON_TEAM_2)).id);
  assert.equal(accepted, 1, 'only one accepted row per flag');
});
