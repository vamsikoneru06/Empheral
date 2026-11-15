'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, newRound, fakeRunner, PASS, FAIL, IMAGE_DIR } = require('../support/harness');
const { createOrchestrator, MockHypervisor, OrchestratorError, environmentsIdentical } = require('../src/index');
const { createMemoryStore } = require('../../scoring/src/store');

function expectCode(expected) {
  return (err) => err instanceof OrchestratorError && err.code === expected;
}

async function provisioned(opts = {}) {
  const ctx = build(opts);
  const round = await newRound(ctx.orch);
  await ctx.orch.provision(round.id);
  return { ...ctx, round };
}

test('createRound writes a planned round and rejects a path-escaping image set', async () => {
  const { orch, raw } = build();
  const round = await newRound(orch);
  assert.equal(round.status, 'planned');
  assert.deepEqual(round.team_ids, [1, 2, 3, 4]);
  assert.equal(raw.getRound(round.id).image_set, 'golden-test');
  await assert.rejects(() => newRound(orch, { image_set: '../escape' }), expectCode('invalid_input'));
});

test('provision: planned -> verifying, six targets per team, five flags per team, identical environments', async () => {
  const { orch, round, hypervisor, raw } = await provisioned();
  const got = raw.getRound(round.id);
  assert.equal(got.status, 'verifying');

  const targets = raw.listTargets(round.id);
  assert.equal(targets.length, 24);
  assert.equal(environmentsIdentical(targets).identical, true);
  assert.equal(hypervisor.calls.filter((c) => c.op === 'deploy').length, 24);

  const beacon = targets.find((t) => t.role === 'beacon');
  assert.equal(hypervisor.injectedFlag(beacon.ip_address), null, 'beacons carry no flag');
  const web = targets.find((t) => t.team_id === 1 && t.role === 'web');
  assert.match(hypervisor.injectedFlag(web.ip_address), /^[0-9a-f]{64}$/);

  const status = await orch.status(round.id);
  assert.equal(status.round.status, 'verifying');
  assert.equal(status.environments.identical, true);
  assert.equal(status.targets, 24);
});

test('provision: the stored flags are unique, 64-hex, and match what was injected', async () => {
  const { round, raw, hypervisor } = await provisioned();
  const targets = raw.listTargets(round.id);
  const values = [];
  for (const t of targets.filter((x) => x.role !== 'beacon')) {
    values.push(hypervisor.injectedFlag(t.ip_address));
  }
  assert.equal(values.length, 20);
  assert.equal(new Set(values).size, 20);
  for (const v of values) assert.match(v, /^[0-9a-f]{64}$/);
});

test('provision: a missing golden image is marked as a stub', async () => {
  const ctx = build({ imageDir: '/nonexistent-dir-for-test' });
  const round = await newRound(ctx.orch);
  const result = await ctx.orch.provision(round.id);
  assert.equal(result.image.stub, true);
});

test('provision: refused from any state but planned (409), and that refusal is audited', async () => {
  const { orch, round, audits } = await provisioned();
  await assert.rejects(() => orch.provision(round.id), expectCode('illegal_transition'));
  const last = audits[audits.length - 1];
  assert.equal(last.action, 'round.provision');
  assert.equal(last.detail.outcome, 'refused');
});

test('gate: a failing verifier run blocks the round and records the run as failed', async () => {
  const { orch, round, raw } = await provisioned({ runner: fakeRunner(FAIL) });
  const result = await orch.verify(round.id);
  assert.equal(result.passed, false);
  assert.equal(result.status, 'blocked');
  assert.equal(raw.getRound(round.id).status, 'blocked');
  const run = raw.latestVerificationRun();
  assert.equal(run.passed, false);
  assert.equal(run.violations, 3);
});

test('gate: BLOCKED rounds cannot start', async () => {
  const { orch, round } = await provisioned({ runner: fakeRunner(FAIL) });
  await orch.verify(round.id);
  await assert.rejects(() => orch.start(round.id), expectCode('illegal_transition'));
});

test('gate: a passing verifier run moves the round to ready, and start moves it to running', async () => {
  const { orch, round, raw } = await provisioned({ runner: fakeRunner(PASS) });
  const result = await orch.verify(round.id);
  assert.equal(result.passed, true);
  assert.equal(raw.getRound(round.id).status, 'ready');
  await orch.start(round.id);
  assert.equal(raw.getRound(round.id).status, 'running');
});

test('gate: start refuses when the latest run failed even if the status says ready (FR-5.7)', async () => {
  const { orch, round, raw } = await provisioned({ runner: fakeRunner(FAIL) });
  await orch.verify(round.id); // round is blocked, failed run recorded
  raw.setRoundStatus(round.id, 'ready'); // simulate a status that got out of step with the evidence
  await assert.rejects(() => orch.start(round.id), expectCode('verification_required'));
  assert.equal(raw.getRound(round.id).status, 'ready');
});

test('gate: start refuses when the only passing run belongs to another round', async () => {
  const ctx = build({ runner: fakeRunner(PASS) });
  const first = await newRound(ctx.orch);
  const second = await newRound(ctx.orch);
  await ctx.orch.provision(first.id);
  await ctx.orch.verify(first.id); // passing run for round 1
  await ctx.orch.provision(second.id);
  ctx.raw.setRoundStatus(second.id, 'ready');
  await assert.rejects(() => ctx.orch.start(second.id), expectCode('verification_required'));
});

test('verify is only accepted from verifying (409 otherwise)', async () => {
  const { orch } = build();
  const round = await newRound(orch);
  await assert.rejects(() => orch.verify(round.id), expectCode('illegal_transition'));
});

test('reset is refused with 409 round_not_running while the round is running', async () => {
  const { orch, round, audits } = await provisioned({ runner: fakeRunner(PASS) });
  await orch.verify(round.id);
  await orch.start(round.id);
  await assert.rejects(() => orch.reset(round.id), expectCode('round_not_running'));
  const last = audits[audits.length - 1];
  assert.equal(last.action, 'round.reset');
  assert.equal(last.detail.outcome, 'refused');
});

test('reset is refused from frozen (illegal) and from planned (illegal, nothing to restore)', async () => {
  const { orch, round } = await provisioned({ runner: fakeRunner(PASS) });
  await orch.verify(round.id);
  await orch.start(round.id);
  await orch.freeze(round.id);
  await assert.rejects(() => orch.reset(round.id), expectCode('illegal_transition'));

  const other = build();
  const planned = await newRound(other.orch);
  await assert.rejects(() => other.orch.reset(planned.id), expectCode('illegal_transition'));
});

test('reset restores tampered targets, re-injects flags and returns the round to verifying', async () => {
  const { orch, round, hypervisor, raw } = await provisioned({ runner: fakeRunner(FAIL) });
  await orch.verify(round.id); // blocked
  const web = raw.listTargets(round.id).find((t) => t.team_id === 2 && t.role === 'web');
  hypervisor.tamper(web.ip_address, 'f'.repeat(64));

  const result = await orch.reset(round.id);
  assert.equal(result.status, 'verifying');
  assert.equal(result.mismatches.length, 0);
  assert.equal(raw.getRound(round.id).status, 'verifying');
  assert.equal(await hypervisor.hash(web), web.image_hash);
  assert.match(hypervisor.injectedFlag(web.ip_address), /^[0-9a-f]{64}$/);
});

test('reset with a hash that cannot be restored leaves the round in provisioning', async () => {
  const hypervisor = new MockHypervisor();
  const { orch, round, raw } = await provisioned({ hypervisor, runner: fakeRunner(FAIL) });
  await orch.verify(round.id); // blocked
  const web = raw.listTargets(round.id).find((t) => t.team_id === 1 && t.role === 'web');
  // Break restore so the disk stays wrong after it runs.
  hypervisor.restore = async (target) => {
    hypervisor.calls.push({ op: 'restore', ip_address: target.ip_address, control: hypervisor.controlHost });
  };
  hypervisor.tamper(web.ip_address, '0'.repeat(64));

  const result = await orch.reset(round.id);
  assert.equal(result.status, 'provisioning');
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].ip_address, web.ip_address);
  assert.equal(raw.getRound(round.id).status, 'provisioning');
});

test('reset works from closed as well, so a round can be replayed', async () => {
  const { orch, round, raw } = await provisioned({ runner: fakeRunner(PASS) });
  await orch.verify(round.id);
  await orch.start(round.id);
  await orch.freeze(round.id);
  await orch.close(round.id);
  const result = await orch.reset(round.id);
  assert.equal(result.status, 'verifying');
  assert.equal(raw.getRound(round.id).status, 'verifying');
});

test('reset fails fast, changing nothing, on a store without listFlags', async () => {
  const store = createMemoryStore();
  delete store.listFlags; // simulate a store with no flag read-back
  for (const id of [1, 2]) {
    store.upsertTeam({ id, name: `T${id}`, pod_vlan: 100 + id, target_vlan: 200 + id,
      pod_subnet: `10.20.${id}.0/26`, target_subnet: `10.40.${id}.0/26` });
  }
  const hypervisor = new MockHypervisor();
  const orch = createOrchestrator({ store, hypervisor, runVerifier: fakeRunner(FAIL), imageDir: IMAGE_DIR });
  const round = await orch.createRound({ name: 'r', image_set: 'golden-test', team_ids: [1, 2] });
  await orch.provision(round.id);
  await orch.verify(round.id); // blocked
  const callsBefore = hypervisor.calls.length;
  await assert.rejects(() => orch.reset(round.id), expectCode('store_unsupported'));
  assert.equal(store.getRound(round.id).status, 'blocked');
  assert.equal(hypervisor.calls.length, callsBefore, 'no hypervisor call was made');
});

test('every admin action writes exactly one audit row', async () => {
  const ctx = build({ runner: fakeRunner(PASS) });
  const round = await newRound(ctx.orch);
  await ctx.orch.provision(round.id);
  await ctx.orch.verify(round.id);
  await ctx.orch.start(round.id);
  await ctx.orch.freeze(round.id);
  await ctx.orch.close(round.id);
  await ctx.orch.reset(round.id); // closed -> provisioning -> verifying
  await ctx.orch.status(round.id); // read: writes no audit row

  const actions = ctx.audits.map((a) => a.action);
  assert.deepEqual(actions, [
    'round.create', 'round.provision', 'round.verify', 'round.start',
    'round.freeze', 'round.close', 'round.reset',
  ]);
  for (const row of ctx.audits) assert.equal(row.actor, 'orchestrator');
  assert.equal(ctx.audits.find((a) => a.action === 'round.verify').detail.outcome, 'ok');
});

test('a refused admin action is audited with its code', async () => {
  const ctx = build();
  const round = await newRound(ctx.orch);
  await assert.rejects(() => ctx.orch.start(round.id), expectCode('illegal_transition'));
  const row = ctx.audits[ctx.audits.length - 1];
  assert.equal(row.action, 'round.start');
  assert.equal(row.detail.outcome, 'refused');
  assert.equal(row.detail.error, 'illegal_transition');
  assert.equal(row.subject, `round:${round.id}`);
});

test('a provisioning failure blocks the round, and the error is reported', async () => {
  const hypervisor = new MockHypervisor();
  hypervisor.deploy = async () => {
    throw new Error('hypervisor unreachable');
  };
  const ctx = build({ hypervisor });
  const round = await newRound(ctx.orch);
  await assert.rejects(() => ctx.orch.provision(round.id), expectCode('provision_failed'));
  assert.equal(ctx.raw.getRound(round.id).status, 'blocked');
  assert.equal(ctx.audits[ctx.audits.length - 1].detail.outcome, 'failed');
});

test('the lifecycle has no path that skips the gate', async () => {
  const ctx = build();
  const round = await newRound(ctx.orch);
  await assert.rejects(() => ctx.orch.start(round.id), expectCode('illegal_transition'));
  await assert.rejects(() => ctx.orch.freeze(round.id), expectCode('illegal_transition'));
  await assert.rejects(() => ctx.orch.close(round.id), expectCode('illegal_transition'));
});

test('an unknown round is a 404 not_found', async () => {
  const { orch } = build();
  await assert.rejects(() => orch.provision(9999), expectCode('not_found'));
});
