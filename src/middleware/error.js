'use strict';
const { AppError } = require('../lib/errors');
const logger = require('../lib/logger');

// Maps domain + Postgres errors to a uniform error envelope. Never leaks internals on 5xx.
module.exports = (err, req, res, _next) => {
  let e = err;
  if (!(e instanceof AppError)) {
    if (e.code === '23505') e = new AppError(409, 'CONFLICT', 'Resource already exists');
    else if (e.code === '23P01') e = new AppError(409, 'SLOT_OVERLAP', 'Overlapping availability exists');
    else if (e.code === '22P02') e = new AppError(400, 'BAD_REQUEST', 'Malformed identifier');
    else if (e.type === 'entity.parse.failed') e = new AppError(400, 'BAD_JSON', 'Malformed JSON body');
    else if (e.type === 'entity.too.large') e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Payload too large');
    else { logger.error({ err: e, requestId: req.id }, 'unhandled error'); e = new AppError(500, 'INTERNAL', 'Internal server error'); }
  }
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details, requestId: req.id } });
};
