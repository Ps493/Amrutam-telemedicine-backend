'use strict';
const { sha256 } = require('../lib/crypto');
const { E, AppError } = require('../lib/errors');
const metrics = require('../lib/metrics');

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;
const STALE_SECONDS = 60;

// Idempotency for unsafe writes (Stripe-style). Same key + same payload => same response, side effects executed once.
// Same key + different payload => 422. Concurrent duplicate => 409 (client retries). 5xx results are not cached.
const idempotent = (db) => async (req, res, next) => {
  try {
    const key = req.get('Idempotency-Key');
    if (!key || !KEY_RE.test(key)) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8-128 chars) is required');
    const userId = req.user.id;
    const hash = sha256(`${req.method}|${req.baseUrl}${req.path}|${JSON.stringify(req.body || {})}`);

    const ins = await db.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, status) VALUES ($1,$2,$3,'IN_PROGRESS')
       ON CONFLICT (user_id, key) DO NOTHING RETURNING key`, [userId, key, hash]);

    if (ins.rowCount === 0) {
      const { rows } = await db.query('SELECT * FROM idempotency_keys WHERE user_id=$1 AND key=$2', [userId, key]);
      const row = rows[0];
      if (row.request_hash !== hash) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
      if (row.status === 'COMPLETED') {
        metrics.idempotentReplays.inc();
        res.set('Idempotent-Replayed', 'true');
        return res.status(row.status_code).json(row.response_body);
      }
      // IN_PROGRESS: take over only if the original worker evidently crashed.
      const take = await db.query(
        `UPDATE idempotency_keys SET created_at = now() WHERE user_id=$1 AND key=$2 AND status='IN_PROGRESS'
         AND created_at < now() - ($3 || ' seconds')::interval RETURNING key`, [userId, key, STALE_SECONDS]);
      if (take.rowCount === 0) { res.set('Retry-After', '1'); throw E.conflict('Request with this Idempotency-Key is still in progress', 'IDEMPOTENCY_IN_PROGRESS'); }
    }

    const origJson = res.json.bind(res);
    res.json = (body) => {
      const persist = res.statusCode >= 500
        ? db.query('DELETE FROM idempotency_keys WHERE user_id=$1 AND key=$2', [userId, key])
        : db.query(`UPDATE idempotency_keys SET status='COMPLETED', status_code=$3, response_body=$4 WHERE user_id=$1 AND key=$2`, [userId, key, res.statusCode, JSON.stringify(body)]);
      persist.catch(() => {}).finally(() => origJson(body));
      return res;
    };
    next();
  } catch (e) { next(e); }
};
module.exports = { idempotent };
