'use strict';
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../lib/validate');
const { authenticate, authorize, requireMfa } = require('../../middleware/auth');
const { idempotent } = require('../../middleware/idempotency');

const id = z.object({ id: z.string().uuid() });
const rx = z.object({
  items: z.array(z.object({ name: z.string().min(1).max(120), dosage: z.string().min(1).max(60), frequency: z.string().min(1).max(60),
    durationDays: z.number().int().min(1).max(365), notes: z.string().max(300).optional() }).strict()).min(1).max(30),
  advice: z.string().max(2000).optional(),
}).strict();

module.exports = ({ db, consultations, prescriptions }) => {
  const r = express.Router();
  const ctx = (req) => ({ ip: req.ip, requestId: req.id });
  const idem = idempotent(db);
  const h = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

  r.post('/', authenticate, authorize('consultation:book'),
    validate({ body: z.object({ slotId: z.string().uuid(), reason: z.string().max(1000).optional() }).strict() }), idem,
    h(async (req, res) => res.status(201).json(await consultations.book(req.user, req.body, ctx(req)))));
  r.get('/', authenticate, authorize('consultation:read_own'),
    validate({ query: z.object({ status: z.enum(['PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED']).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }) }),
    h(async (req, res) => res.json(await consultations.list(req.user, req.query))));
  r.get('/:id', authenticate, validate({ params: id }), h(async (req, res) => res.json(await consultations.get(req.user, req.params.id, ctx(req)))));
  r.post('/:id/pay', authenticate, authorize('payment:pay_own'),
    validate({ params: id, body: z.object({ paymentToken: z.string().min(3).max(100) }).strict() }), idem,
    h(async (req, res) => res.json(await consultations.pay(req.user, req.params.id, req.body, ctx(req)))));
  r.post('/:id/start', authenticate, authorize('consultation:run'), requireMfa, validate({ params: id }),
    h(async (req, res) => res.json(await consultations.transition(req.user, req.params.id, 'IN_PROGRESS', {}, ctx(req)))));
  r.post('/:id/complete', authenticate, authorize('consultation:run'), requireMfa,
    validate({ params: id, body: z.object({ notes: z.string().max(5000).optional() }).strict() }),
    h(async (req, res) => res.json(await consultations.transition(req.user, req.params.id, 'COMPLETED', { notes: req.body.notes }, ctx(req)))));
  r.post('/:id/cancel', authenticate, validate({ params: id, body: z.object({ reason: z.string().max(300).optional() }).strict() }), idem,
    h(async (req, res) => res.json(await consultations.transition(req.user, req.params.id, 'CANCELLED', { reason: req.body.reason }, ctx(req)))));
  r.post('/:id/prescription', authenticate, authorize('prescription:write'), requireMfa, validate({ params: id, body: rx }), idem,
    h(async (req, res) => res.status(201).json(await prescriptions.create(req.user, req.params.id, req.body, ctx(req)))));
  r.get('/:id/prescription', authenticate, authorize('prescription:read_own'), validate({ params: id }),
    h(async (req, res) => res.json(await prescriptions.get(req.user, req.params.id, ctx(req)))));
  return r;
};
