'use strict';
// Composition root / Dependency Injection. Every service receives its dependencies explicitly,
// so tests can swap the DB, gateway or cache without monkey-patching.
const { createDb } = require('./lib/db');
const { createCache } = require('./lib/cache');
const config = require('./config');
const { createAuditService } = require('./modules/audit/audit.service');
const { createAuthService } = require('./modules/auth/auth.service');
const { createDoctorService } = require('./modules/doctors/doctors.service');
const { MockGateway, createResilientGateway } = require('./modules/payments/gateway');
const { createConsultationService } = require('./modules/consultations/consultations.service');
const { createPrescriptionService } = require('./modules/consultations/prescriptions.service');
const { createAdminService } = require('./modules/admin/admin.service');

function buildContainer(overrides = {}) {
  const db = overrides.db || createDb();
  const cache = overrides.cache || createCache(config.redisUrl);
  const audit = createAuditService(db);
  const rawGateway = overrides.rawGateway || new MockGateway(); // swap for Razorpay/Stripe adapter in prod
  const gateway = overrides.gateway || createResilientGateway(rawGateway, overrides.gatewayOpts);
  const auth = createAuthService({ db, audit });
  const doctors = createDoctorService({ db, audit, cache });
  const consultations = createConsultationService({ db, audit, gateway, cache });
  const prescriptions = createPrescriptionService({ db, audit });
  const admin = createAdminService({ db, cache });
  return { db, cache, audit, auth, doctors, consultations, prescriptions, admin, gateway, rawGateway };
}
module.exports = { buildContainer };
