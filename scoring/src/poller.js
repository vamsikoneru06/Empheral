'use strict';

// Flag-beacon poller. Outbound only: it opens TCP connections to target beacons and
// never binds a listener. The probe is injected so tests can replace the network.

const net = require('node:net');
const rules = require('./rules');
const { effectiveStatus } = require('./rounds');

// Default probe: TCP connect to ip:port with a timeout. Resolves true when the connect succeeds.
function tcpProbe({ timeoutMs = 2000 } = {}) {
  return (ip, port) => new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function createPoller({ store, probe, beaconPort, clock = Date.now, uptimePoints = rules.UPTIME_POINTS_PER_POLL, log = console }) {
  let timer = null;
  let busy = false;

  // One cycle: poll every running round's beacons. Each poll row and its uptime event
  // commit together, so a reachable poll always has its score event.
  async function pollOnce() {
    const round = await store.getCurrentRound();
    if (!round || effectiveStatus(round, clock()) !== 'running') return { polled: 0, up: 0 };

    const beacons = (await store.listTargets(round.id)).filter((t) => t.role === 'beacon');
    let up = 0;
    for (const beacon of beacons) {
      const started = performance.now();
      let reachable = false;
      try {
        reachable = Boolean(await probe(beacon.ip_address, beaconPort));
      } catch {
        reachable = false;
      }
      const latency = reachable ? Math.round(performance.now() - started) : null;
      const polledAt = new Date(clock());
      await store.transaction(async (tx) => {
        const poll = await tx.recordPoll({
          round_id: round.id,
          team_id: beacon.team_id,
          target_role: 'beacon',
          reachable,
          latency_ms: latency,
          polled_at: polledAt,
        });
        if (reachable) {
          await tx.appendScoreEvent({
            round_id: round.id,
            team_id: beacon.team_id,
            kind: 'service_uptime',
            points: uptimePoints,
            ref_id: poll.id,
            occurred_at: polledAt,
          });
        }
      });
      if (reachable) up += 1;
    }
    return { polled: beacons.length, up };
  }

  function start(intervalMs) {
    stop();
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      pollOnce()
        .catch((err) => log.error('poller: cycle failed', err && err.message))
        .finally(() => { busy = false; });
    }, intervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { pollOnce, start, stop };
}

module.exports = { createPoller, tcpProbe };
