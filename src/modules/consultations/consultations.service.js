'use strict';
const crypto = require('crypto');
const config = require('../../config');
const { E } = require('../../lib/errors');
const { encrypt, decrypt } = require('../../lib/crypto');
const metrics = require('../../lib/metrics');
const { assertTransition } = require('./stateMachine');

const MAX_PAY_ATTEMPTS = 3;
const conflict = (m) => E.conflict(m, 'INVALID_STATE');

function createConsultationService({ db, audit, gateway, cache }) {
  const present = (r) => ({
    id: r.id, patientId: r.patient_id, doctorId: r.doctor_id, slotId: r.slot_id, status: r.status,
    scheduledStart: r.scheduled_start, scheduledEnd: r.scheduled_end, holdExpiresAt: r.hold_expires_at,
    reason: decrypt(r.reason_enc, `consultations.reason:${r.id}`), notes: decrypt(r.notes_enc, `consultations.notes:${r.id}`),
    createdAt: r.created_at,
  });

  // ===== SAGA STEP 1 (local ACID tx): reserve slot + create consultation + create payment intent + outbox event =====
  async function book(user, { slotId, reason }, ctx) {
    try {
      const out = await db.tx(async (c) => {
        // Atomic compare-and-set: only ONE concurrent request can move open -> held.
        const s = await c.query(
          `UPDATE availability_slots SET status='held', version=version+1 WHERE id=$1 AND status='open' AND start_time > now() + interval '5 minutes'
           RETURNING id, doctor_id, start_time, end_time`, [slotId]);
        if (!s.rowCount) throw E.conflict('Slot is not available', 'SLOT_UNAVAILABLE');
        const slot = s.rows[0];
        const doc = (await c.query('SELECT consultation_fee_paise, is_verified FROM doctors WHERE user_id=$1', [slot.doctor_id])).rows[0];
        if (!doc?.is_verified) throw E.conflict('Doctor unavailable', 'SLOT_UNAVAILABLE');
        const id = crypto.randomUUID();
        const row = (await c.query(
          `INSERT INTO consultations (id, patient_id, doctor_id, slot_id, status, scheduled_start, scheduled_end, reason_enc, hold_expires_at)
           VALUES ($1,$2,$3,$4,'PENDING_PAYMENT',$5,$6,$7, now() + ($8 || ' minutes')::interval) RETURNING *`,
          [id, user.id, slot.doctor_id, slot.id, slot.start_time, slot.end_time, encrypt(reason, `consultations.reason:${id}`), config.holdMinutes])).rows[0];
        const pay = (await c.query(`INSERT INTO payments (consultation_id, amount_paise, status) VALUES ($1,$2,'INITIATED') RETURNING id, amount_paise, status`, [id, doc.consultation_fee_paise])).rows[0];
        await c.query(`INSERT INTO outbox (topic, payload) VALUES ('notification.send', $1)`, [JSON.stringify({ type: 'booking.pending', consultationId: id, to: user.id })]);
        await audit.record(c, { actor: user, action: 'consultation.book', entity: 'consultation', entityId: id, metadata: { slotId }, ctx });
        return { ...present(row), payment: { id: pay.id, amountPaise: pay.amount_paise, status: pay.status } };
      });
      metrics.bookings.inc({ outcome: 'held' });
      await cache.del('search:');
      return out;
    } catch (e) { metrics.bookings.inc({ outcome: e.code === 'SLOT_UNAVAILABLE' ? 'conflict' : 'error' }); throw e; }
  }

  async function loadFor(client, user, id, { lock = false } = {}) {
    const { rows } = await client.query(`SELECT * FROM consultations WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    const c = rows[0];
    if (!c) throw E.notFound('Consultation not found');
    const owner = c.patient_id === user.id || c.doctor_id === user.id;
    if (!owner && user.role !== 'admin') throw E.notFound('Consultation not found'); // 404 not 403: no existence oracle
    return c;
  }

  // ===== SAGA STEP 2: charge (network call OUTSIDE any DB tx) then commit or compensate =====
  async function pay(user, id, { paymentToken }, ctx) {
    const c0 = await loadFor(db, user, id);
    if (c0.patient_id !== user.id) throw E.forbidden();
    if (c0.status !== 'PENDING_PAYMENT') throw conflict(`Consultation is ${c0.status}`);
    if (c0.hold_expires_at < new Date()) throw E.conflict('Slot hold expired', 'HOLD_EXPIRED');
    const payment = (await db.query(`SELECT * FROM payments WHERE consultation_id=$1 AND status='INITIATED' ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
    if (!payment) throw conflict('No payment pending');

    let charge;
    try {
      charge = await gateway.charge({ amountPaise: payment.amount_paise, idempotencyKey: payment.id, token: paymentToken });
    } catch (err) {
      metrics.payments.inc({ outcome: 'failed' });
      return handleChargeFailure(user, c0, payment, err, ctx);
    }

    const result = await db.tx(async (c) => {
      const cur = await loadFor(c, user, id, { lock: true });
      if (cur.status !== 'PENDING_PAYMENT') {
        // Hold expired / cancelled while we were charging -> COMPENSATE: queue refund, never keep money without a booking.
        await c.query(`UPDATE payments SET status='SUCCEEDED', provider_ref=$2, updated_at=now() WHERE id=$1`, [payment.id, charge.providerRef]);
        await c.query(`INSERT INTO outbox (topic, payload) VALUES ('payment.refund', $1)`, [JSON.stringify({ paymentId: payment.id })]);
        await audit.record(c, { actor: user, action: 'payment.late_success_refund_queued', entity: 'payment', entityId: payment.id, ctx });
        return { late: true };
      }
      await c.query(`UPDATE payments SET status='SUCCEEDED', provider_ref=$2, updated_at=now() WHERE id=$1`, [payment.id, charge.providerRef]);
      assertTransition(cur.status, 'CONFIRMED', conflict);
      const row = (await c.query(`UPDATE consultations SET status='CONFIRMED', hold_expires_at=NULL, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [id])).rows[0];
      await c.query(`UPDATE availability_slots SET status='booked', version=version+1 WHERE id=$1`, [cur.slot_id]);
      await c.query(`INSERT INTO outbox (topic, payload) VALUES ('notification.send', $1)`, [JSON.stringify({ type: 'booking.confirmed', consultationId: id, to: [cur.patient_id, cur.doctor_id] })]);
      await audit.record(c, { actor: user, action: 'consultation.confirmed', entity: 'consultation', entityId: id, metadata: { paymentId: payment.id }, ctx });
      return { consultation: present(row) };
    });
    if (result.late) throw E.conflict('Booking expired before payment completed; payment will be refunded', 'HOLD_EXPIRED');
    metrics.payments.inc({ outcome: 'succeeded' });
    return result.consultation;
  }

  async function handleChargeFailure(user, c0, payment, err, ctx) {
    const attempts = (await db.query(`SELECT count(*)::int n FROM payments WHERE consultation_id=$1 AND status='FAILED'`, [c0.id])).rows[0].n + 1;
    await db.tx(async (c) => {
      await c.query(`UPDATE payments SET status='FAILED', failure_reason=$2, updated_at=now() WHERE id=$1`, [payment.id, String(err.message).slice(0, 200)]);
      if (attempts >= MAX_PAY_ATTEMPTS) {
        // COMPENSATION: release slot, cancel consultation.
        await c.query(`UPDATE consultations SET status='CANCELLED', cancel_reason='payment_failed', hold_expires_at=NULL, version=version+1, updated_at=now() WHERE id=$1 AND status='PENDING_PAYMENT'`, [c0.id]);
        await c.query(`UPDATE availability_slots SET status='open', version=version+1 WHERE id=$1 AND status='held'`, [c0.slot_id]);
      } else {
        await c.query(`INSERT INTO payments (consultation_id, amount_paise, status) VALUES ($1,$2,'INITIATED')`, [c0.id, payment.amount_paise]);
      }
      await audit.record(c, { actor: user, action: 'payment.failed', entity: 'payment', entityId: payment.id, metadata: { attempts, transient: !!err.transient }, ctx });
    });
    if (attempts >= MAX_PAY_ATTEMPTS) await cache.del('search:');
    if (err.circuitOpen || err.transient) throw E.upstream('Payment provider unavailable, please retry');
    throw new (require('../../lib/errors').AppError)(402, 'PAYMENT_FAILED', attempts >= MAX_PAY_ATTEMPTS ? 'Payment failed; booking released' : 'Payment failed; you may retry');
  }

  async function transition(user, id, to, { notes, reason } = {}, ctx) {
    const row = await db.tx(async (c) => {
      const cur = await loadFor(c, user, id, { lock: true });
      assertTransition(cur.status, to, conflict);
      if ((to === 'IN_PROGRESS' || to === 'COMPLETED') && cur.doctor_id !== user.id) throw E.forbidden('Only the assigned doctor can do this');
      if (to === 'IN_PROGRESS' && new Date(cur.scheduled_start) - Date.now() > 10 * 60_000) throw E.conflict('Too early to start', 'TOO_EARLY');
      if (to === 'CANCELLED' && user.role !== 'admin' && cur.patient_id !== user.id && cur.doctor_id !== user.id) throw E.forbidden();
      const upd = (await c.query(
        `UPDATE consultations SET status=$2, notes_enc=COALESCE($3, notes_enc), cancelled_by=$4, cancel_reason=$5, hold_expires_at=NULL, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, to, notes ? encrypt(notes, `consultations.notes:${id}`) : null, to === 'CANCELLED' ? user.id : null, to === 'CANCELLED' ? (reason || null) : null])).rows[0];
      if (to === 'CANCELLED') {
        await c.query(`UPDATE availability_slots SET status='open', version=version+1 WHERE id=$1 AND status IN ('held','booked') AND start_time > now()`, [cur.slot_id]);
        const paid = (await c.query(`SELECT id FROM payments WHERE consultation_id=$1 AND status='SUCCEEDED'`, [id])).rows[0];
        if (paid) await c.query(`INSERT INTO outbox (topic, payload) VALUES ('payment.refund', $1)`, [JSON.stringify({ paymentId: paid.id })]); // refund is a saga step handled asynchronously
        await c.query(`UPDATE payments SET status='FAILED', failure_reason='cancelled' WHERE consultation_id=$1 AND status='INITIATED'`, [id]);
      }
      await audit.record(c, { actor: user, action: `consultation.${to.toLowerCase()}`, entity: 'consultation', entityId: id, metadata: { from: cur.status }, ctx });
      return upd;
    });
    if (to === 'CANCELLED') await cache.del('search:');
    return present(row);
  }

  async function get(user, id, ctx) {
    const row = await loadFor(db, user, id);
    if (user.role === 'admin') await audit.recordStandalone({ actor: user, action: 'consultation.admin_read', entity: 'consultation', entityId: id, ctx }); // PHI access by admins is audited
    return present(row);
  }

  async function list(user, { status, page, limit }) {
    const col = user.role === 'doctor' ? 'doctor_id' : 'patient_id';
    const p = [user.id]; let w = `${col}=$1`;
    if (status) { p.push(status); w += ` AND status=$${p.length}`; }
    p.push(limit, (page - 1) * limit);
    const { rows } = await db.readQuery(`SELECT * FROM consultations WHERE ${w} ORDER BY scheduled_start DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    return { page, limit, items: rows.map(present) };
  }

  // Saga timeout compensation, run by worker: release expired holds.
  async function expireHolds(batch = 100) {
    return db.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, slot_id FROM consultations WHERE status='PENDING_PAYMENT' AND hold_expires_at < now() ORDER BY hold_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch]);
      for (const r of rows) {
        await c.query(`UPDATE consultations SET status='EXPIRED', hold_expires_at=NULL, version=version+1, updated_at=now() WHERE id=$1`, [r.id]);
        await c.query(`UPDATE availability_slots SET status='open', version=version+1 WHERE id=$1 AND status='held'`, [r.slot_id]);
        await c.query(`UPDATE payments SET status='FAILED', failure_reason='expired' WHERE consultation_id=$1 AND status='INITIATED'`, [r.id]);
      }
      if (rows.length) await audit.record(c, { actor: { id: null, role: 'system' }, action: 'consultation.holds_expired', entity: 'consultation', metadata: { ids: rows.map((r) => r.id) } });
      return rows.length;
    });
  }

  async function processRefund(paymentId) {
    const p = (await db.query('SELECT * FROM payments WHERE id=$1', [paymentId])).rows[0];
    if (!p || p.status === 'REFUNDED') return; // idempotent consumer
    await gateway.refund({ providerRef: p.provider_ref });
    await db.tx(async (c) => {
      await c.query(`UPDATE payments SET status='REFUNDED', updated_at=now() WHERE id=$1`, [paymentId]);
      await audit.record(c, { actor: { id: null, role: 'system' }, action: 'payment.refunded', entity: 'payment', entityId: paymentId });
    });
  }
  return { book, pay, transition, get, list, expireHolds, processRefund };
}
module.exports = { createConsultationService };
