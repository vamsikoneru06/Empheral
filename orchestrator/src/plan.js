'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { OrchestratorError } = require('./errors');

// Fixed role -> host offset. Identical for every team (CLAUDE.md conventions).
const ROLE_OFFSETS = Object.freeze({ web: 10, db: 20, workstation: 30, dc: 40, fileserver: 50, beacon: 60 });
const TARGET_ROLES = Object.freeze(Object.keys(ROLE_OFFSETS));
// Beacons never carry a flag (data-model.md: flags.target_role excludes beacon).
const FLAG_ROLES = Object.freeze(TARGET_ROLES.filter((role) => role !== 'beacon'));
const MAX_TEAMS = 16;
const IMAGE_SET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function invalid(message) {
  return new OrchestratorError('invalid_input', message, 400);
}

function assertTeamIds(teamIds) {
  if (!Array.isArray(teamIds) || teamIds.length === 0) {
    throw invalid('team_ids must be a non-empty array');
  }
  const seen = new Set();
  for (const id of teamIds) {
    if (!Number.isInteger(id) || id < 1 || id > MAX_TEAMS) {
      throw invalid(`team id ${id} must be an integer from 1 to ${MAX_TEAMS}`);
    }
    if (seen.has(id)) throw invalid(`team id ${id} is listed twice`);
    seen.add(id);
  }
  return teamIds;
}

// A plain name only. No separators or dots at the start, so IMAGE_DIR cannot be escaped.
function assertImageSet(name) {
  if (typeof name !== 'string' || !IMAGE_SET_RE.test(name)) {
    throw invalid(`image_set "${name}" must be a plain name with no path separators`);
  }
  return name;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function targetIp(teamId, role) {
  return `10.40.${teamId}.${ROLE_OFFSETS[role]}`;
}

function deriveTargets({ roundId, teamIds, imageHash }) {
  const rows = [];
  for (const teamId of teamIds) {
    for (const role of TARGET_ROLES) {
      rows.push({
        round_id: roundId,
        team_id: teamId,
        role,
        ip_address: targetIp(teamId, role),
        image_hash: imageHash,
        provisioned_at: null,
      });
    }
  }
  return rows;
}

/** One 64-hex flag per (team, flag role). Values are unique within the call. */
function generateFlags({ roundId, teamIds, injectedAt }) {
  const seen = new Set();
  const rows = [];
  for (const teamId of teamIds) {
    for (const role of FLAG_ROLES) {
      let value;
      do {
        value = crypto.randomBytes(32).toString('hex');
      } while (seen.has(value));
      seen.add(value);
      rows.push({ round_id: roundId, team_id: teamId, target_role: role, value, injected_at: injectedAt });
    }
  }
  return rows;
}

/** The flag a target carries (null for beacons). Missing rows are an error, never a silent null. */
function flagFor(flags, target) {
  if (target.role === 'beacon') return null;
  const row = flags.find((f) => f.team_id === target.team_id && f.target_role === target.role);
  if (!row) {
    throw new OrchestratorError('flag_missing', `no flag stored for team ${target.team_id} ${target.role}`, 500);
  }
  return row.value;
}

/**
 * V7 / NFR-7: every team must have the same role -> offset structure and the same
 * image hash. The digest covers that structure and is the same for every team.
 */
function teamSignature(teamId, rows) {
  const parts = rows.map((row) => {
    const octets = row.ip_address.split('.').map(Number);
    if (octets[0] !== 10 || octets[1] !== 40 || octets[2] !== teamId) {
      return `BAD:${row.ip_address}`;
    }
    return `${row.role}=${octets[3]}@${row.image_hash}`;
  });
  return parts.sort().join(';');
}

function environmentsIdentical(targets) {
  const byTeam = new Map();
  for (const row of targets) {
    if (!byTeam.has(row.team_id)) byTeam.set(row.team_id, []);
    byTeam.get(row.team_id).push(row);
  }
  const signatures = [...byTeam].map(([teamId, rows]) => teamSignature(teamId, rows));
  const identical = signatures.length > 0 && signatures.every((s) => s === signatures[0]);
  return {
    identical,
    digest: identical ? sha256Hex(signatures[0]) : null,
    teams: byTeam.size,
  };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * sha256 of IMAGE_DIR/<image_set>. If that file is missing, a deterministic stub hash
 * is returned with stub: true, so the output can never pass for a real golden image.
 */
async function computeImageHash({ imageDir, imageSet }) {
  assertImageSet(imageSet);
  const file = path.join(imageDir, imageSet);
  let isFile = false;
  try {
    isFile = (await fs.promises.stat(file)).isFile();
  } catch {
    isFile = false;
  }
  if (isFile) {
    return { hash: await sha256File(file), stub: false, path: file };
  }
  return { hash: sha256Hex(`stub:${imageSet}`), stub: true, path: file };
}

module.exports = {
  ROLE_OFFSETS,
  TARGET_ROLES,
  FLAG_ROLES,
  MAX_TEAMS,
  assertTeamIds,
  assertImageSet,
  targetIp,
  deriveTargets,
  generateFlags,
  flagFor,
  environmentsIdentical,
  computeImageHash,
};
