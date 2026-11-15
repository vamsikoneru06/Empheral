import { ApiError } from './api.js';

// Timestamps are UTC RFC 3339; show them in UTC so every viewer sees the same time.
export function fmtTime(iso) {
  return iso ? `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '-';
}

// Countdown as HH:MM:SS. Zero or negative shows 00:00:00.
export function fmtDuration(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// Server errors keep their HTTP status and code so the page shows what the API said.
export function errorText(e) {
  if (e instanceof ApiError) return `HTTP ${e.status} ${e.code}: ${e.message}`;
  return e?.message ?? String(e);
}
