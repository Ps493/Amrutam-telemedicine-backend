'use strict';
const { E } = require('../../lib/errors');
const { cached } = require('../../lib/cache');

function createDoctorService({ db, audit, cache }) {
  async function createSlots(doctorId, slots, ctx) {
    const doc = (await db.query('SELECT is_verified FROM doctors WHERE user_id=$1', [doctorId])).rows[0];
    if (!doc) throw E.forbidden('Not a doctor');
    if (!doc.is_verified) throw E.forbidden('Doctor profile not yet verified');
    const out = await db.tx(async (c) => {
      const created = [];
      for (const s of slots) {
        // Overlap is rejected by the EXCLUDE constraint (23P01 -> 409), safe under concurrency.
        const r = await c.query(`INSERT INTO availability_slots (doctor_id, start_time, end_time) VALUES ($1,$2,$3) RETURNING id, start_time, end_time, status`, [doctorId, s.startTime, s.endTime]);
        created.push(r.rows[0]);
      }
      await audit.record(c, { actor: { id: doctorId, role: 'doctor' }, action: 'slots.create', entity: 'doctor', entityId: doctorId, metadata: { count: created.length }, ctx });
      return created;
    });
    await cache.del('search:');
    return out;
  }

  async function deleteSlot(doctorId, slotId, ctx) {
    await db.tx(async (c) => {
      const r = await c.query(`UPDATE availability_slots SET status='cancelled', version=version+1 WHERE id=$1 AND doctor_id=$2 AND status='open' RETURNING id`, [slotId, doctorId]);
      if (!r.rowCount) throw E.conflict('Slot not found or not open (booked/held slots must be cancelled via consultation)');
      await audit.record(c, { actor: { id: doctorId, role: 'doctor' }, action: 'slot.cancel', entity: 'slot', entityId: slotId, ctx });
    });
    await cache.del('search:');
  }

  async function listSlots(doctorId, { from, to }) {
    const { rows } = await db.readQuery(
      `SELECT id, start_time, end_time FROM availability_slots WHERE doctor_id=$1 AND status='open' AND start_time > now()
       AND start_time >= COALESCE($2, now()) AND start_time < COALESCE($3, now() + interval '30 days') ORDER BY start_time LIMIT 500`, [doctorId, from || null, to || null]);
    return rows;
  }

  // Search + filter. Cache-aside (30s) with single-flight; invalidated on slot changes.
  async function search(q) {
    const key = `search:${JSON.stringify(q)}`;
    return cached(cache, key, 30, async () => {
      const p = []; const w = ['d.is_verified', `u.status='active'`];
      const add = (sql, v) => { p.push(v); w.push(sql.replace('?', `$${p.length}`)); };
      if (q.q) add(`p.full_name ILIKE '%' || ? || '%'`, q.q.replace(/[%_\\]/g, '\\$&'));
      if (q.specialization) add('lower(d.specialization) = lower(?)', q.specialization);
      if (q.language) add('? = ANY(d.languages)', q.language);
      if (q.minRating !== undefined) add('d.rating >= ?', q.minRating);
      if (q.maxFeePaise !== undefined) add('d.consultation_fee_paise <= ?', q.maxFeePaise);
      if (q.availableOn) add(`EXISTS (SELECT 1 FROM availability_slots s WHERE s.doctor_id=d.user_id AND s.status='open' AND s.start_time::date = ?::date AND s.start_time > now())`, q.availableOn);
      const order = { rating: 'd.rating DESC', fee: 'd.consultation_fee_paise ASC', experience: 'd.years_experience DESC' }[q.sort || 'rating'];
      p.push(q.limit, (q.page - 1) * q.limit);
      const { rows } = await db.readQuery(
        `SELECT d.user_id AS id, p.full_name, d.specialization, d.years_experience, d.consultation_fee_paise, d.languages, d.rating, d.bio,
           (SELECT min(start_time) FROM availability_slots s WHERE s.doctor_id=d.user_id AND s.status='open' AND s.start_time > now()) AS next_available,
           count(*) OVER() AS total
         FROM doctors d JOIN users u ON u.id=d.user_id JOIN profiles p ON p.user_id=d.user_id
         WHERE ${w.join(' AND ')} ORDER BY ${order}, d.user_id LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
      return { page: q.page, limit: q.limit, total: rows[0] ? Number(rows[0].total) : 0,
        items: rows.map((r) => ({ id: r.id, fullName: r.full_name, specialization: r.specialization, yearsExperience: r.years_experience,
          consultationFeePaise: r.consultation_fee_paise, languages: r.languages, rating: Number(r.rating), bio: r.bio, nextAvailable: r.next_available })) };
    });
  }

  async function verify(adminUser, doctorId, ctx) {
    await db.tx(async (c) => {
      const r = await c.query('UPDATE doctors SET is_verified=true WHERE user_id=$1 RETURNING user_id', [doctorId]);
      if (!r.rowCount) throw E.notFound('Doctor not found');
      await c.query(`UPDATE users SET status='active', updated_at=now() WHERE id=$1`, [doctorId]);
      await audit.record(c, { actor: adminUser, action: 'doctor.verify', entity: 'doctor', entityId: doctorId, ctx });
    });
    await cache.del('search:');
  }
  return { createSlots, deleteSlot, listSlots, search, verify };
}
module.exports = { createDoctorService };
