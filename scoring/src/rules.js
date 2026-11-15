'use strict';

// Scoring values. Documented in scoring/README.md; change them here only.
module.exports = Object.freeze({
  FLAG_CAPTURE_POINTS: 50,       // per accepted flag
  FIRST_BLOOD_POINTS: 25,        // bonus on the first accepted capture of a flag
  UPTIME_POINTS_PER_POLL: 1,     // per reachable flag-beacon poll
  SUBMISSIONS_PER_WINDOW: 10,    // per team
  SUBMISSION_WINDOW_MS: 60000,
  LEADERBOARD_CACHE_MS: 2000,
  TIMELINE_DEFAULT_LIMIT: 500,
  TIMELINE_MAX_LIMIT: 1000,
});
