'use strict';

// Shared test fixture (no tests in this file). Two teams, one round, beacon and web targets,
// one planted flag per team. The clock is a plain object so tests can move time.

const { createMemoryStore } = require('../src/store');
const { parseTokens } = require('../src/auth');

const FLAG_ON_TEAM_1 = 'a'.repeat(64);
const FLAG_ON_TEAM_2 = 'b'.repeat(64);
const START = '2026-11-02T09:00:00.000Z';

function teamRow(id) {
  return {
    id,
    name: `Team ${id}`,
    pod_vlan: 100 + id,
    target_vlan: 200 + id,
    pod_subnet: `10.20.${id}.0/26`,
    target_subnet: `10.40.${id}.0/26`,
  };
}

function fixture({ status = 'running', freezeMinutes = 15 } = {}) {
  const clock = { now: Date.parse(START) };
  const store = createMemoryStore({ clock: () => clock.now });
  store.upsertTeam(teamRow(1));
  store.upsertTeam(teamRow(2));
  store.upsertTeam(teamRow(3)); // no planted flag; submits only
  const round = store.createRound({
    name: 'Round 1',
    image_set: 'golden-v3',
    starts_at: START,
    duration_minutes: 180,
    freeze_minutes: freezeMinutes,
    team_ids: [1, 2, 3],
  });
  if (status !== 'planned') store.setRoundStatus(round.id, status);
  const targets = [];
  for (const team of [1, 2, 3]) {
    targets.push({ team_id: team, role: 'web', ip_address: `10.40.${team}.10`, image_hash: 'c'.repeat(64) });
    targets.push({ team_id: team, role: 'beacon', ip_address: `10.40.${team}.60`, image_hash: 'd'.repeat(64) });
  }
  store.insertTargets(round.id, targets);
  store.insertFlags(round.id, [
    { team_id: 1, target_role: 'web', value: FLAG_ON_TEAM_1 },
    { team_id: 2, target_role: 'web', value: FLAG_ON_TEAM_2 },
  ]);
  return { store, clock, round, FLAG_ON_TEAM_1, FLAG_ON_TEAM_2 };
}

const TOKENS = parseTokens({
  'tok-team-1': { role: 'competitor', team_id: 1 },
  'tok-team-2': { role: 'competitor', team_id: 2 },
  'tok-team-3': { role: 'competitor', team_id: 3 },
  'tok-judge': { role: 'judge' },
  'tok-admin': { role: 'admin' },
});

// Distinct, well-formed flag-shaped values that match no planted flag.
const fakeFlag = (i) => String(i).padStart(64, '0');

module.exports = { fixture, TOKENS, FLAG_ON_TEAM_1, FLAG_ON_TEAM_2, fakeFlag, START };
