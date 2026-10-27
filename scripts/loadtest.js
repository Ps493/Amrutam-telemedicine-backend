// k6 load test:  k6 run -e BASE=http://localhost:3000 -e TOKEN=<patient jwt> scripts/loadtest.js
// Targets SLOs: reads p95 < 200ms, writes p95 < 500ms. Sizing: 100k consultations/day ≈ 1.2 avg rps, ~15 rps peak (10x burst) for bookings, ~10x that for reads.
import http from 'k6/http'; import { check } from 'k6';
export const options = {
  scenarios: { reads: { executor: 'constant-arrival-rate', rate: 150, timeUnit: '1s', duration: '2m', preAllocatedVUs: 100, exec: 'reads' } },
  thresholds: { 'http_req_duration{kind:read}': ['p(95)<200'], http_req_failed: ['rate<0.001'] },
};
const H = { headers: { Authorization: `Bearer ${__ENV.TOKEN}` }, tags: { kind: 'read' } };
export function reads() { const r = http.get(`${__ENV.BASE}/v1/doctors?specialization=Ayurveda&limit=20`, H); check(r, { ok: (x) => x.status === 200 }); }
