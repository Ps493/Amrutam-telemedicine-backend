'use strict';
// Dev seed: 1 admin, 3 verified doctors with slots, 1 patient. Prints credentials. NEVER run in production.
const bcrypt = require('bcryptjs');
const { migrate } = require('./migrate');
const { createDb } = require('../src/lib/db');
const { encrypt } = require('../src/lib/crypto');

(async () => {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed production');
  await migrate();
  const db = createDb(); const pw = bcrypt.hashSync('Str0ngPassw0rd!', 10);
  const mk = async (email, role, name, status = 'active') => {
    const { rows } = await db.query(`INSERT INTO users (email,password_hash,role,status) VALUES ($1,$2,$3,$4) ON CONFLICT (lower(email)) DO UPDATE SET email=EXCLUDED.email RETURNING id`, [email, pw, role, status]);
    await db.query(`INSERT INTO profiles (user_id, full_name, phone_enc) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [rows[0].id, name, encrypt('9876543210', `profiles.phone:${rows[0].id}`)]);
    return rows[0].id;
  };
  await mk('admin@amrutam.test', 'admin', 'Admin');
  await mk('patient@amrutam.test', 'patient', 'Demo Patient');
  const docs = [['Dr. Asha Rao', 'Ayurveda', 600], ['Dr. Vikram Sen', 'Panchakarma', 800], ['Dr. Meera Iyer', 'Dermatology', 700]];
  for (const [i, [name, spec, fee]] of docs.entries()) {
    const id = await mk(`doctor${i + 1}@amrutam.test`, 'doctor', name);
    await db.query(`INSERT INTO doctors (user_id, specialization, license_no, years_experience, consultation_fee_paise, languages, rating, is_verified) VALUES ($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT DO NOTHING`,
      [id, spec, `SEED-LIC-${i}`, 5 + i * 3, fee * 100, ['en', 'hi'], 4.2 + i * 0.2]);
    for (let d = 1; d <= 3; d++) for (let h = 10; h < 13; h++) {
      const st = new Date(); st.setUTCDate(st.getUTCDate() + d); st.setUTCHours(h, 0, 0, 0);
      await db.query(`INSERT INTO availability_slots (doctor_id,start_time,end_time) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, st, new Date(st.getTime() + 30 * 60000)]);
    }
  }
  console.log('Seeded. Password for all: Str0ngPassw0rd!  (admin/doctors must enrol MFA via /v1/auth/mfa/setup)');
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
