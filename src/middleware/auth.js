'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const { E } = require('../lib/errors');
const { can } = require('../lib/rbac');

const ISSUER = 'amrutam-api';
const AUDIENCE = 'amrutam-clients';

function signAccess(user, mfa) {
  return jwt.sign({ role: user.role, mfa: !!mfa }, config.jwtSecret, {
    algorithm: 'HS256', subject: user.id, issuer: ISSUER, audience: AUDIENCE, expiresIn: config.accessTtlSec,
  });
}

// Authenticate: strict Bearer parsing, algorithm pinned (prevents alg=none / key confusion attacks).
function authenticate(req, _res, next) {
  const h = req.headers.authorization || '';
  const [scheme, token] = h.split(' ');
  if (scheme !== 'Bearer' || !token) return next(E.unauthorized('Missing bearer token'));
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    req.user = { id: p.sub, role: p.role, mfa: !!p.mfa };
    next();
  } catch { next(E.unauthorized('Invalid or expired token')); }
}

// Authorize by permission (RBAC). Fails closed.
const authorize = (...perms) => (req, _res, next) => {
  if (!req.user) return next(E.unauthorized());
  if (!perms.every((p) => can(req.user.role, p))) return next(E.forbidden('Insufficient permissions'));
  next();
};

// Step-up: privileged roles must have completed MFA in this session for sensitive operations.
const requireMfa = (req, _res, next) => {
  if (!req.user) return next(E.unauthorized());
  if (req.user.role !== 'patient' && !req.user.mfa) return next(new (require('../lib/errors').AppError)(403, 'MFA_REQUIRED', 'MFA required for this operation'));
  next();
};

module.exports = { authenticate, authorize, requireMfa, signAccess };
