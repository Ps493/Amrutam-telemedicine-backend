'use strict';
const request = require('supertest');
const http = require('http');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { migrate } = require('../scripts/migrate');
const { buildContainer } = require('../src/container');
const { createApp } = require('../src/app');

let n = 0;
const PASSWORD = 'Str0ngPassw0rd!';

async function setup(overrides = {}) {
  await migrate(process.env.DATABASE_URL);
  const container = buildContainer({ gatewayOpts: { baseMs: 1, retries: 3 }, ...overrides });
  await container.db.query('TRUNCATE users, profiles, doctors, availability_slots, consultations, prescriptions, payments, idempotency_keys, outbox, audit_logs, refresh_tokens CASCADE');
  const app = createApp(container);
  const server = http.createServer(app).listen(0); // one server per suite (avoids listener leaks)
  container.close = async () => { server.close(); await container.db.close(); };
  return { app, container, api: request(server) };
}

const uniq = (p) => `${p}${Date.now()}${++n}@example.com`;

async function registerPatient(api, extra = {}) {
  const email = uniq('pat');
  const r = await api.post('/v1/auth/register').send({ email, password: PASSWORD, fullName: 'Test Patient', phone: '9876543210', dob: '1990-05-01', ...extra });
  const l = await api.post('/v1/auth/login').send({ email, password: PASSWORD });
  return { id: r.body.id, email, token: l.body.accessToken, refreshToken: l.body.refreshToken };
}

async function enableMfa(api, token) {
  const s = await api.post('/v1/auth/mfa/setup').set('Authorization', `Bearer ${token}`);
  const r = await api.post('/v1/auth/mfa/enable').set('Authorization', `Bearer ${token}`).send({ code: authenticator.generate(s.body.secret) });
  return { secret: s.body.secret, token: r.body.accessToken };
}

async function createAdmin(container, api) {
  const email = uniq('adm');
  const { rows } = await container.db.query(`INSERT INTO users (email,password_hash,role) VALUES ($1,$2,'admin') RETURNING id`, [email, bcrypt.hashSync(PASSWORD, 4)]);
  await container.db.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1,'Admin')`, [rows[0].id]);
  const l = await api.post('/v1/auth/login').send({ email, password: PASSWORD });
  const mfa = await enableMfa(api, l.body.accessToken);
  return { id: rows[0].id, email, token: mfa.token };
}

async function registerDoctor(api, container, admin, extra = {}) {
  const email = uniq('doc');
  const r = await api.post('/v1/auth/register').send({ email, password: PASSWORD, fullName: 'Dr Test', role: 'doctor',
    doctor: { specialization: 'Ayurveda', licenseNo: `LIC${Date.now()}${++n}`, yearsExperience: 8, consultationFeePaise: 50000, languages: ['en', 'hi'], ...extra } });
  const l = await api.post('/v1/auth/login').send({ email, password: PASSWORD });
  const mfa = await enableMfa(api, l.body.accessToken);
  await api.post(`/v1/admin/doctors/${r.body.id}/verify`).set('Authorization', `Bearer ${admin.token}`);
  return { id: r.body.id, email, token: mfa.token, secret: mfa.secret };
}

const slotIn = (minutes, len = 30) => ({ startTime: new Date(Date.now() + minutes * 60000).toISOString(), endTime: new Date(Date.now() + (minutes + len) * 60000).toISOString() });
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let k = 0;
const idemKey = () => `idem-key-${Date.now()}-${++k}`;

async function createSlot(api, doctor, minutes = 120) {
  const r = await api.post('/v1/doctors/me/slots').set(auth(doctor.token)).send({ slots: [slotIn(minutes)] });
  return r.body.slots[0];
}
async function book(api, patient, slotId, key = idemKey()) {
  return api.post('/v1/consultations').set(auth(patient.token)).set('Idempotency-Key', key).send({ slotId, reason: 'fever and cough' });
}
module.exports = { setup, registerPatient, registerDoctor, createAdmin, enableMfa, createSlot, book, slotIn, auth, idemKey, PASSWORD, authenticator };
