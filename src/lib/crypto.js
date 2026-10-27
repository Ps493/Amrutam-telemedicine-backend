'use strict';
const crypto = require('crypto');
const config = require('../config');

// Envelope format: <keyVersion>:<iv b64>:<tag b64>:<ciphertext b64>
// Multiple key versions are kept in the keyring so rotation never breaks reads (see scripts/rotate-keys.js).
function parseKeyring(str) {
  const ring = {};
  for (const part of str.split(',')) {
    const [v, k] = part.split(':');
    const buf = Buffer.from(k, 'base64');
    if (buf.length !== 32) throw new Error(`Key ${v} must be 32 bytes (base64)`);
    ring[v] = buf;
  }
  return ring;
}
const ring = parseKeyring(config.keyring);
if (!ring[config.activeKeyVersion]) throw new Error('ACTIVE_KEY_VERSION not in keyring');

// AAD binds a ciphertext to its row/column so values cannot be swapped between records.
function encrypt(plain, aad = '') {
  if (plain === null || plain === undefined) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ring[config.activeKeyVersion], iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [config.activeKeyVersion, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function decrypt(envelope, aad = '') {
  if (!envelope) return null;
  const [v, iv, tag, ct] = envelope.split(':');
  const key = ring[v];
  if (!key) throw new Error(`Unknown key version ${v}`);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
const needsRotation = (envelope) => !!envelope && envelope.split(':')[0] !== config.activeKeyVersion;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (n = 48) => crypto.randomBytes(n).toString('base64url');

module.exports = { encrypt, decrypt, needsRotation, sha256, randomToken };
