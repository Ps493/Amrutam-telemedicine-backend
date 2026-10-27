'use strict';
const { E } = require('../../lib/errors');
const { encrypt, decrypt } = require('../../lib/crypto');

function createPrescriptionService({ db, audit }) {
  const present = (r) => ({ id: r.id, consultationId: r.consultation_id, doctorId: r.doctor_id, patientId: r.patient_id,
    items: JSON.parse(decrypt(r.items_enc, `prescriptions.items:${r.consultation_id}`)), advice: decrypt(r.advice_enc, `prescriptions.advice:${r.consultation_id}`), createdAt: r.created_at });

  async function create(doctor, consultationId, { items, advice }, ctx) {
    return db.tx(async (c) => {
      const con = (await c.query('SELECT * FROM consultations WHERE id=$1 FOR UPDATE', [consultationId])).rows[0];
      if (!con || con.doctor_id !== doctor.id) throw E.notFound('Consultation not found');
      if (!['IN_PROGRESS', 'COMPLETED'].includes(con.status)) throw E.conflict('Prescription allowed only for in-progress/completed consultations', 'INVALID_STATE');
      const r = await c.query(
        `INSERT INTO prescriptions (consultation_id, doctor_id, patient_id, items_enc, advice_enc) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [consultationId, doctor.id, con.patient_id, encrypt(JSON.stringify(items), `prescriptions.items:${consultationId}`), encrypt(advice, `prescriptions.advice:${consultationId}`)])
        .catch((e) => { if (e.code === '23505') throw E.conflict('Prescription already issued for this consultation', 'PRESCRIPTION_EXISTS'); throw e; });
      await audit.record(c, { actor: doctor, action: 'prescription.create', entity: 'prescription', entityId: r.rows[0].id, metadata: { consultationId }, ctx });
      return present(r.rows[0]);
    });
  }

  async function get(user, consultationId, ctx) {
    const { rows } = await db.query('SELECT * FROM prescriptions WHERE consultation_id=$1', [consultationId]);
    const r = rows[0];
    if (!r || (r.patient_id !== user.id && r.doctor_id !== user.id)) throw E.notFound('Prescription not found');
    await audit.recordStandalone({ actor: user, action: 'prescription.read', entity: 'prescription', entityId: r.id, ctx });
    return present(r);
  }
  return { create, get };
}
module.exports = { createPrescriptionService };
