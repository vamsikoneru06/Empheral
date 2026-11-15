'use strict';

// Enumerations mirror the ENUM columns in db/001_init.sql.
const ROUND_STATUSES = Object.freeze([
  'planned', 'provisioning', 'verifying', 'blocked',
  'ready', 'running', 'frozen', 'closed',
]);
const TARGET_ROLES = Object.freeze(['web', 'db', 'workstation', 'dc', 'fileserver', 'beacon']);
const FLAG_ROLES = Object.freeze(['web', 'db', 'workstation', 'dc', 'fileserver']);
const VERDICTS = Object.freeze(['accepted', 'wrong', 'duplicate', 'self_submit', 'expired', 'rate_limited']);
const SCORE_KINDS = Object.freeze([
  'flag_capture', 'first_blood', 'service_uptime', 'defence', 'penalty', 'manual_adjust',
]);

module.exports = { ROUND_STATUSES, TARGET_ROLES, FLAG_ROLES, VERDICTS, SCORE_KINDS };
