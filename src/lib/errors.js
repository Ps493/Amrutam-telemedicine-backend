'use strict';
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}
const E = {
  badRequest: (m = 'Bad request', d) => new AppError(400, 'BAD_REQUEST', m, d),
  validation: (d) => new AppError(422, 'VALIDATION_ERROR', 'Invalid input', d),
  unauthorized: (m = 'Unauthorized') => new AppError(401, 'UNAUTHORIZED', m),
  forbidden: (m = 'Forbidden') => new AppError(403, 'FORBIDDEN', m),
  notFound: (m = 'Not found') => new AppError(404, 'NOT_FOUND', m),
  conflict: (m = 'Conflict', code = 'CONFLICT') => new AppError(409, code, m),
  locked: (m) => new AppError(423, 'ACCOUNT_LOCKED', m),
  upstream: (m = 'Upstream failure') => new AppError(502, 'UPSTREAM_FAILURE', m),
};
module.exports = { AppError, E };
