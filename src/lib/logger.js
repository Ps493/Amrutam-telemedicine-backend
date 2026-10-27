'use strict';
const pino = require('pino');
const config = require('../config');
// Redact secrets/PII from every log line.
module.exports = pino({
  level: config.env === 'test' ? 'silent' : config.logLevel,
  base: { service: 'amrutam-api' },
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.refreshToken', '*.mfaCode', '*.phone', '*.dob'], censor: '[REDACTED]' },
});
