'use strict';
// Key rotation: 1) add new key to ENCRYPTION_KEYRING  2) set ACTIVE_KEY_VERSION=vN  3) deploy  4) run this script to re-encrypt old rows
// 5) once `npm run rotate-keys -- --check` reports 0 stale rows, retire the old key. Resumable & idempotent (batches, only touches stale rows).
const { createDb } = require('../src/lib/db');
const { encrypt, decrypt, needsRotation } = require('../src/lib/crypto');

// [table, pk, column, aad builder, pk column for aad]
const TARGETS = [
  ['profiles', 'user_id', 'phone_enc', (id) => `profiles.phone:${id}`], ['profiles', 'user_id', 'dob_enc', (id) => `profiles.dob:${id}`],
  ['users', 'id', 'mfa_secret_enc', (id) => `users.mfa:${id}`],
  ['consultations', 'id', 'reason_enc', (id) => `consultations.reason:${id}`], ['consultations', 'id', 'notes_enc', (id) => `consultations.notes:${id}`],
  ['prescriptions', 'consultation_id', 'items_enc', (id) => `prescriptions.items:${id}`], ['prescriptions', 'consultation_id', 'advice_enc', (id) => `prescriptions.advice:${id}`],
];
(async () => {
  const check = process.argv.includes('--check'); const db = createDb(); let stale = 0, done = 0;
  for (const [table, pk, col, aad] of TARGETS) {
    const { rows } = await db.query(`SELECT ${pk} AS id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`);
    for (const r of rows.filter((x) => needsRotation(x.v))) {
      stale += 1; if (check) continue;
      await db.query(`UPDATE ${table} SET ${col}=$2 WHERE ${pk}=$1 AND ${col}=$3`, [r.id, encrypt(decrypt(r.v, aad(r.id)), aad(r.id)), r.v]); done += 1; // CAS on old value
    }
  }
  console.log(check ? `stale rows: ${stale}` : `re-encrypted ${done} values`); await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
