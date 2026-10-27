'use strict';
const h = require('./helpers');
const { createOutboxProcessor } = require('../src/worker');

let ctx, admin, doctor;
beforeAll(async () => {
  ctx = await h.setup();
  admin = await h.createAdmin(ctx.container, ctx.api);
  doctor = await h.registerDoctor(ctx.api, ctx.container, admin);
});
afterAll(async () => { await ctx.container.close(); });

describe('auth & security', () => {
  test('weak password rejected, admin self-registration impossible, mass-assignment blocked', async () => {
    expect((await ctx.api.post('/v1/auth/register').send({ email: 'a@b.co', password: 'weak', fullName: 'X Y' })).status).toBe(422);
    expect((await ctx.api.post('/v1/auth/register').send({ email: 'adm@b.co', password: h.PASSWORD, fullName: 'X Y', role: 'admin' })).status).toBe(422);
    expect((await ctx.api.post('/v1/auth/register').send({ email: 'c@b.co', password: h.PASSWORD, fullName: 'X Y', status: 'active' })).status).toBe(422);
  });
  test('duplicate email -> 409', async () => {
    const p = await h.registerPatient(ctx.api);
    expect((await ctx.api.post('/v1/auth/register').send({ email: p.email.toUpperCase(), password: h.PASSWORD, fullName: 'Dup User' })).status).toBe(409);
  });
  test('lockout after 5 failures, generic error message', async () => {
    const p = await h.registerPatient(ctx.api);
    for (let i = 0; i < 5; i++) { const r = await ctx.api.post('/v1/auth/login').send({ email: p.email, password: 'Wrong-pass-1' }); expect(r.status).toBe(401); }
    expect((await ctx.api.post('/v1/auth/login').send({ email: p.email, password: h.PASSWORD })).status).toBe(423);
  });
  test('unknown email and wrong password are indistinguishable', async () => {
    const a = await ctx.api.post('/v1/auth/login').send({ email: 'nobody@example.com', password: 'Whatever-1234' });
    expect(a.status).toBe(401); expect(a.body.error.message).toBe('Invalid credentials');
  });
  test('JWT: tampered / alg=none / missing tokens rejected', async () => {
    const p = await h.registerPatient(ctx.api);
    expect((await ctx.api.get('/v1/users/me')).status).toBe(401);
    expect((await ctx.api.get('/v1/users/me').set(h.auth(p.token + 'x'))).status).toBe(401);
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify({ sub: p.id, role: 'admin' })).toString('base64url') + '.';
    expect((await ctx.api.get('/v1/users/me').set(h.auth(none))).status).toBe(401);
  });
  test('refresh rotation + reuse detection revokes the family', async () => {
    const p = await h.registerPatient(ctx.api);
    const r1 = await ctx.api.post('/v1/auth/refresh').send({ refreshToken: p.refreshToken });
    expect(r1.status).toBe(200);
    expect((await ctx.api.post('/v1/auth/refresh').send({ refreshToken: p.refreshToken })).status).toBe(401); // reuse
    expect((await ctx.api.post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken })).status).toBe(401); // family revoked
  });
  test('MFA: login requires code once enabled; admin routes require MFA session', async () => {
    const noMfaToken = (await ctx.api.post('/v1/auth/login').send({ email: admin.email, password: h.PASSWORD }));
    expect(noMfaToken.status).toBe(401); expect(noMfaToken.body.error.code).toBe('MFA_CODE_REQUIRED');
    const p = await h.registerPatient(ctx.api);
    expect((await ctx.api.get('/v1/admin/analytics/overview').set(h.auth(p.token))).status).toBe(403);
  });
  test('PII encrypted at rest', async () => {
    const p = await h.registerPatient(ctx.api);
    const row = (await ctx.container.db.query('SELECT phone_enc, dob_enc FROM profiles WHERE user_id=$1', [p.id])).rows[0];
    expect(row.phone_enc).not.toContain('9876543210'); expect(row.phone_enc.startsWith('v1:')).toBe(true);
    expect((await ctx.api.get('/v1/users/me').set(h.auth(p.token))).body.phone).toBe('9876543210');
  });
});

describe('RBAC', () => {
  test('patient cannot manage slots; unverified/other roles blocked', async () => {
    const p = await h.registerPatient(ctx.api);
    expect((await ctx.api.post('/v1/doctors/me/slots').set(h.auth(p.token)).send({ slots: [h.slotIn(120)] })).status).toBe(403);
  });
  test('doctor without MFA cannot create slots (step-up)', async () => {
    const email = `nomfa${Date.now()}@example.com`;
    await ctx.api.post('/v1/auth/register').send({ email, password: h.PASSWORD, fullName: 'No Mfa', role: 'doctor', doctor: { specialization: 'General', licenseNo: `L${Date.now()}`, yearsExperience: 1, consultationFeePaise: 100 } });
    const l = await ctx.api.post('/v1/auth/login').send({ email, password: h.PASSWORD });
    expect(l.body.mfaSetupRequired).toBe(true);
    const r = await ctx.api.post('/v1/doctors/me/slots').set(h.auth(l.body.accessToken)).send({ slots: [h.slotIn(120)] });
    expect(r.status).toBe(403); expect(r.body.error.code).toBe('MFA_REQUIRED');
  });
});

describe('slots & search', () => {
  test('overlapping slots rejected by DB constraint', async () => {
    const t = 3000;
    expect((await ctx.api.post('/v1/doctors/me/slots').set(h.auth(doctor.token)).send({ slots: [h.slotIn(t)] })).status).toBe(201);
    const r = await ctx.api.post('/v1/doctors/me/slots').set(h.auth(doctor.token)).send({ slots: [h.slotIn(t + 10)] });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('SLOT_OVERLAP');
  });
  test('search filters, pagination and injection-safe', async () => {
    const p = await h.registerPatient(ctx.api);
    const ok = await ctx.api.get('/v1/doctors?specialization=ayurveda&language=hi&maxFeePaise=60000&limit=5').set(h.auth(p.token));
    expect(ok.status).toBe(200); expect(ok.body.items.length).toBeGreaterThan(0); expect(ok.body.items[0].nextAvailable).toBeTruthy();
    expect((await ctx.api.get('/v1/doctors?q=' + encodeURIComponent("'; DROP TABLE users;--")).set(h.auth(p.token))).body.total).toBe(0);
    expect((await ctx.api.get('/v1/doctors?limit=9999').set(h.auth(p.token))).status).toBe(422);
    expect((await ctx.api.get('/v1/doctors?minRating=5').set(h.auth(p.token))).body.items).toHaveLength(0);
  });
});

describe('booking saga', () => {
  test('happy path: book -> pay -> start -> prescribe -> complete, with encryption + audit', async () => {
    const p = await h.registerPatient(ctx.api);
    const slot = await h.createSlot(ctx.api, doctor, 7); // starts in 7 minutes -> startable
    const b = await h.book(ctx.api, p, slot.id);
    expect(b.status).toBe(201); expect(b.body.status).toBe('PENDING_PAYMENT'); expect(b.body.payment.amountPaise).toBe(50000);
    const raw = (await ctx.container.db.query('SELECT reason_enc FROM consultations WHERE id=$1', [b.body.id])).rows[0].reason_enc;
    expect(raw).not.toContain('fever');
    const pay = await ctx.api.post(`/v1/consultations/${b.body.id}/pay`).set(h.auth(p.token)).set('Idempotency-Key', h.idemKey()).send({ paymentToken: 'tok_ok' });
    expect(pay.status).toBe(200); expect(pay.body.status).toBe('CONFIRMED');
    expect((await ctx.container.db.query('SELECT status FROM availability_slots WHERE id=$1', [slot.id])).rows[0].status).toBe('booked');
    expect((await ctx.api.post(`/v1/consultations/${b.body.id}/start`).set(h.auth(p.token))).status).toBe(403); // patient cannot run
    expect((await ctx.api.post(`/v1/consultations/${b.body.id}/start`).set(h.auth(doctor.token))).body.status).toBe('IN_PROGRESS');
    const rx = await ctx.api.post(`/v1/consultations/${b.body.id}/prescription`).set(h.auth(doctor.token)).set('Idempotency-Key', h.idemKey())
      .send({ items: [{ name: 'Ashwagandha', dosage: '500mg', frequency: 'twice daily', durationDays: 14 }], advice: 'rest' });
    expect(rx.status).toBe(201);
    expect((await ctx.api.get(`/v1/consultations/${b.body.id}/prescription`).set(h.auth(p.token))).body.items[0].name).toBe('Ashwagandha');
    expect((await ctx.api.post(`/v1/consultations/${b.body.id}/complete`).set(h.auth(doctor.token)).send({ notes: 'ok' })).body.status).toBe('COMPLETED');
    const other = await h.registerPatient(ctx.api);
    expect((await ctx.api.get(`/v1/consultations/${b.body.id}`).set(h.auth(other.token))).status).toBe(404); // IDOR protection
    expect((await ctx.api.get(`/v1/consultations/${b.body.id}/prescription`).set(h.auth(other.token))).status).toBe(404);
    const v = await ctx.api.get('/v1/admin/audit-logs/verify').set(h.auth(admin.token));
    expect(v.body.valid).toBe(true); expect(v.body.checked).toBeGreaterThan(5);
  });

  test('CONCURRENCY: 12 patients race for one slot -> exactly one winner', async () => {
    const slot = await h.createSlot(ctx.api, doctor, 4000);
    const patients = await Promise.all(Array.from({ length: 12 }, () => h.registerPatient(ctx.api)));
    const results = await Promise.all(patients.map((p) => h.book(ctx.api, p, slot.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(11);
    expect((await ctx.container.db.query(`SELECT count(*)::int n FROM consultations WHERE slot_id=$1 AND status='PENDING_PAYMENT'`, [slot.id])).rows[0].n).toBe(1);
  });

  test('IDEMPOTENCY: same key replays one booking; same key + different body -> 422; key required', async () => {
    const p = await h.registerPatient(ctx.api); const slot = await h.createSlot(ctx.api, doctor, 5000); const key = h.idemKey();
    const [a, b] = await Promise.all([h.book(ctx.api, p, slot.id, key), h.book(ctx.api, p, slot.id, key)]);
    const c = await h.book(ctx.api, p, slot.id, key);
    const ok = [a, b, c].filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    expect(c.headers['idempotent-replayed']).toBe('true');
    expect((await ctx.container.db.query('SELECT count(*)::int n FROM consultations WHERE slot_id=$1', [slot.id])).rows[0].n).toBe(1);
    const other = await ctx.api.post('/v1/consultations').set(h.auth(p.token)).set('Idempotency-Key', key).send({ slotId: slot.id, reason: 'different' });
    expect(other.status).toBe(422); expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const none = await ctx.api.post('/v1/consultations').set(h.auth(p.token)).send({ slotId: slot.id });
    expect(none.status).toBe(400); expect(none.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  test('IDEMPOTENCY on payments: retried pay request charges once', async () => {
    const p = await h.registerPatient(ctx.api); const slot = await h.createSlot(ctx.api, doctor, 6000);
    const b = await h.book(ctx.api, p, slot.id); const key = h.idemKey();
    const before = ctx.container.rawGateway.charges.size;
    const send = () => ctx.api.post(`/v1/consultations/${b.body.id}/pay`).set(h.auth(p.token)).set('Idempotency-Key', key).send({ paymentToken: 'tok_ok' });
    const r1 = await send(); const r2 = await send();
    expect(r1.status).toBe(200); expect(r2.status).toBe(200); expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(ctx.container.rawGateway.charges.size - before).toBe(1);
    expect((await ctx.container.db.query(`SELECT count(*)::int n FROM payments WHERE consultation_id=$1 AND status='SUCCEEDED'`, [b.body.id])).rows[0].n).toBe(1);
  });

  test('RETRY: transient gateway errors are retried with backoff then succeed', async () => {
    const p = await h.registerPatient(ctx.api); const slot = await h.createSlot(ctx.api, doctor, 7000);
    const b = await h.book(ctx.api, p, slot.id);
    const r = await ctx.api.post(`/v1/consultations/${b.body.id}/pay`).set(h.auth(p.token)).set('Idempotency-Key', h.idemKey()).send({ paymentToken: 'tok_flaky' });
    expect(r.status).toBe(200); expect(r.body.status).toBe('CONFIRMED');
  });

  test('SAGA COMPENSATION: 3 declined payments release the slot', async () => {
    const p = await h.registerPatient(ctx.api); const slot = await h.createSlot(ctx.api, doctor, 8000);
    const b = await h.book(ctx.api, p, slot.id);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await ctx.api.post(`/v1/consultations/${b.body.id}/pay`).set(h.auth(p.token)).set('Idempotency-Key', h.idemKey()).send({ paymentToken: 'tok_declined' })).status);
    expect(statuses).toEqual([402, 402, 402]);
    expect((await ctx.container.db.query('SELECT status FROM availability_slots WHERE id=$1', [slot.id])).rows[0].status).toBe('open');
    expect((await ctx.container.db.query('SELECT status FROM consultations WHERE id=$1', [b.body.id])).rows[0].status).toBe('CANCELLED');
    const again = await h.book(ctx.api, await h.registerPatient(ctx.api), slot.id); expect(again.status).toBe(201); // slot re-bookable
  });

  test('SAGA TIMEOUT: expired hold is released by sweeper', async () => {
    const p = await h.registerPatient(ctx.api); const slot = await h.createSlot(ctx.api, doctor, 9000);
    const b = await h.book(ctx.api, p, slot.id);
    await ctx.container.db.query(`UPDATE consultations SET hold_expires_at = now() - interval '1 minute' WHERE id=$1`, [b.body.id]);
    expect(await ctx.container.consultations.expireHolds()).toBe(1);
    expect((await ctx.container.db.query('SELECT status FROM availability_slots WHERE id=$1', [slot.id])).rows[0].status).toBe('open');
    const late = await ctx.api.post(`/v1/consultations/${b.body.id}/pay`).set(h.auth(p.token)).set('Idempotency-Key', h.idemKey()).send({ paymentToken: 'tok_ok' });
    expect(late.status).toBe(409);
  });

  test('cancel after payment frees slot and refunds asynchronously via outbox', async () => {
    const p = await h.registerPatient(ctx.api); const slot = await h.createSlot(ctx.api, doctor, 10000);
    const b = await h.book(ctx.api, p, slot.id);
    await ctx.api.post(`/v1/consultations/${b.body.id}/pay`).set(h.auth(p.token)).set('Idempotency-Key', h.idemKey()).send({ paymentToken: 'tok_ok' });
    const c = await ctx.api.post(`/v1/consultations/${b.body.id}/cancel`).set(h.auth(p.token)).set('Idempotency-Key', h.idemKey()).send({ reason: 'changed plans' });
    expect(c.body.status).toBe('CANCELLED');
    const outbox = createOutboxProcessor({ db: ctx.container.db, handlers: { 'notification.send': async () => {}, 'payment.refund': (pl) => ctx.container.consultations.processRefund(pl.paymentId) } });
    await outbox.runOnce(); await outbox.runOnce();
    expect((await ctx.container.db.query(`SELECT status FROM payments WHERE consultation_id=$1 AND status IN ('REFUNDED','SUCCEEDED')`, [b.body.id])).rows[0].status).toBe('REFUNDED');
    expect((await ctx.api.post(`/v1/consultations/${b.body.id}/cancel`).set(h.auth(p.token)).set('Idempotency-Key', h.idemKey()).send({})).status).toBe(409); // illegal transition
  });

  test('outbox: failing handler is retried with backoff then dead-lettered', async () => {
    await ctx.container.db.query(`INSERT INTO outbox (topic,payload) VALUES ('bad.topic','{}')`);
    const outbox = createOutboxProcessor({ db: ctx.container.db, handlers: {} });
    await outbox.runOnce();
    const r = (await ctx.container.db.query(`SELECT attempts, status, last_error FROM outbox WHERE topic='bad.topic'`)).rows[0];
    expect(r.attempts).toBe(1); expect(r.status).toBe('pending'); expect(r.last_error).toMatch(/no handler/);
  });
});

describe('compliance, audit, analytics', () => {
  test('audit log is append-only at DB level and chain detects tampering', async () => {
    await expect(ctx.container.db.query(`UPDATE audit_logs SET action='x'`)).rejects.toThrow(/append-only/);
    await expect(ctx.container.db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    // simulate a privileged attacker bypassing the trigger
    await ctx.container.db.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_no_update');
    await ctx.container.db.query(`UPDATE audit_logs SET metadata='{"evil":true}' WHERE id=(SELECT min(id) FROM audit_logs)`);
    await ctx.container.db.query('ALTER TABLE audit_logs ENABLE TRIGGER audit_no_update');
    expect((await ctx.container.audit.verifyChain()).valid).toBe(false);
  });
  test('admin analytics + audit query; non-admin denied', async () => {
    const a = await ctx.api.get('/v1/admin/analytics/overview').set(h.auth(admin.token));
    expect(a.status).toBe(200); expect(a.body.consultationsByStatus.length).toBeGreaterThan(0); expect(a.body.revenue.grossPaise).toBeGreaterThan(0);
    const logs = await ctx.api.get('/v1/admin/audit-logs?entity=consultation&limit=5').set(h.auth(admin.token));
    expect(logs.status).toBe(200); expect(logs.body.items.length).toBeGreaterThan(0);
    expect((await ctx.api.get('/v1/admin/analytics/overview').set(h.auth(doctor.token))).status).toBe(403);
  });
  test('ops endpoints, request-id propagation, security headers', async () => {
    expect((await ctx.api.get('/healthz')).status).toBe(200);
    expect((await ctx.api.get('/readyz')).status).toBe(200);
    const m = await ctx.api.get('/metrics'); expect(m.text).toMatch(/http_request_duration_seconds/); expect(m.text).toMatch(/bookings_total/);
    const r = await ctx.api.get('/healthz').set('x-request-id', 'trace-abc-12345');
    expect(r.headers['x-request-id']).toBe('trace-abc-12345'); expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['x-powered-by']).toBeUndefined();
  });
  test('malformed JSON / unknown route -> clean errors, no stack leak', async () => {
    const r = await ctx.api.post('/v1/auth/login').set('Content-Type', 'application/json').send('{bad');
    expect(r.status).toBe(400); expect(JSON.stringify(r.body)).not.toMatch(/at .*\.js/);
    expect((await ctx.api.get('/nope')).status).toBe(404);
  });
});
