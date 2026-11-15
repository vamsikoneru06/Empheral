'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { createMemoryStore } = require('../src/store');
const { fixture, TOKENS, FLAG_ON_TEAM_2, fakeFlag } = require('./fixture');

async function withServer(fx, fn) {
  const app = createApp({ store: fx.store, tokens: TOKENS, clock: () => fx.clock.now });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function call(base, method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    headers['content-type'] = 'application/json';
    payload = raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  return { status: res.status, body: await res.json() };
}

const submit = (base, token, value) => call(base, 'POST', '/api/submissions', { token, body: { value } });

test('submission rate limit: the 11th submission in a minute gets 429', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    for (let i = 0; i < 10; i += 1) {
      const out = await submit(base, 'tok-team-1', fakeFlag(i));
      assert.equal(out.status, 200);
      assert.equal(out.body.verdict, 'wrong');
    }
    const limited = await submit(base, 'tok-team-1', fakeFlag(10));
    assert.equal(limited.status, 429);
    assert.equal(limited.body.verdict, 'rate_limited');
    assert.equal(limited.body.error.code, 'rate_limited');

    fx.clock.now += 61000;
    const after = await submit(base, 'tok-team-1', fakeFlag(11));
    assert.equal(after.status, 200, 'window has passed');
  });
});

test('the rate limit is per team', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    for (let i = 0; i < 10; i += 1) await submit(base, 'tok-team-1', fakeFlag(i));
    assert.equal((await submit(base, 'tok-team-1', fakeFlag(50))).status, 429);
    assert.equal((await submit(base, 'tok-team-2', fakeFlag(50))).status, 200);
  });
});

test('submission auth: public is 401, judge is 403, bad token is 401', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    assert.equal((await submit(base, undefined, FLAG_ON_TEAM_2)).status, 401);
    assert.equal((await submit(base, 'tok-judge', FLAG_ON_TEAM_2)).status, 403);
    assert.equal((await submit(base, 'not-a-token', FLAG_ON_TEAM_2)).status, 401);
  });
});

test('submission body is validated and malformed JSON is a 400', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    const empty = await call(base, 'POST', '/api/submissions', { token: 'tok-team-1', body: { value: '' } });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'bad_request');
    const broken = await call(base, 'POST', '/api/submissions', { token: 'tok-team-1', raw: '{nope' });
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error.code, 'bad_request');
  });
});

test('accepted submission returns points, bonus and the new score', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    const out = await submit(base, 'tok-team-1', FLAG_ON_TEAM_2);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { verdict: 'accepted', points: 50, bonus_points: 25, first_blood: true, new_score: 75 });
  });
});

test('after the freeze point a valid flag gets verdict expired', async () => {
  const fx = fixture();
  fx.clock.now = Date.parse('2026-11-02T11:46:00Z');
  await withServer(fx, async (base) => {
    const out = await submit(base, 'tok-team-1', FLAG_ON_TEAM_2);
    assert.equal(out.status, 200);
    assert.equal(out.body.verdict, 'expired');
  });
});

test('with no round at all a submission gets 409 round_not_running', async () => {
  const fx = { store: createMemoryStore({ clock: () => 0 }), clock: { now: 0 } };
  await withServer(fx, async (base) => {
    const out = await submit(base, 'tok-team-1', FLAG_ON_TEAM_2);
    assert.equal(out.status, 409);
    assert.equal(out.body.error.code, 'round_not_running');
  });
});

test('a planned round is current, so a submission to it is expired', async () => {
  const fx = fixture({ status: 'planned' });
  await withServer(fx, async (base) => {
    const out = await submit(base, 'tok-team-1', FLAG_ON_TEAM_2);
    assert.equal(out.status, 200);
    assert.equal(out.body.verdict, 'expired');
  });
});

test('leaderboard is public, sums scores and ranks them', async () => {
  const fx = fixture();
  fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 2, kind: 'flag_capture', points: 50, occurred_at: new Date(fx.clock.now) });
  fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 2, kind: 'service_uptime', points: 1, occurred_at: new Date(fx.clock.now) });
  await withServer(fx, async (base) => {
    const out = await call(base, 'GET', '/api/leaderboard');
    assert.equal(out.status, 200);
    assert.equal(out.body.round_id, fx.round.id);
    assert.equal(out.body.frozen, false);
    assert.deepEqual(out.body.teams.map((t) => [t.rank, t.team_id, t.score]), [[1, 2, 51], [2, 1, 0], [3, 3, 0]]);
    assert.equal(out.body.teams[0].services_total, 0, 'no polls recorded yet');
  });
});

test('leaderboard is cached for 2 s', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    const first = await call(base, 'GET', '/api/leaderboard');
    assert.equal(first.body.teams[1].score, 0);
    fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 1, kind: 'flag_capture', points: 50, occurred_at: new Date(fx.clock.now) });
    fx.clock.now += 1000;
    const cached = await call(base, 'GET', '/api/leaderboard');
    assert.equal(cached.body.teams.find((t) => t.team_id === 1).score, 0, 'served from cache');
    fx.clock.now += 2000;
    const fresh = await call(base, 'GET', '/api/leaderboard');
    assert.equal(fresh.body.teams.find((t) => t.team_id === 1).score, 50);
  });
});

test('leaderboard rejects a malformed round_id and unknown rounds', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    assert.equal((await call(base, 'GET', '/api/leaderboard?round_id=abc')).status, 400);
    assert.equal((await call(base, 'GET', '/api/leaderboard?round_id=999')).status, 404);
  });
});

test('current round reports the freeze point and the frozen status after it', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    const running = await call(base, 'GET', '/api/rounds/current');
    assert.equal(running.status, 200);
    assert.equal(running.body.status, 'running');
    assert.equal(running.body.freeze_at, '2026-11-02T11:45:00.000Z');
    assert.equal(running.body.ends_at, '2026-11-02T12:00:00.000Z');
    fx.clock.now = Date.parse('2026-11-02T11:50:00Z');
    const later = await call(base, 'GET', '/api/rounds/current');
    assert.equal(later.body.status, 'frozen');
  });
});

test('team view: competitor sees own team only; public and judge are refused', async () => {
  const fx = fixture();
  fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 1, kind: 'flag_capture', points: 50, occurred_at: new Date(fx.clock.now) });
  await withServer(fx, async (base) => {
    const own = await call(base, 'GET', '/api/teams/1', { token: 'tok-team-1' });
    assert.equal(own.status, 200);
    assert.equal(own.body.score, 50);
    assert.equal(own.body.pod_subnet, '10.20.1.0/26');
    assert.deepEqual(own.body.targets.map((t) => t.role).sort(), ['beacon', 'web']);
    assert.equal((await call(base, 'GET', '/api/teams/2', { token: 'tok-team-1' })).status, 403);
    assert.equal((await call(base, 'GET', '/api/teams/1')).status, 401);
    assert.equal((await call(base, 'GET', '/api/teams/1', { token: 'tok-judge' })).status, 403);
  });
});

test('judge timeline pages with since_seq and rejects non-judge callers', async () => {
  const fx = fixture();
  for (let i = 0; i < 5; i += 1) {
    fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 1, kind: 'service_uptime', points: 1, occurred_at: new Date(fx.clock.now) });
  }
  await withServer(fx, async (base) => {
    assert.equal((await call(base, 'GET', '/api/judge/timeline')).status, 401);
    assert.equal((await call(base, 'GET', '/api/judge/timeline', { token: 'tok-team-1' })).status, 403);

    const page1 = await call(base, 'GET', `/api/judge/timeline?round_id=${fx.round.id}&since_seq=0&limit=2`, { token: 'tok-judge' });
    assert.equal(page1.status, 200);
    assert.deepEqual(page1.body.events.map((e) => e.seq), [1, 2]);
    assert.equal(page1.body.next_seq, 2);

    const page2 = await call(base, 'GET', `/api/judge/timeline?round_id=${fx.round.id}&since_seq=${page1.body.next_seq}&limit=2`, { token: 'tok-judge' });
    assert.deepEqual(page2.body.events.map((e) => e.seq), [3, 4]);

    const page3 = await call(base, 'GET', `/api/judge/timeline?since_seq=${page2.body.next_seq}`, { token: 'tok-admin' });
    assert.deepEqual(page3.body.events.map((e) => e.seq), [5]);
    assert.equal(page3.body.next_seq, 5);

    const empty = await call(base, 'GET', `/api/judge/timeline?since_seq=${page3.body.next_seq}`, { token: 'tok-judge' });
    assert.deepEqual(empty.body.events, []);
    assert.equal(empty.body.next_seq, 5, 'next_seq holds when there is nothing new');

    assert.equal((await call(base, 'GET', '/api/judge/timeline?since_seq=abc', { token: 'tok-judge' })).status, 400);
  });
});

test('adjust writes one score row and one audit row, and both need a note', async () => {
  const fx = fixture();
  fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 2, kind: 'flag_capture', points: 50, occurred_at: new Date(fx.clock.now) });
  await withServer(fx, async (base) => {
    const body = { round_id: fx.round.id, team_id: 2, points: -25, note: 'Out-of-scope attack on judging segment' };
    assert.equal((await call(base, 'POST', '/api/judge/adjust', { token: 'tok-team-1', body })).status, 403);
    assert.equal((await call(base, 'POST', '/api/judge/adjust', { body })).status, 401);

    const noNote = await call(base, 'POST', '/api/judge/adjust', { token: 'tok-judge', body: { ...body, note: '  ' } });
    assert.equal(noNote.status, 400);
    const zero = await call(base, 'POST', '/api/judge/adjust', { token: 'tok-judge', body: { ...body, points: 0 } });
    assert.equal(zero.status, 400);
    const pennies = await call(base, 'POST', '/api/judge/adjust', { token: 'tok-judge', body: { ...body, points: 1.005 } });
    assert.equal(pennies.status, 400);
    const noTeam = await call(base, 'POST', '/api/judge/adjust', { token: 'tok-judge', body: { ...body, team_id: 99 } });
    assert.equal(noTeam.status, 404);
    assert.equal(fx.store.listTimeline(fx.round.id).length, 1, 'rejected requests wrote nothing');
    assert.equal(fx.store.listAudit().length, 0);

    const ok = await call(base, 'POST', '/api/judge/adjust', { token: 'tok-judge', body });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.new_score, 25);

    const events = fx.store.listTimeline(fx.round.id);
    assert.equal(events.length, 2);
    assert.equal(events[1].kind, 'manual_adjust');
    assert.equal(events[1].points, -25);
    assert.equal(events[1].note, 'Out-of-scope attack on judging segment');

    const audit = fx.store.listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'judge.adjust');
    assert.equal(audit[0].subject, 'team:2');
    assert.match(audit[0].actor, /^judge:[0-9a-f]{12}$/);
    assert.ok(!audit[0].actor.includes('tok-judge'), 'raw token never appears in the audit log');
    assert.equal(audit[0].detail.seq, events[1].seq);
  });
});

test('verification latest is admin only and 404s until a run exists', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    assert.equal((await call(base, 'GET', '/api/verification/latest', { token: 'tok-judge' })).status, 403);
    assert.equal((await call(base, 'GET', '/api/verification/latest')).status, 401);
    assert.equal((await call(base, 'GET', '/api/verification/latest', { token: 'tok-admin' })).status, 404);

    fx.store.insertVerificationRun({
      round_id: fx.round.id, passed: true, pairs_tested: 99, violations: 0,
      matrix_json: { assertions: { team_to_team_denied: true } },
      ran_at: new Date(fx.clock.now),
    });
    const out = await call(base, 'GET', '/api/verification/latest', { token: 'tok-admin' });
    assert.equal(out.status, 200);
    assert.equal(out.body.passed, true);
    assert.deepEqual(out.body.assertions, { team_to_team_denied: true });
    assert.equal(out.body.matrix_json, undefined, 'the matrix is not echoed');
  });
});

test('unknown endpoints get the error envelope', async () => {
  const fx = fixture();
  await withServer(fx, async (base) => {
    const out = await call(base, 'GET', '/api/nope');
    assert.equal(out.status, 404);
    assert.equal(out.body.error.code, 'not_found');
  });
});
