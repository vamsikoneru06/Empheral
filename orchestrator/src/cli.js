#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createOrchestrator, OrchestratorError } = require('./index');

const USAGE = 'usage: node orchestrator/src/cli.js provision|reset|verify --round N | status [--round N]';
const COMMANDS = ['provision', 'reset', 'status', 'verify'];
const SCORING_DIR = path.resolve(__dirname, '..', '..', 'scoring');

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(`unknown command ${command}`);
  const opts = { command, round: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--round') {
      opts.round = rest[i + 1];
      i += 1;
    } else if (arg.startsWith('--round=')) {
      opts.round = arg.slice('--round='.length);
    } else {
      throw new UsageError(`unknown argument ${arg}`);
    }
  }
  if (opts.round !== null && opts.round !== undefined) {
    const n = Number(opts.round);
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`--round must be a positive integer, got ${opts.round}`);
    opts.round = n;
  } else {
    opts.round = null;
  }
  if (command !== 'status' && opts.round === null) throw new UsageError(`${command} needs --round N`);
  return opts;
}

/**
 * Opens the scoring MySQL store. Env: MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD,
 * MYSQL_DATABASE. mysql2 comes from scoring's own install (npm install --prefix scoring),
 * so the orchestrator adds no dependency.
 */
function openStore() {
  const { createMysqlStore } = require('../../scoring/src/store');
  if (!process.env.MYSQL_USER) {
    throw new OrchestratorError('store_unsupported', 'set MYSQL_USER (and MYSQL_PASSWORD, MYSQL_DATABASE) for the scoring database', 500);
  }
  const mysql = require(require.resolve('mysql2/promise', { paths: [SCORING_DIR] }));
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'cyberrange',
    timezone: 'Z',
    connectionLimit: 2,
  });
  return { store: createMysqlStore(pool), close: () => pool.end() };
}

async function main(argv, { out = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(e.message);
    err(USAGE);
    return 2;
  }

  let opened;
  try {
    opened = openStore();
  } catch (e) {
    err(e instanceof OrchestratorError ? `${e.code}: ${e.message}` : `error: ${e.message}`);
    return 1;
  }

  try {
    const orch = createOrchestrator({ store: opened.store });
    let result;
    if (opts.command === 'provision') result = await orch.provision(opts.round);
    else if (opts.command === 'reset') result = await orch.reset(opts.round);
    else if (opts.command === 'verify') result = await orch.verify(opts.round);
    else result = await orch.status(opts.round ?? undefined);

    out(JSON.stringify(result, null, 2));
    if (result.image && result.image.stub) {
      err('WARNING: golden image not found; the image hash is a deterministic STUB, not a real baseline.');
    }
    if (opts.command === 'verify' && !result.passed) return 1;
    if (opts.command === 'reset' && result.mismatches.length > 0) return 1;
    return 0;
  } catch (e) {
    err(e instanceof OrchestratorError ? `${e.code}: ${e.message}` : `error: ${e.message}`);
    return 1;
  } finally {
    await opened.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { parseArgs, main, UsageError };
