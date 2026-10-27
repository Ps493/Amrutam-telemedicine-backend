'use strict';
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const crypto = require('crypto');
const config = require('../../config');
const { E, AppError } = require('../../lib/errors');
const { encrypt, decrypt, sha256, randomToken } = require('../../lib/crypto');
const { signAccess } = require('../../middleware/auth');

const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', BCRYPT_COST); // equalise timing for unknown emails
authenticator.options = { window: 1 };

function createAuthService({ db, audit }) {
  async function issueTokens(client, user, mfa, familyId = crypto.randomUUID()) {
    const refresh = randomToken();
    await client.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)`,
      [user.id, familyId, sha256(refresh), config.refreshTtlSec]);
    return { accessToken: signAccess(user, mfa), refreshToken: refresh, expiresIn: config.accessTtlSec, tokenType: 'Bearer' };
  }

  async function register(input, ctx) {
    const hash = await bcrypt.hash(input.password, BCRYPT_COST);
    return db.tx(async (c) => {
      const status = input.role === 'doctor' ? 'pending_verification' : 'active';
      const u = await c.query(`INSERT INTO users (email, password_hash, role, status) VALUES ($1,$2,$3,$4) RETURNING id, email, role, status`,
        [input.email.trim(), hash, input.role, status]).catch((e) => { if (e.code === '23505') throw E.conflict('Email already registered', 'EMAIL_TAKEN'); throw e; });
      const user = u.rows[0];
      await c.query(`INSERT INTO profiles (user_id, full_name, phone_enc, dob_enc, gender) VALUES ($1,$2,$3,$4,$5)`,
        [user.id, input.fullName, encrypt(input.phone, `profiles.phone:${user.id}`), encrypt(input.dob, `profiles.dob:${user.id}`), input.gender || null]);
      if (input.role === 'doctor') {
        const d = input.doctor;
        await c.query(`INSERT INTO doctors (user_id, specialization, license_no, years_experience, consultation_fee_paise, languages, bio) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [user.id, d.specialization, d.licenseNo, d.yearsExperience, d.consultationFeePaise, d.languages, d.bio || null]);
      }
      await audit.record(c, { actor: { id: user.id, role: user.role }, action: 'user.register', entity: 'user', entityId: user.id, ctx });
      return user;
    });
  }

  async function login({ email, password, mfaCode }, ctx) {
    const { rows } = await db.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
    const user = rows[0];
    if (!user) { await bcrypt.compare(password, DUMMY_HASH); throw E.unauthorized('Invalid credentials'); }
    if (user.locked_until && user.locked_until > new Date()) throw E.locked('Account temporarily locked. Try again later.');
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const r = await db.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
         WHERE id=$1 RETURNING failed_logins`, [user.id, config.maxFailedLogins, config.lockMinutes]);
      await audit.recordStandalone({ actor: { id: user.id, role: user.role }, action: 'auth.login_failed', entity: 'user', entityId: user.id, metadata: { failures: r.rows[0].failed_logins }, ctx });
      throw E.unauthorized('Invalid credentials');
    }
    if (user.status === 'suspended') throw E.forbidden('Account suspended');

    let mfa = false;
    if (user.mfa_enabled) {
      if (!mfaCode) throw new AppError(401, 'MFA_CODE_REQUIRED', 'MFA code required');
      const secret = decrypt(user.mfa_secret_enc, `users.mfa:${user.id}`);
      if (!authenticator.check(mfaCode, secret)) {
        await audit.recordStandalone({ actor: { id: user.id, role: user.role }, action: 'auth.mfa_failed', entity: 'user', entityId: user.id, ctx });
        throw E.unauthorized('Invalid MFA code');
      }
      mfa = true;
    }
    return db.tx(async (c) => {
      await c.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [user.id]);
      const tokens = await issueTokens(c, user, mfa);
      await audit.record(c, { actor: { id: user.id, role: user.role }, action: 'auth.login', entity: 'user', entityId: user.id, metadata: { mfa }, ctx });
      return { ...tokens, user: { id: user.id, role: user.role, mfaEnabled: user.mfa_enabled }, mfaSetupRequired: user.role !== 'patient' && !user.mfa_enabled };
    });
  }

  // Refresh-token rotation with reuse detection: presenting a revoked token revokes the whole family.
  async function refresh(token, ctx) {
    const h = sha256(token);
    const result = await db.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE', [h]);
      const t = rows[0];
      if (!t) throw E.unauthorized('Invalid refresh token');
      if (t.revoked_at) {
        // Must COMMIT the family revocation, so signal reuse via return value (throwing would roll it back).
        await c.query('UPDATE refresh_tokens SET revoked_at=now() WHERE family_id=$1 AND revoked_at IS NULL', [t.family_id]);
        await audit.record(c, { actor: { id: t.user_id }, action: 'auth.refresh_reuse_detected', entity: 'user', entityId: t.user_id, ctx });
        return { reuse: true };
      }
      if (t.expires_at < new Date()) throw E.unauthorized('Refresh token expired');
      await c.query('UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1', [t.id]);
      const user = (await c.query('SELECT id, role, status, mfa_enabled FROM users WHERE id=$1', [t.user_id])).rows[0];
      if (!user || user.status === 'suspended') throw E.forbidden('Account unavailable');
      // MFA claim is NOT inherited blindly: refresh keeps mfa=true only for users with MFA enabled (it was verified at login).
      return issueTokens(c, user, user.mfa_enabled, t.family_id);
    });
    if (result.reuse) throw E.unauthorized('Refresh token reuse detected; session revoked');
    return result;
  }

  async function logout(token) {
    await db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [sha256(token)]);
  }

  async function mfaSetup(userId) {
    const u = (await db.query('SELECT email, mfa_enabled FROM users WHERE id=$1', [userId])).rows[0];
    if (u.mfa_enabled) throw E.conflict('MFA already enabled');
    const secret = authenticator.generateSecret();
    await db.query('UPDATE users SET mfa_secret_enc=$2 WHERE id=$1', [userId, encrypt(secret, `users.mfa:${userId}`)]);
    return { secret, otpauthUrl: authenticator.keyuri(u.email, 'Amrutam', secret) };
  }

  async function mfaEnable(userId, code, ctx) {
    return db.tx(async (c) => {
      const user = (await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      if (!user.mfa_secret_enc) throw E.badRequest('Call /auth/mfa/setup first');
      if (!authenticator.check(code, decrypt(user.mfa_secret_enc, `users.mfa:${userId}`))) throw E.unauthorized('Invalid MFA code');
      await c.query('UPDATE users SET mfa_enabled=true WHERE id=$1', [userId]);
      const tokens = await issueTokens(c, user, true);
      await audit.record(c, { actor: { id: userId, role: user.role }, action: 'auth.mfa_enabled', entity: 'user', entityId: userId, ctx });
      return tokens;
    });
  }

  async function me(userId) {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.role, u.status, u.mfa_enabled, p.full_name, p.phone_enc, p.dob_enc, p.gender FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1`, [userId]);
    if (!rows[0]) throw E.notFound('User not found');
    const r = rows[0];
    return { id: r.id, email: r.email, role: r.role, status: r.status, mfaEnabled: r.mfa_enabled, fullName: r.full_name, gender: r.gender,
      phone: decrypt(r.phone_enc, `profiles.phone:${r.id}`), dob: decrypt(r.dob_enc, `profiles.dob:${r.id}`) };
  }

  async function updateProfile(userId, input, ctx) {
    return db.tx(async (c) => {
      await c.query(`UPDATE profiles SET full_name=COALESCE($2, full_name), phone_enc=COALESCE($3, phone_enc), gender=COALESCE($4, gender), updated_at=now() WHERE user_id=$1`,
        [userId, input.fullName ?? null, input.phone ? encrypt(input.phone, `profiles.phone:${userId}`) : null, input.gender ?? null]);
      await audit.record(c, { actor: { id: userId }, action: 'profile.update', entity: 'profile', entityId: userId, metadata: { fields: Object.keys(input) }, ctx });
    }).then(() => me(userId));
  }
  return { register, login, refresh, logout, mfaSetup, mfaEnable, me, updateProfile };
}
module.exports = { createAuthService };
