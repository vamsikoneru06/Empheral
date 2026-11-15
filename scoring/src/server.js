#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { loadTokens } = require('./auth');
const { createApp } = require('./app');
const { createPoller, tcpProbe } = require('./poller');
const { createMemoryStore, createMysqlStore } = require('./store');
const { createOrchestrator, defaultVerifierRunner, PROJECT_ROOT } = require('../../orchestrator/src');

async function main(env = process.env) {
  const cfg = loadConfig(env);
  const tokens = loadTokens(cfg.tokensFile);

  let store;
  let pool = null;
  if (cfg.mysqlUrl) {
    const mysql = require('mysql2/promise');
    pool = mysql.createPool({ uri: cfg.mysqlUrl, timezone: 'Z', connectionLimit: 10 });
    store = createMysqlStore(pool);
  } else {
    console.warn('scoring: MYSQL_URL not set. Using the in-memory store; scored events are lost on restart.');
    store = createMemoryStore();
  }

  const orchestrator = createOrchestrator({ store });
  const verifier = { run: () => defaultVerifierRunner({ root: PROJECT_ROOT }) };
  const app = createApp({ store, tokens, orchestrator, verifier });
  const server = app.listen(cfg.port, cfg.bind, () => {
    console.log(`scoring: listening on ${cfg.bind}:${cfg.port}`);
  });

  let poller = null;
  if (cfg.pollerEnabled) {
    poller = createPoller({ store, probe: tcpProbe(), beaconPort: cfg.beaconPort });
    poller.start(cfg.pollIntervalMs);
  }

  const shutdown = () => {
    if (poller) poller.stop();
    server.close(() => {
      if (pool) pool.end().finally(() => process.exit(0));
      else process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('scoring: failed to start', err && err.message);
    process.exit(1);
  });
}

module.exports = { main };
