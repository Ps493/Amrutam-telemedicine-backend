'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate(connectionString = process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString });
  const dir = path.join(__dirname, '..', 'migrations');
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log(`applied ${f}`);
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
    // keep next 3 months of audit partitions available
    await pool.query(`SELECT ensure_audit_partition(date_trunc('month', now() + (n || ' month')::interval)::date) FROM generate_series(0,3) n`);
  } finally { await pool.end(); }
}
module.exports = { migrate };
if (require.main === module) migrate().catch((e) => { console.error(e); process.exit(1); });
