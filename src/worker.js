'use strict';
// Background worker: transactional-outbox dispatcher + hold-expiry sweeper + audit partition maintenance.
// Horizontally scalable: FOR UPDATE SKIP LOCKED lets many workers drain the outbox without double processing.
const logger = require('./lib/logger');
const metrics = require('./lib/metrics');
const { backoffDelay } = require('./lib/retry');

const MAX_ATTEMPTS = 8;

function createOutboxProcessor({ db, handlers }) {
  async function runOnce(batch = 50) {
    return db.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM outbox WHERE status='pending' AND next_attempt_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [batch]);
      let ok = 0;
      for (const ev of rows) {
        try {
          const h = handlers[ev.topic];
          if (!h) throw new Error(`no handler for ${ev.topic}`);
          await h(ev.payload);
          await c.query(`UPDATE outbox SET status='done', attempts=attempts+1 WHERE id=$1`, [ev.id]); ok += 1;
        } catch (e) {
          const attempts = ev.attempts + 1;
          const dead = attempts >= MAX_ATTEMPTS;
          // exponential backoff w/ jitter in seconds (base 2s, cap 10min); dead-letter after MAX_ATTEMPTS
          const delaySec = Math.ceil(backoffDelay(attempts, 2000, 600000) / 1000);
          await c.query(`UPDATE outbox SET attempts=$2, last_error=$3, status=$4, next_attempt_at=now() + ($5 || ' seconds')::interval WHERE id=$1`,
            [ev.id, attempts, String(e.message).slice(0, 300), dead ? 'dead' : 'pending', delaySec]);
          logger.warn({ eventId: ev.id, topic: ev.topic, attempts, dead }, 'outbox handler failed');
        }
      }
      const pending = await c.query(`SELECT count(*)::int n FROM outbox WHERE status='pending'`);
      metrics.outboxLag.set(pending.rows[0].n);
      return ok;
    });
  }
  return { runOnce };
}

function startWorker(container) {
  const { db, consultations } = container;
  const handlers = {
    'notification.send': async (p) => { logger.info({ notification: p }, 'notification dispatched (stub: plug SES/FCM/SMS here)'); },
    'payment.refund': async (p) => consultations.processRefund(p.paymentId),
  };
  const outbox = createOutboxProcessor({ db, handlers });
  const timers = [
    setInterval(() => outbox.runOnce().catch((e) => logger.error({ err: e }, 'outbox loop')), 2000),
    setInterval(() => consultations.expireHolds().catch((e) => logger.error({ err: e }, 'expiry loop')), 15000),
    setInterval(() => db.query(`SELECT ensure_audit_partition(date_trunc('month', now() + interval '1 month')::date)`).catch(() => {}), 3600_000),
    setInterval(() => db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '48 hours'`).catch(() => {}), 3600_000),
  ];
  timers.forEach((t) => t.unref && t.unref());
  logger.info('worker started');
  return () => timers.forEach(clearInterval);
}
module.exports = { createOutboxProcessor, startWorker };
if (require.main === module) {
  const { buildContainer } = require('./container');
  const c = buildContainer();
  startWorker(c);
  process.on('SIGTERM', async () => { await c.db.close(); process.exit(0); });
  require('http').createServer((req, res) => { if (req.url === '/metrics') { metrics.registry.metrics().then((m) => { res.setHeader('Content-Type', metrics.registry.contentType); res.end(m); }); } else res.end('ok'); }).listen(process.env.WORKER_PORT || 9100);
}
