import leaderboardFx from './fixtures/leaderboard.json';
import teamFx from './fixtures/team.json';
import timelineFx from './fixtures/timeline.json';
import verificationFx from './fixtures/verification.json';
import matrixFx from './fixtures/matrix.json';

// VITE_API_BASE: default /api (proxied by the dev server). VITE_MOCK=1: all data from fixtures.
const API_BASE = import.meta.env.VITE_API_BASE || '/api';
export const MOCK = import.meta.env.VITE_MOCK === '1';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// Token is passed per call and kept only in component state. It is never persisted.
async function request(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'http_error', err.message ?? (res.statusText || 'request failed'));
  }
  return data;
}

const live = {
  leaderboard: () => request('GET', '/leaderboard'),
  currentRound: () => request('GET', '/rounds/current'),
  team: (id, token) => request('GET', `/teams/${encodeURIComponent(id)}`, { token }),
  submit: (value, token) => request('POST', '/submissions', { token, body: { value } }),
  timeline: (roundId, sinceSeq, token) =>
    request('GET', `/judge/timeline?${new URLSearchParams({ round_id: roundId, since_seq: sinceSeq })}`, { token }),
  adjust: (body, token) => request('POST', '/judge/adjust', { token, body }),
  createRound: (body, token) => request('POST', '/rounds', { token, body }),
  provision: (id, token) => request('POST', `/rounds/${id}/provision`, { token }),
  reset: (id, token) => request('POST', `/rounds/${id}/reset`, { token }),
  latestVerification: (token) => request('GET', '/verification/latest', { token }),
  runVerification: (token) => request('POST', '/verification/run', { token }),
};

// Mock backend. Same signatures as live. Calls that would be refused by the real server throw
// the same ApiError, so the views show the same messages.
const clone = (x) => structuredClone(x);
const submitted = new Set();
const mockEvents = clone(timelineFx.events);
const mock = {
  leaderboard: () => ({ ...clone(leaderboardFx), as_of: new Date().toISOString() }),
  currentRound: () => {
    const now = Date.now();
    const at = (min) => new Date(now + min * 60000).toISOString();
    return {
      id: 3, name: 'Round 3 - Lateral', status: 'running',
      starts_at: at(-41), ends_at: at(139), freeze_at: at(124), server_time: new Date(now).toISOString(),
    };
  },
  team: (id) => {
    if (Number(id) !== teamFx.team_id) throw new ApiError(403, 'forbidden', 'Only your own team is visible with this token.');
    return clone(teamFx);
  },
  submit: (value) => {
    if (!/^[0-9a-f]{64}$/i.test(value)) return { verdict: 'wrong', points: 0, first_blood: false, new_score: teamFx.score };
    if (submitted.has(value)) return { verdict: 'duplicate', points: 0, first_blood: false, new_score: teamFx.score };
    submitted.add(value);
    return { verdict: 'accepted', points: 50, first_blood: false, new_score: teamFx.score + 50 };
  },
  timeline: (roundId, sinceSeq) => ({
    round_id: Number(roundId),
    next_seq: (mockEvents.at(-1)?.seq ?? 0) + 1,
    events: mockEvents.filter((e) => e.seq > sinceSeq),
  }),
  adjust: (body) => {
    const seq = (mockEvents.at(-1)?.seq ?? 0) + 1;
    mockEvents.push({ seq, team_id: body.team_id, kind: 'manual_adjust', points: body.points, note: body.note, occurred_at: new Date().toISOString() });
    return { seq };
  },
  createRound: (body) => ({ id: 4, status: 'planned', ...body }),
  provision: () => ({ job_id: 'mock-provision-1' }),
  reset: () => {
    throw new ApiError(409, 'round_not_running', 'Refused: round is running. Reset runs only between rounds.');
  },
  latestVerification: () => ({ ...clone(verificationFx), matrix: matrixFx.matrix, expected: matrixFx.matrix }),
  runVerification: () => ({ job_id: 'mock-verify-1' }),
};

// Mock functions become async, so a throw is a rejected promise like a fetch failure.
const asAsync = (obj) => Object.fromEntries(Object.entries(obj).map(([k, f]) => [k, async (...a) => f(...a)]));

export const api = MOCK ? asAsync(mock) : live;
