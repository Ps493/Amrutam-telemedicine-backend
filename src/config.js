'use strict';
// All configuration comes from environment variables (12-factor). No secrets in code.
const required = (name, fallbackInDev) => {
  const v = process.env[name];
  if (v) return v;
  if (process.env.NODE_ENV === 'production') throw new Error(`Missing required env var ${name}`);
  return fallbackInDev;
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: required('DATABASE_URL', 'postgres://amrutam:amrutam@localhost:5432/amrutam'),
  dbPoolMax: parseInt(process.env.DB_POOL_MAX || '20', 10),
  dbReplicaUrl: process.env.DATABASE_REPLICA_URL || null, // read replica for analytics/search
  redisUrl: process.env.REDIS_URL || null,
  jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret-change-me-32chars-min'),
  accessTtlSec: parseInt(process.env.ACCESS_TTL_SEC || '900', 10),
  refreshTtlSec: parseInt(process.env.REFRESH_TTL_SEC || '1209600', 10),
  // Keyring for field-level encryption: "v1:<base64 32 bytes>,v2:<base64 32 bytes>"
  keyring: required('ENCRYPTION_KEYRING', 'v1:' + Buffer.alloc(32, 7).toString('base64')),
  activeKeyVersion: process.env.ACTIVE_KEY_VERSION || 'v1',
  holdMinutes: parseInt(process.env.SLOT_HOLD_MINUTES || '10', 10),
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
    windowMs: 60_000,
    max: parseInt(process.env.RATE_LIMIT_MAX || '300', 10),
    authMax: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '10', 10),
  },
  maxFailedLogins: 5,
  lockMinutes: 15,
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
  paymentProvider: process.env.PAYMENT_PROVIDER || 'mock',
};
if (config.env === 'production' && config.jwtSecret.length < 32) throw new Error('JWT_SECRET too short');
module.exports = config;
