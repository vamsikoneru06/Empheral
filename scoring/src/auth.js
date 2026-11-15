'use strict';

// Bearer tokens come from a JSON file (env TOKENS_FILE):
//   { "<token>": { "role": "competitor", "team_id": 1 }, "<token>": { "role": "judge" } }
// Roles: competitor (needs team_id), judge, admin. The public role needs no token.
// Raw tokens are never logged; the audit actor is "<role>:<short sha256 of token>".

const crypto = require('node:crypto');
const fs = require('node:fs');

const TOKEN_ROLES = Object.freeze(['competitor', 'judge', 'admin']);
const PUBLIC_CALLER = Object.freeze({ role: 'public', team_id: null, actor: 'public' });

function parseTokens(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('tokens file must be a JSON object mapping token to {role, team_id}');
  }
  const tokens = new Map();
  for (const [token, entry] of Object.entries(doc)) {
    if (!entry || !TOKEN_ROLES.includes(entry.role)) {
      throw new Error(`token entry has invalid role (allowed: ${TOKEN_ROLES.join(', ')})`);
    }
    if (entry.role === 'competitor' && !Number.isInteger(entry.team_id)) {
      throw new Error('competitor token needs an integer team_id');
    }
    const fingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
    tokens.set(token, {
      role: entry.role,
      team_id: entry.role === 'competitor' ? entry.team_id : null,
      actor: `${entry.role}:${fingerprint}`,
    });
  }
  return tokens;
}

function loadTokens(filePath) {
  if (!filePath) return new Map();
  return parseTokens(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

// Resolves req.caller from the Authorization header. An unknown token is always a 401.
function authenticate(tokens) {
  return (req, res, next) => {
    const header = req.get('authorization');
    if (header === undefined) {
      req.caller = PUBLIC_CALLER;
      return next();
    }
    const match = /^Bearer\s+(\S+)$/.exec(header);
    const entry = match ? tokens.get(match[1]) : undefined;
    if (!entry) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' } });
    }
    req.caller = entry;
    return next();
  };
}

// Route guard: 401 for the public caller, 403 for an authenticated caller outside the roles.
function need(...roles) {
  return (req, res, next) => {
    if (req.caller.role === 'public') {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Bearer token required.' } });
    }
    if (!roles.includes(req.caller.role)) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Your role may not call this endpoint.' } });
    }
    return next();
  };
}

module.exports = { parseTokens, loadTokens, authenticate, need, PUBLIC_CALLER };
