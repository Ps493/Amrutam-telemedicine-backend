'use strict';
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../lib/validate');
const { authenticate, authorize } = require('../../middleware/auth');

const password = z.string().min(10).max(128)
  .regex(/[a-z]/, 'needs a lowercase letter').regex(/[A-Z]/, 'needs an uppercase letter').regex(/[0-9]/, 'needs a digit');
const registerSchema = z.object({
  email: z.string().email().max(254), password, fullName: z.string().min(2).max(120),
  phone: z.string().regex(/^\+?[0-9]{10,15}$/).optional(), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  role: z.enum(['patient', 'doctor']).default('patient'),   // admin can NEVER self-register
  doctor: z.object({
    specialization: z.string().min(2).max(80), licenseNo: z.string().min(4).max(40),
    yearsExperience: z.number().int().min(0).max(70), consultationFeePaise: z.number().int().min(0).max(10_000_000),
    languages: z.array(z.string().min(2).max(30)).max(10).default([]), bio: z.string().max(2000).optional(),
  }).optional(),
}).strict().refine((v) => v.role !== 'doctor' || !!v.doctor, { message: 'doctor details required for role=doctor', path: ['doctor'] });

module.exports = ({ auth, limiters }) => {
  const r = express.Router();
  const ctx = (req) => ({ ip: req.ip, requestId: req.id });

  r.post('/register', limiters.auth, validate({ body: registerSchema }), async (req, res, next) => {
    try { res.status(201).json(await auth.register(req.body, ctx(req))); } catch (e) { next(e); }
  });
  r.post('/login', limiters.auth, validate({ body: z.object({ email: z.string().email(), password: z.string().min(1).max(128), mfaCode: z.string().regex(/^\d{6}$/).optional() }).strict() }),
    async (req, res, next) => { try { res.json(await auth.login(req.body, ctx(req))); } catch (e) { next(e); } });
  r.post('/refresh', limiters.auth, validate({ body: z.object({ refreshToken: z.string().min(20).max(200) }).strict() }),
    async (req, res, next) => { try { res.json(await auth.refresh(req.body.refreshToken, ctx(req))); } catch (e) { next(e); } });
  r.post('/logout', validate({ body: z.object({ refreshToken: z.string().min(20).max(200) }).strict() }),
    async (req, res, next) => { try { await auth.logout(req.body.refreshToken); res.status(204).end(); } catch (e) { next(e); } });
  r.post('/mfa/setup', authenticate, async (req, res, next) => { try { res.json(await auth.mfaSetup(req.user.id)); } catch (e) { next(e); } });
  r.post('/mfa/enable', authenticate, limiters.auth, validate({ body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict() }),
    async (req, res, next) => { try { res.json(await auth.mfaEnable(req.user.id, req.body.code, ctx(req))); } catch (e) { next(e); } });

  const users = express.Router();
  users.get('/me', authenticate, authorize('profile:read'), async (req, res, next) => { try { res.json(await auth.me(req.user.id)); } catch (e) { next(e); } });
  users.patch('/me', authenticate, authorize('profile:write'),
    validate({ body: z.object({ fullName: z.string().min(2).max(120).optional(), phone: z.string().regex(/^\+?[0-9]{10,15}$/).optional(), gender: z.enum(['male', 'female', 'other']).optional() }).strict() }),
    async (req, res, next) => { try { res.json(await auth.updateProfile(req.user.id, req.body, ctx(req))); } catch (e) { next(e); } });
  return { authRouter: r, usersRouter: users };
};
