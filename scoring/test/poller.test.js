'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { createPoller, tcpProbe } = require('../src/poller');
const { loadConfig } = require('../src/config');
const { fixture } = require('./fixture');

const silent = { error() {} };

test('a poll is recorded for every beacon; uptime is scored only for reachable beacons', async () => {
  const fx = fixture();
  const probe = async (ip) => ip === '10.40.1.60';
  const poller = createPoller({ store: fx.store, probe, beaconPort: 8080, clock: () => fx.clock.now, log: silent });
  assert.deepEqual(await poller.pollOnce(), { polled: 3, up: 1 });

  const polls = await fx.store.latestPolls(fx.round.id);
  assert.equal(polls.length, 3);
  assert.deepEqual(polls.map((p) => [p.team_id, p.reachable]), [[1, true], [2, false], [3, false]]);

  const board = await fx.store.leaderboard(fx.round.id);
  assert.deepEqual(board.map((r) => [r.team_id, r.score]), [[1, 1], [2, 0], [3, 0]]);
  const timeline = fx.store.listTimeline(fx.round.id);
  assert.deepEqual(timeline.map((e) => e.kind), ['service_uptime']);
  assert.equal(timeline[0].ref_id, polls[0].id, 'the score event points at its poll row');
});

test('the probe is called with the beacon address and port', async () => {
  const fx = fixture();
  const calls = [];
  const poller = createPoller({
    store: fx.store,
    probe: async (ip, port) => { calls.push([ip, port]); return true; },
    beaconPort: 9100,
    clock: () => fx.clock.now,
    log: silent,
  });
  await poller.pollOnce();
  assert.deepEqual(calls, [['10.40.1.60', 9100], ['10.40.2.60', 9100], ['10.40.3.60', 9100]]);
});

test('a probe that throws counts as unreachable and the cycle continues', async () => {
  const fx = fixture();
  const poller = createPoller({
    store: fx.store,
    probe: async (ip) => { if (ip === '10.40.1.60') throw new Error('boom'); return true; },
    beaconPort: 8080,
    clock: () => fx.clock.now,
    log: silent,
  });
  assert.deepEqual(await poller.pollOnce(), { polled: 3, up: 2 });
});

test('no polls happen when the round is not running', async () => {
  const fx = fixture({ status: 'planned' });
  let probed = false;
  const poller = createPoller({
    store: fx.store, probe: async () => { probed = true; return true; }, beaconPort: 8080,
    clock: () => fx.clock.now, log: silent,
  });
  assert.deepEqual(await poller.pollOnce(), { polled: 0, up: 0 });
  assert.equal(probed, false);
});

test('the poller module never binds a listener', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'poller.js'), 'utf8');
  assert.ok(!/\.listen\s*\(/.test(source), 'poller must not call listen()');
  assert.ok(!/createServer/.test(source), 'poller must not create a server');
});

test('tcpProbe reports true for an open port and false for a closed one', async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const open = server.address().port;
  try {
    const probe = tcpProbe({ timeoutMs: 1000 });
    assert.equal(await probe('127.0.0.1', open), true);
  } finally {
    server.close();
  }
  // The port was just released, so connecting to it is refused.
  assert.equal(await tcpProbe({ timeoutMs: 1000 })('127.0.0.1', 1), false);
});

test('the listen address defaults to 127.0.0.1 and follows SCORING_BIND', () => {
  assert.equal(loadConfig({}).bind, '127.0.0.1');
  assert.equal(loadConfig({ SCORING_BIND: '10.10.30.10' }).bind, '10.10.30.10');
  assert.equal(loadConfig({}).port, 8080);
  assert.equal(loadConfig({ POLLER_ENABLED: 'false' }).pollerEnabled, false);
});
