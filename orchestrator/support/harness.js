'use strict';

// Shared test wiring. Not a test file (lives outside test/, so node --test skips it).
const path = require('node:path');
const { createMemoryStore } = require('../../scoring/src/store');
const { createOrchestrator, MockHypervisor } = require('../src/index');

const IMAGE_DIR = path.join(__dirname, '..', 'fixtures', 'images');
const IMAGE_SET = 'golden-test';
const ROUND_INPUT = {
  name: 'Round 1 - test',
  image_set: IMAGE_SET,
  starts_at: '2026-11-03T09:00:00Z',
  duration_minutes: 180,
};

const PASS = { exitCode: 0, stdout: JSON.stringify({ passed: true, pairs_tested: 396, violations: 0 }), stderr: '' };
const FAIL = { exitCode: 1, stdout: JSON.stringify({ passed: false, pairs_tested: 396, violations: 3 }), stderr: '' };

function fakeRunner(answer) {
  return async () => ({ command: 'fake', ...answer });
}

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

/**
 * The scoring memory store, wrapped so tests can see what the orchestrator wrote.
 * `listFlags` is a test double: the scoring store has no flag read-back yet (see report).
 */
function createTestStore(teams = [1, 2, 3, 4]) {
  const raw = createMemoryStore();
  for (const id of teams) raw.upsertTeam(teamRow(id));
  const audits = [];
  const flagRows = [];
  const store = Object.assign({}, raw, {
    appendAudit(row) {
      audits.push(row);
      return raw.appendAudit(row);
    },
    insertFlags(roundId, rows) {
      for (const r of rows) {
        flagRows.push({ round_id: Number(roundId), team_id: r.team_id, target_role: r.target_role, value: r.value });
      }
      return raw.insertFlags(roundId, rows);
    },
    listFlags(roundId) {
      return flagRows.filter((f) => f.round_id === Number(roundId));
    },
  });
  return { store, raw, audits };
}

function build({ teams, runner = fakeRunner(PASS), hypervisor = new MockHypervisor(), imageDir = IMAGE_DIR } = {}) {
  const { store, raw, audits } = createTestStore(teams);
  const orch = createOrchestrator({ store, hypervisor, runVerifier: runner, imageDir });
  return { store, raw, audits, orch, hypervisor };
}

async function newRound(orch, overrides = {}) {
  return orch.createRound({ ...ROUND_INPUT, team_ids: [1, 2, 3, 4], ...overrides });
}

module.exports = { IMAGE_DIR, IMAGE_SET, PASS, FAIL, fakeRunner, createTestStore, build, newRound };
