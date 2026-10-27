'use strict';
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../lib/validate');
const { authenticate, authorize, requireMfa } = require('../../middleware/auth');

module.exports = ({ admin, audit, doctors }) => {
  const r = express.Router();
  r.use(authenticate, requireMfa); // every admin route requires MFA-verified session
  const ctx = (req) => ({ ip: req.ip, requestId: req.id });
  const h = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

  const range = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).transform((v) => {
    const to = v.to || new Date().toISOString(); const from = v.from || new Date(Date.now() - 30 * 86400_000).toISOString(); return { from, to };
  }).refine((v) => new Date(v.to) > new Date(v.from) && new Date(v.to) - new Date(v.from) <= 366 * 86400_000, 'range must be positive and <= 366 days');

  r.get('/analytics/overview', authorize('admin:analytics'), validate({ query: range }), h(async (req, res) => res.json(await admin.overview(req.query))));
  r.get('/audit-logs', authorize('audit:read'), validate({ query: z.object({ entity: z.string().max(40).optional(), entityId: z.string().max(64).optional(), actorId: z.string().uuid().optional(),
    from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }) }),
    h(async (req, res) => res.json({ items: await audit.list(req.query) })));
  r.get('/audit-logs/verify', authorize('audit:read'), h(async (_req, res) => res.json(await audit.verifyChain())));
  r.post('/doctors/:id/verify', authorize('doctor:verify'), validate({ params: z.object({ id: z.string().uuid() }) }),
    h(async (req, res) => { await doctors.verify(req.user, req.params.id, ctx(req)); res.status(204).end(); }));
  return r;
};
