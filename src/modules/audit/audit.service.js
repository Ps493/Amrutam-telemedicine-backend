'use strict';
const { sha256 } = require('../../lib/crypto');

const GENESIS = '0'.repeat(64);
const CHAIN_LOCK = 727001;

// Tamper-evident audit trail: each row hashes (prev_hash + content). Any edit/deletion breaks the chain.
// record() must be called as the LAST statement of a business transaction so the chain lock is held only briefly
// while keeping the audit entry atomic with the state change it describes.
function createAuditService(db) {
  async function record(client, { actor, action, entity, entityId, metadata = {}, ctx = {} }) {
    await client.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
    const last = await client.query('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1');
    const prev = last.rows[0]?.hash || GENESIS;
    const createdAt = new Date();
    const body = JSON.stringify([prev, actor?.id || null, action, entity, entityId || null, metadata, createdAt.toISOString()]);
    const hash = sha256(body);
    await client.query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, entity, entity_id, ip, request_id, metadata, prev_hash, hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [actor?.id || null, actor?.role || null, action, entity, entityId || null, ctx.ip || null, ctx.requestId || null, JSON.stringify(metadata), prev, hash, createdAt]);
  }

  // Standalone (own tx) variant for events with no surrounding transaction (e.g. failed logins).
  const recordStandalone = (entry) => db.tx((c) => record(c, entry));

  async function verifyChain(limit = 10000) {
    const { rows } = await db.query('SELECT * FROM audit_logs ORDER BY id ASC LIMIT $1', [limit]);
    let prev = rows.length ? rows[0].prev_hash : GENESIS;
    for (const r of rows) {
      const expect = sha256(JSON.stringify([r.prev_hash, r.actor_id, r.action, r.entity, r.entity_id, r.metadata, r.created_at.toISOString()]));
      if (r.prev_hash !== prev || r.hash !== expect) return { valid: false, brokenAtId: Number(r.id), checked: rows.length };
      prev = r.hash;
    }
    return { valid: true, checked: rows.length };
  }

  async function list({ entity, entityId, actorId, from, to, limit = 50, offset = 0 }) {
    const where = []; const p = [];
    const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (entity) add('entity = ?', entity); if (entityId) add('entity_id = ?', entityId);
    if (actorId) add('actor_id = ?', actorId); if (from) add('created_at >= ?', from); if (to) add('created_at < ?', to);
    p.push(limit, offset);
    const { rows } = await db.readQuery(
      `SELECT id, actor_id, actor_role, action, entity, entity_id, ip, request_id, metadata, created_at
       FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
    return rows;
  }
  return { record, recordStandalone, verifyChain, list };
}
module.exports = { createAuditService };
