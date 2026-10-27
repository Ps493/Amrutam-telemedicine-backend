'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const logger = require('./lib/logger');
const metrics = require('./lib/metrics');
const errorHandler = require('./middleware/error');
const { E } = require('./lib/errors');

function createApp(container) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => { req.id = /^[\w-]{8,64}$/.test(req.get('x-request-id') || '') ? req.get('x-request-id') : crypto.randomUUID(); res.set('X-Request-Id', req.id); next(); });
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/metrics' } }));
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, hsts: { maxAge: 31536000, includeSubDomains: true } }));
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => { // RED metrics per route template (low cardinality)
    const end = metrics.httpDuration.startTimer();
    res.on('finish', () => end({ method: req.method, route: req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched', status: res.statusCode }));
    next();
  });

  const mk = (max) => config.rateLimit.enabled ? rateLimit({ windowMs: config.rateLimit.windowMs, max, standardHeaders: true, legacyHeaders: false,
    handler: (_q, _r, next) => next(new (require('./lib/errors').AppError)(429, 'RATE_LIMITED', 'Too many requests')) }) : (_q, _r, next) => next();
  const limiters = { global: mk(config.rateLimit.max), auth: mk(config.rateLimit.authMax) };
  app.use(limiters.global);

  // Ops endpoints
  app.get('/healthz', (_q, r) => r.json({ status: 'ok' })); // liveness
  app.get('/readyz', async (_q, r) => { try { await container.db.query('SELECT 1'); r.json({ status: 'ready' }); } catch { r.status(503).json({ status: 'not_ready' }); } }); // readiness
  app.get('/metrics', async (req, res) => { // restrict at ingress/network policy in prod
    res.set('Content-Type', metrics.registry.contentType); res.end(await metrics.registry.metrics());
  });
  try { // API docs
    const spec = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.yaml'), 'utf8'));
    app.use('/docs', require('swagger-ui-express').serve, require('swagger-ui-express').setup(spec));
    app.get('/openapi.json', (_q, r) => r.json(spec));
  } catch { /* spec optional at runtime */ }

  const { authRouter, usersRouter } = require('./modules/auth/auth.routes')({ auth: container.auth, limiters });
  app.use('/v1/auth', authRouter);
  app.use('/v1/users', usersRouter);
  app.use('/v1/doctors', require('./modules/doctors/doctors.routes')({ doctors: container.doctors }));
  app.use('/v1/consultations', require('./modules/consultations/consultations.routes')(container));
  app.use('/v1/admin', require('./modules/admin/admin.routes')(container));

  app.use((_q, _r, next) => next(E.notFound('Route not found')));
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
