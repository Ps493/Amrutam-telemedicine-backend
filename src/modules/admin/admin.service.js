'use strict';
const { cached } = require('../../lib/cache');

function createAdminService({ db, cache }) {
  // Heavy aggregations run on the read replica, cached 60s. Date-range bounded to protect the DB.
  async function overview({ from, to }) {
    return cached(cache, `admin:overview:${from}:${to}`, 60, async () => {
      const [status, daily, revenue, top, users] = await Promise.all([
        db.readQuery(`SELECT status, count(*)::int AS count FROM consultations WHERE created_at >= $1 AND created_at < $2 GROUP BY status ORDER BY status`, [from, to]),
        db.readQuery(`SELECT date_trunc('day', created_at)::date AS day, count(*)::int AS consultations,
                        count(*) FILTER (WHERE status='COMPLETED')::int AS completed, count(*) FILTER (WHERE status IN ('CANCELLED','EXPIRED'))::int AS dropped
                      FROM consultations WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`, [from, to]),
        db.readQuery(`SELECT COALESCE(sum(amount_paise) FILTER (WHERE status='SUCCEEDED'),0)::bigint AS gross, COALESCE(sum(amount_paise) FILTER (WHERE status='REFUNDED'),0)::bigint AS refunded
                      FROM payments WHERE created_at >= $1 AND created_at < $2`, [from, to]),
        db.readQuery(`SELECT c.doctor_id, p.full_name, count(*)::int AS completed FROM consultations c JOIN profiles p ON p.user_id=c.doctor_id
                      WHERE c.status='COMPLETED' AND c.created_at >= $1 AND c.created_at < $2 GROUP BY 1,2 ORDER BY completed DESC LIMIT 10`, [from, to]),
        db.readQuery(`SELECT role, count(*)::int AS count FROM users WHERE created_at >= $1 AND created_at < $2 GROUP BY role`, [from, to]),
      ]);
      return { range: { from, to }, consultationsByStatus: status.rows, daily: daily.rows,
        revenue: { grossPaise: Number(revenue.rows[0].gross), refundedPaise: Number(revenue.rows[0].refunded), netPaise: Number(revenue.rows[0].gross) - Number(revenue.rows[0].refunded) },
        topDoctors: top.rows.map((r) => ({ doctorId: r.doctor_id, fullName: r.full_name, completed: r.completed })), newUsers: users.rows };
    });
  }
  return { overview };
}
module.exports = { createAdminService };
