'use strict';
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../lib/validate');
const { authenticate, authorize, requireMfa } = require('../../middleware/auth');

const uuid = z.string().uuid();
const slotsBody = z.object({
  slots: z.array(z.object({ startTime: z.string().datetime(), endTime: z.string().datetime() })
    .refine((s) => new Date(s.endTime) > new Date(s.startTime), 'endTime must be after startTime')
    .refine((s) => (new Date(s.endTime) - new Date(s.startTime)) / 60000 >= 10 && (new Date(s.endTime) - new Date(s.startTime)) / 60000 <= 120, 'duration must be 10-120 minutes')
    .refine((s) => new Date(s.startTime) > new Date(), 'slot must be in the future')).min(1).max(100),
}).strict();
const searchQuery = z.object({
  q: z.string().max(80).optional(), specialization: z.string().max(80).optional(), language: z.string().max(30).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(), maxFeePaise: z.coerce.number().int().min(0).optional(),
  availableOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), sort: z.enum(['rating', 'fee', 'experience']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1), limit: z.coerce.number().int().min(1).max(50).default(20),
});

module.exports = ({ doctors }) => {
  const r = express.Router();
  const ctx = (req) => ({ ip: req.ip, requestId: req.id });
  r.get('/', authenticate, authorize('doctor:search'), validate({ query: searchQuery }), async (req, res, next) => { try { res.json(await doctors.search(req.query)); } catch (e) { next(e); } });
  r.post('/me/slots', authenticate, authorize('slot:manage_own'), requireMfa, validate({ body: slotsBody }),
    async (req, res, next) => { try { res.status(201).json({ slots: await doctors.createSlots(req.user.id, req.body.slots, ctx(req)) }); } catch (e) { next(e); } });
  r.delete('/me/slots/:id', authenticate, authorize('slot:manage_own'), requireMfa, validate({ params: z.object({ id: uuid }) }),
    async (req, res, next) => { try { await doctors.deleteSlot(req.user.id, req.params.id, ctx(req)); res.status(204).end(); } catch (e) { next(e); } });
  r.get('/:id/slots', authenticate, authorize('doctor:search'), validate({ params: z.object({ id: uuid }), query: z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }) }),
    async (req, res, next) => { try { res.json({ slots: await doctors.listSlots(req.params.id, req.query) }); } catch (e) { next(e); } });
  return r;
};
