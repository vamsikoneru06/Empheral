'use strict';

// Runs only when MYSQL_URL is set, for example mysql://user:pass@127.0.0.1:3306/cyberrange.
// It creates a scratch database (cr_test_<pid>_<time>), applies db/001_init.sql to it without
// the CREATE USER and GRANT/REVOKE lines, runs a scenario, and drops only that scratch database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MYSQL_URL = process.env.MYSQL_URL;
const SQL_FILE = path.join(__dirname, '..', '..', 'db', '001_init.sql');
const START = '2026-11-02T09:00:00.000Z';
const FLAG_ON_TEAM_2 = 'b'.repeat(64);

test('MySQL store: scenario against a scratch database', { skip: MYSQL_URL ? false : 'MYSQL_URL not set' }, async () => {
  const mysql = require('mysql2/promise');
  const { createMysqlStore } = require('../src/store');
  const { createSubmissionService } = require('../src/submissions');
  const { createPoller } = require('../src/poller');

  const dbName = `cr_test_${process.pid}_${Date.now()}`;
  const scratchUrl = MYSQL_URL.replace(/\/[^/?]*(\?.*)?$/, `/${dbName}$1`);
  assert.notEqual(scratchUrl, MYSQL_URL, 'MYSQL_URL must name a database in its path');

  const admin = await mysql.createConnection({ uri: MYSQL_URL.replace(/\/[^/?]*(\?.*)?$/, '/$1'), multipleStatements: true });
  let pool = null;
  try {
    await admin.query(`CREATE DATABASE \`${dbName}\``);
    const schema = fs.readFileSync(SQL_FILE, 'utf8').split('\n')
      .filter((line) => !/^(CREATE DATABASE|USE |CREATE USER|GRANT |REVOKE )/.test(line))
      .join('\n');
    await admin.query(`USE \`${dbName}\`;\n${schema}`);

    pool = mysql.createPool({ uri: scratchUrl, timezone: 'Z', connectionLimit: 4 });
    const store = createMysqlStore(pool);

    for (const id of [1, 2, 3]) {
      await store.upsertTeam({
        id, name: `Team ${id}`, pod_vlan: 100 + id, target_vlan: 200 + id,
        pod_subnet: `10.20.${id}.0/26`, target_subnet: `10.40.${id}.0/26`,
      });
    }
    const round = await store.createRound({
      name: 'Round 1', image_set: 'golden-v3', starts_at: START, duration_minutes: 180,
      freeze_minutes: 15, team_ids: [1, 2, 3],
    });
    assert.deepEqual(round.team_ids, [1, 2, 3]);
    assert.equal(round.ends_at, '2026-11-02T12:00:00.000Z');
    await store.setRoundStatus(round.id, 'running');

    const targets = [];
    for (const team of [1, 2, 3]) {
      targets.push({ team_id: team, role: 'beacon', ip_address: `10.40.${team}.60`, image_hash: 'd'.repeat(64) });
    }
    await store.insertTargets(round.id, targets);
    await store.insertFlags(round.id, [{ team_id: 2, target_role: 'web', value: FLAG_ON_TEAM_2 }]);

    const now = Date.parse('2026-11-02T09:05:00Z');
    const svc = createSubmissionService({ store, clock: () => now });
    const first = await svc.submit({ teamId: 1, value: FLAG_ON_TEAM_2, sourceIp: '10.20.1.10' });
    assert.deepEqual(first, { verdict: 'accepted', points: 50, bonus_points: 25, first_blood: true, new_score: 75 });
    assert.equal((await svc.submit({ teamId: 1, value: FLAG_ON_TEAM_2, sourceIp: '10.20.1.10' })).verdict, 'duplicate');
    assert.equal((await svc.submit({ teamId: 2, value: FLAG_ON_TEAM_2, sourceIp: '10.20.2.10' })).verdict, 'self_submit');

    let board = await store.leaderboard(round.id);
    assert.deepEqual(board.map((r) => [r.team_id, r.score]), [[1, 75], [2, 0], [3, 0]]);

    const timeline = await store.listTimeline(round.id, 0, 10);
    assert.deepEqual(timeline.map((e) => e.kind), ['flag_capture', 'first_blood']);
    assert.ok(timeline[1].seq > timeline[0].seq, 'seq is monotonic');
    assert.equal(timeline[0].points, 50);

    // A poll and its uptime event, through the poller.
    const poller = createPoller({
      store, probe: async (ip) => ip === '10.40.3.60', beaconPort: 8080,
      clock: () => now, log: { error() {} },
    });
    assert.deepEqual(await poller.pollOnce(), { polled: 3, up: 1 });
    const polls = await store.latestPolls(round.id);
    assert.equal(polls.filter((p) => p.reachable).length, 1);

    // Manual adjustment: one score row and one audit row in one transaction.
    await store.transaction(async (tx) => {
      await tx.appendScoreEvent({ round_id: round.id, team_id: 1, kind: 'manual_adjust', points: -25, note: 'dispute' });
      await tx.appendAudit({ actor: 'judge:test', action: 'judge.adjust', subject: 'team:1', detail: { points: -25 } });
    });
    board = await store.leaderboard(round.id);
    // Team 1 owns no reachable beacon, so the +1 uptime point went to team 3: 75 - 25 = 50.
    assert.equal(board.find((r) => r.team_id === 1).score, 75 - 25);
    const audit = await store.listAudit();
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].detail, { points: -25 });

    // A failed transaction leaves nothing behind.
    await assert.rejects(store.transaction(async (tx) => {
      await tx.appendScoreEvent({ round_id: round.id, team_id: 2, kind: 'penalty', points: -99, note: 'x' });
      throw new Error('boom');
    }), /boom/);
    assert.equal((await store.listTimeline(round.id, 0, 100)).length, 4);

    await store.insertVerificationRun({
      round_id: round.id, passed: true, pairs_tested: 99, violations: 0,
      matrix_json: { assertions: { team_to_team_denied: true } }, ran_at: new Date(now),
    });
    const run = await store.latestVerificationRun();
    assert.equal(run.passed, true);
    assert.deepEqual(run.matrix_json.assertions, { team_to_team_denied: true });
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``).catch(() => {});
    await admin.end();
  }
});
