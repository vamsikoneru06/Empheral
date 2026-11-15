'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const {
  deriveTargets,
  generateFlags,
  environmentsIdentical,
  computeImageHash,
  assertImageSet,
  flagFor,
  TARGET_ROLES,
  FLAG_ROLES,
} = require('../src/index');

const IMAGE_DIR = path.join(__dirname, '..', 'fixtures', 'images');
const teamList = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('flags: 64 lowercase hex, unique, five per team, none for beacons (4 teams)', () => {
  const rows = generateFlags({ roundId: 1, teamIds: teamList(4), injectedAt: '2026-11-03T09:00:00.000Z' });
  assert.equal(rows.length, 4 * 5);
  for (const row of rows) {
    assert.match(row.value, /^[0-9a-f]{64}$/);
    assert.notEqual(row.target_role, 'beacon');
  }
  assert.equal(new Set(rows.map((r) => r.value)).size, rows.length, 'flag values are unique');
  assert.deepEqual([...new Set(rows.map((r) => r.target_role))].sort(), [...FLAG_ROLES].sort());
});

test('flags: uniqueness holds at 16 teams and differs between calls', () => {
  const first = generateFlags({ roundId: 2, teamIds: teamList(16), injectedAt: 'x' });
  const second = generateFlags({ roundId: 2, teamIds: teamList(16), injectedAt: 'x' });
  assert.equal(first.length, 80);
  assert.equal(new Set(first.map((r) => r.value)).size, 80);
  assert.equal(first.some((r, i) => r.value === second[i].value), false);
});

test('targets: six roles per team at 10.40.N.{10,20,30,40,50,60}', () => {
  const rows = deriveTargets({ roundId: 1, teamIds: [3], imageHash: 'a'.repeat(64) });
  assert.equal(rows.length, 6);
  const byRole = Object.fromEntries(rows.map((r) => [r.role, r.ip_address]));
  assert.deepEqual(byRole, {
    web: '10.40.3.10',
    db: '10.40.3.20',
    workstation: '10.40.3.30',
    dc: '10.40.3.40',
    fileserver: '10.40.3.50',
    beacon: '10.40.3.60',
  });
  assert.deepEqual([...TARGET_ROLES].sort(), rows.map((r) => r.role).sort());
});

test('V7: every team has the identical role -> offset structure (4 and 16 teams)', () => {
  for (const n of [4, 16]) {
    const targets = deriveTargets({ roundId: 1, teamIds: teamList(n), imageHash: 'b'.repeat(64) });
    const result = environmentsIdentical(targets);
    assert.equal(result.identical, true, `${n} teams`);
    assert.equal(result.teams, n);
    assert.match(result.digest, /^[0-9a-f]{64}$/);
  }
});

test('V7 detects a team whose target offsets drifted', () => {
  const targets = deriveTargets({ roundId: 1, teamIds: teamList(4), imageHash: 'c'.repeat(64) });
  const drifted = targets.map((t) => (t.team_id === 2 && t.role === 'web' ? { ...t, ip_address: '10.40.2.11' } : t));
  assert.equal(environmentsIdentical(drifted).identical, false);
});

test('V7 detects a team missing a role, and a team with a different image hash', () => {
  const targets = deriveTargets({ roundId: 1, teamIds: teamList(4), imageHash: 'd'.repeat(64) });
  const missing = targets.filter((t) => !(t.team_id === 4 && t.role === 'dc'));
  assert.equal(environmentsIdentical(missing).identical, false);
  const hashed = targets.map((t) => (t.team_id === 3 ? { ...t, image_hash: 'e'.repeat(64) } : t));
  assert.equal(environmentsIdentical(hashed).identical, false);
});

test('V7 detects a target whose third octet is not its team number', () => {
  const targets = deriveTargets({ roundId: 1, teamIds: teamList(2), imageHash: 'f'.repeat(64) });
  const misplaced = targets.map((t) => (t.team_id === 2 && t.role === 'db' ? { ...t, ip_address: '10.40.1.20' } : t));
  assert.equal(environmentsIdentical(misplaced).identical, false);
});

test('flagFor returns the team/role flag, null for beacons, and throws when a flag is missing', () => {
  const flags = generateFlags({ roundId: 1, teamIds: [1], injectedAt: 'x' });
  const web = { team_id: 1, role: 'web' };
  assert.equal(flagFor(flags, web), flags.find((f) => f.target_role === 'web').value);
  assert.equal(flagFor(flags, { team_id: 1, role: 'beacon' }), null);
  assert.throws(() => flagFor([], web), (err) => err.code === 'flag_missing');
});

test('image set names: plain names only, no path escape', () => {
  for (const bad of ['', '../secret', 'a/b', 'a\\b', '.hidden', 'x'.repeat(70)]) {
    assert.throws(() => assertImageSet(bad), (err) => err.code === 'invalid_input', JSON.stringify(bad));
  }
  assert.equal(assertImageSet('golden-v3'), 'golden-v3');
});

test('image hash: a real file gives sha256 of its bytes, not a stub', async () => {
  const file = path.join(IMAGE_DIR, 'golden-test');
  const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const image = await computeImageHash({ imageDir: IMAGE_DIR, imageSet: 'golden-test' });
  assert.equal(image.stub, false);
  assert.equal(image.hash, expected);
});

test('image hash: a missing file gives a deterministic, clearly marked stub', async () => {
  const a = await computeImageHash({ imageDir: IMAGE_DIR, imageSet: 'no-such-image' });
  const b = await computeImageHash({ imageDir: IMAGE_DIR, imageSet: 'no-such-image' });
  assert.equal(a.stub, true);
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
});
