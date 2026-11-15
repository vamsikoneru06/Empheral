'use strict';

// Environment settings for the scoring service.
//   SCORING_BIND      listen address. Default 127.0.0.1. In deployment, the scoring VLAN address only.
//   PORT              listen port. Default 8080.
//   TOKENS_FILE       JSON file of bearer tokens (see src/auth.js). Unset means no protected access.
//   MYSQL_URL         mysql://user:pass@host/cyberrange. Unset means the in-memory store (not durable).
//   POLLER_ENABLED    "false" disables the beacon poller.
//   POLL_INTERVAL_MS  beacon poll interval. Default 30000 (FR-4.1).
//   BEACON_PORT       TCP port probed on each flag beacon. Default 8080 (assumption: the docs give no port).

function loadConfig(env) {
  return {
    bind: env.SCORING_BIND || '127.0.0.1',
    port: Number(env.PORT || 8080),
    tokensFile: env.TOKENS_FILE || null,
    mysqlUrl: env.MYSQL_URL || null,
    pollerEnabled: env.POLLER_ENABLED !== 'false',
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 30000),
    beaconPort: Number(env.BEACON_PORT || 8080),
  };
}

module.exports = { loadConfig };
