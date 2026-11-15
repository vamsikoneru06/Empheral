'use strict';

/**
 * Error with a stable machine code. Codes follow api-spec.md where one exists
 * (round_not_running, verification_required, not_found, ...). httpStatus is what
 * a future API layer would return; there is no HTTP layer in this package yet.
 */
class OrchestratorError extends Error {
  constructor(code, message, httpStatus = 409) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

module.exports = { OrchestratorError };
