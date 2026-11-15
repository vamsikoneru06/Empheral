'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const os = require('node:os');
const { createApp } = require('../src/app');
const { createMemoryStore } = require('../src/store');
const { createOrchestrator } = require('../../orchestrator/src');
const { TOKENS } = require('./fixture');

const PASS_REPORT = JSON.stringify({ ran_at: '2026-11-02T08:52:00.000Z', pairs_tested: 99, violations: 0, passed: true });

function setup(runner) {
  const store = createMemoryStore();
  for (const id of [1, 2]) {
    store.upsertTeam({
      id,
      name: `Team ${id}`,
      pod_vlan: 100 + id,
      target_vlan: 200 + id,
      pod_subnet: `10.20.${id}.0/26`,
      target_subnet: `10.40.${id}.0/26`,
    });
  }
  const verifier = { run: runner };
  const orchestrator = createOrchestrator({ store, runVerifier: runner, imageDir: os.tmpdir() });
  return { store, orchestrator, verifier };
}

const okRunner = async () => ({ exitCode: 0, stdout: PASS_REPORT, stderr: '' });

async function withServer(ctx, fn) {
  const app = createApp({
    store: ctx.store,
    tokens: TOKENS,
    orchestrator: ctx.orchestrator,
    verifier: ctx.verifier,
  });
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

async function call(base, method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  return { status: res.status, body: await res.json() };
}

const ROUND = {
  name: 'Round 4',
  image_set: 'golden-v3',
  starts_at: '2026-11-03T09:00:00Z',
  duration_minutes: 180,
  team_ids: [1, 2],
};

test('admin routes need an admin token', async () => {
  await withServer(setup(okRunner), async (base) => {
    assert.equal((await call(base, 'POST', '/api/rounds', { body: ROUND })).status, 401);
    const asCompetitor = await call(base, 'POST', '/api/rounds', { token: 'tok-team-1', body: ROUND });
    assert.equal(asCompetitor.status, 403);
  });
});

test('admin creates a round and provisions it', async () => {
  await withServer(setup(okRunner), async (base) => {
    const created = await call(base, 'POST', '/api/rounds', { token: 'tok-admin', body: ROUND });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'planned');

    const provisioned = await call(base, 'POST', `/api/rounds/${created.body.id}/provision`, { token: 'tok-admin' });
    assert.equal(provisioned.status, 202);
    assert.equal(provisioned.body.job_id, `provision-${created.body.id}`);
  });
});

test('reset on a planned round is refused with 409', async () => {
  await withServer(setup(okRunner), async (base) => {
    const created = await call(base, 'POST', '/api/rounds', { token: 'tok-admin', body: ROUND });
    const reset = await call(base, 'POST', `/api/rounds/${created.body.id}/reset`, { token: 'tok-admin' });
    assert.equal(reset.status, 409);
    assert.equal(typeof reset.body.error.code, 'string');
  });
});

test('an unknown round id is a 404', async () => {
  await withServer(setup(okRunner), async (base) => {
    const res = await call(base, 'POST', '/api/rounds/999/provision', { token: 'tok-admin' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });
});

test('an ad-hoc verification run records a pass', async () => {
  await withServer(setup(okRunner), async (base) => {
    const res = await call(base, 'POST', '/api/verification/run', { token: 'tok-admin' });
    assert.equal(res.status, 202);
    assert.equal(res.body.passed, true);
    assert.equal(res.body.exit_code, 0);
  });
});

test('a failing verifier exit records a fail, even if the report says passed', async () => {
  const runner = async () => ({ exitCode: 1, stdout: PASS_REPORT, stderr: '' });
  await withServer(setup(runner), async (base) => {
    const res = await call(base, 'POST', '/api/verification/run', { token: 'tok-admin' });
    assert.equal(res.status, 202);
    assert.equal(res.body.passed, false);
  });
});

test('a verifier that prints no report is a 502', async () => {
  const runner = async () => ({ exitCode: 2, stdout: 'Traceback: boom', stderr: '' });
  await withServer(setup(runner), async (base) => {
    const res = await call(base, 'POST', '/api/verification/run', { token: 'tok-admin' });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'verifier_failed');
  });
});
