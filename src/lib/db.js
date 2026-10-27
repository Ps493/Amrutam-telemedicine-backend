'use strict';
const { Pool } = require('pg');
const config = require('../config');
const metrics = require('./metrics');
const { withRetry } = require('./retry');

function createDb(url = config.databaseUrl, replicaUrl = config.dbReplicaUrl) {
  const pool = new Pool({ connectionString: url, max: config.dbPoolMax, idleTimeoutMillis: 30_000, statement_timeout: 5000, connectionTimeoutMillis: 3000 });
  const replica = replicaUrl ? new Pool({ connectionString: replicaUrl, max: config.dbPoolMax, statement_timeout: 5000 }) : pool;
  pool.on('error', () => {});

  const query = (text, params) => pool.query(text, params);
  const readQuery = (text, params) => replica.query(text, params); // read replica when configured

  // Transaction helper. Retries serialization failures / deadlocks (SQLSTATE 40001 / 40P01) with backoff.
  async function tx(fn, { isolation = 'READ COMMITTED' } = {}) {
    return withRetry(async () => {
      const client = await pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      } finally { client.release(); }
    }, { retries: 3, baseMs: 20, shouldRetry: (e) => e.code === '40001' || e.code === '40P01' });
  }
  const sampler = setInterval(() => metrics.dbPool.set(pool.waitingCount), 5000); sampler.unref();
  const close = async () => { clearInterval(sampler); await pool.end(); if (replica !== pool) await replica.end(); };
  return { pool, query, readQuery, tx, close };
}
module.exports = { createDb };
