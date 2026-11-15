'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_VERIFIER_CMD = 'python -m verifier run --expected out/expected-matrix.json --format json';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_CHARS = 2000;

function verifierCommand(env = process.env) {
  const override = (env.VERIFIER_CMD || '').trim();
  return override || DEFAULT_VERIFIER_CMD;
}

/**
 * Runs the verifier from the project root and resolves with its exit code. Exit 0 is
 * the only pass (gate). A spawn failure, timeout or signal resolves with 2 (probe
 * error), which blocks the round.
 */
function defaultVerifierRunner({ root, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const command = verifierCommand(env);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (exitCode, note = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, command, stdout, stderr: stderr + note });
    };
    const child = spawn(command, { cwd: root, env, shell: true, windowsHide: true });
    timer = setTimeout(() => {
      child.kill();
      finish(2, '\nverifier timed out');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => finish(2, `\n${err.message}`));
    child.on('close', (code) => finish(code === null ? 2 : code));
  });
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** Parses the verifier's JSON report, from the whole output or from its last line. */
function parseVerifierOutput(stdout = '') {
  const text = String(stdout).trim();
  if (!text) return null;
  try {
    return asObject(JSON.parse(text));
  } catch {
    // not one JSON document; try the last line below
  }
  try {
    return asObject(JSON.parse(text.split(/\r?\n/).pop()));
  } catch {
    return null;
  }
}

function tail(text) {
  return String(text || '').slice(-TAIL_CHARS);
}

module.exports = { defaultVerifierRunner, parseVerifierOutput, verifierCommand, tail, DEFAULT_VERIFIER_CMD };
