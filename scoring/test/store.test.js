'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMemoryStore, createMysqlStore } = require('../src/store');
const { fixture } = require('./fixture');

const SCORING = path.join(__dirname, '..');
const SQL_FILE = path.join(SCORING, '..', 'db', '001_init.sql');
const LEDGER_TABLES = ['score_events', 'audit_log'];

// A pool stand-in: the method-name check never runs a query.
const stubPool = { query() { throw new Error('not used'); }, getConnection() { throw new Error('not used'); } };

test('neither store exposes update or delete, and ledger methods are append or list only', () => {
  for (const store of [createMemoryStore(), createMysqlStore(stubPool)]) {
    const names = Object.keys(store);
    const banned = names.filter((n) => /update|delete|remove|destroy|truncate|drop|modify|edit|replace/i.test(n));
    assert.deepEqual(banned, [], `forbidden method names: ${banned.join(', ')}`);
    const ledger = names.filter((n) => /Score|Audit/.test(n));
    for (const n of ledger) {
      assert.match(n, /^(append|list)/, `${n} must be an append or a read`);
    }
    assert.ok(names.includes('appendScoreEvent') && names.includes('appendAudit'));
  }
});

test('both stores expose the same method set', () => {
  const memory = Object.keys(createMemoryStore()).sort();
  const mysql = Object.keys(createMysqlStore(stubPool)).sort();
  assert.deepEqual(mysql, memory);
});

test('no store source file issues UPDATE or DELETE against a ledger table', () => {
  const dir = path.join(SCORING, 'src', 'store');
  for (const file of fs.readdirSync(dir)) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const table of LEDGER_TABLES) {
      const hit = new RegExp(`(UPDATE\\s+${table}\\b|DELETE\\s+FROM\\s+${table}\\b|TRUNCATE\\s+${table}\\b)`, 'i');
      assert.ok(!hit.test(sql), `${file} must not UPDATE/DELETE ${table}`);
    }
  }
});

test('migration revokes UPDATE and DELETE on the ledgers and grants no database-wide UPDATE or DELETE', () => {
  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  for (const table of LEDGER_TABLES) {
    assert.match(sql, new RegExp(`REVOKE UPDATE, DELETE ON cyberrange\\.${table}\\s+FROM`));
  }
  const dbWide = sql.split('\n').filter((line) => /^GRANT/i.test(line)
    && /\b(UPDATE|DELETE)\b/i.test(line) && /ON cyberrange\.\*/i.test(line));
  assert.deepEqual(dbWide, [], 'a database-level UPDATE or DELETE grant cannot be narrowed by table REVOKE');
});

test('leaderboard is SUM(points) at read time, ties go to the earlier last event', async () => {
  const fx = fixture();
  const at = (iso) => new Date(iso);
  fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 1, kind: 'flag_capture', points: 50, occurred_at: at('2026-11-02T09:10:00Z') });
  fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 1, kind: 'penalty', points: -10, occurred_at: at('2026-11-02T09:11:00Z') });
  fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 2, kind: 'flag_capture', points: 50, occurred_at: at('2026-11-02T09:20:00Z') });
  const board = await fx.store.leaderboard(fx.round.id);
  assert.deepEqual(board.map((r) => [r.team_id, r.score]), [[2, 50], [1, 40], [3, 0]]);

  // Team 1 reaches 50 with a last event at 09:30. Team 2 also has 50 but its last event
  // is at 09:20, so team 2 keeps first place.
  fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 1, kind: 'service_uptime', points: 10, occurred_at: at('2026-11-02T09:30:00Z') });
  const tied = await fx.store.leaderboard(fx.round.id);
  assert.deepEqual(tied.map((r) => [r.team_id, r.score]), [[2, 50], [1, 50], [3, 0]]);
  assert.equal(tied[2].last_event, null, 'a team with no events sorts last');
});

test('ledger seq is monotonic and gapless per round', () => {
  const fx = fixture();
  const other = fx.store.createRound({
    name: 'Round 2', image_set: 'golden-v3', starts_at: '2026-11-03T09:00:00Z',
    duration_minutes: 60, team_ids: [1, 2, 3],
  });
  const ev = (round_id) => fx.store.appendScoreEvent({ round_id, team_id: 1, kind: 'service_uptime', points: 1 });
  assert.equal(ev(fx.round.id).seq, 1);
  assert.equal(ev(other.id).seq, 1);
  assert.equal(ev(fx.round.id).seq, 2);
  assert.equal(ev(other.id).seq, 2);
  assert.equal(ev(fx.round.id).seq, 3);
  assert.deepEqual(fx.store.listTimeline(fx.round.id).map((e) => e.seq), [1, 2, 3]);
});

test('timeline paging returns events after since_seq in order, capped by limit', () => {
  const fx = fixture();
  for (let i = 0; i < 4; i += 1) fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 2, kind: 'service_uptime', points: 1 });
  assert.deepEqual(fx.store.listTimeline(fx.round.id, 1).map((e) => e.seq), [2, 3, 4]);
  assert.deepEqual(fx.store.listTimeline(fx.round.id, 0, 2).map((e) => e.seq), [1, 2]);
  assert.deepEqual(fx.store.listTimeline(fx.round.id, 4).map((e) => e.seq), []);
});

test('a transaction that throws leaves no partial writes', async () => {
  const fx = fixture();
  await assert.rejects(fx.store.transaction(async (tx) => {
    await tx.appendScoreEvent({ round_id: fx.round.id, team_id: 1, kind: 'manual_adjust', points: 5, note: 'x' });
    await tx.appendAudit({ actor: 'judge:test', action: 'judge.adjust', subject: 'team:1', detail: {} });
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(fx.store.listTimeline(fx.round.id), []);
  assert.deepEqual(fx.store.listAudit(), []);
});

test('a score event for an unknown team or round is refused', () => {
  const fx = fixture();
  assert.throws(() => fx.store.appendScoreEvent({ round_id: fx.round.id, team_id: 99, kind: 'penalty', points: -1 }));
  assert.throws(() => fx.store.appendScoreEvent({ round_id: 99, team_id: 1, kind: 'penalty', points: -1 }));
});

test('listFlags returns one round\'s flags; latestVerificationRun honours its round argument', () => {
  const fx = fixture();
  const other = fx.store.createRound({
    name: 'Round 2', image_set: 'golden-v3', starts_at: '2026-11-03T09:00:00Z',
    duration_minutes: 60, team_ids: [1, 2, 3],
  });
  fx.store.insertFlags(other.id, [{ team_id: 1, target_role: 'db', value: 'c'.repeat(64) }]);
  assert.deepEqual(fx.store.listFlags(fx.round.id).map((f) => f.team_id), [1, 2]);
  assert.deepEqual(fx.store.listFlags(other.id).map((f) => f.target_role), ['db']);

  const run = (round_id, ran_at) => fx.store.insertVerificationRun({
    round_id, passed: true, pairs_tested: 1, violations: 0, matrix_json: {}, ran_at: new Date(ran_at),
  });
  run(fx.round.id, '2026-11-02T08:00:00Z');
  run(other.id, '2026-11-02T09:00:00Z');
  assert.equal(fx.store.latestVerificationRun().round_id, other.id, 'no argument: latest overall');
  assert.equal(fx.store.latestVerificationRun(fx.round.id).round_id, fx.round.id, 'argument: that round only');
  assert.equal(fx.store.latestVerificationRun(999), null);
});
