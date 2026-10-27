# Amrutam Telemedicine Backend

Production-grade backend for doctor discovery, slot booking, consultations, prescriptions, compliance audit and admin analytics.
Designed for **100k consultations/day**, **p95 < 200 ms reads / < 500 ms writes**, **99.95 % availability**, with encryption, MFA, RBAC, idempotency, sagas, and full observability.

| Deliverable | Where |
|---|---|
| Code (Node 22 / Express / PostgreSQL, DI composition root) | `src/` |
| API schema (OpenAPI 3) | `openapi.yaml` (live at `/docs`) |
| Architecture, sequence & ER diagrams, retry, partitioning, caching, sagas, DR | `docs/ARCHITECTURE.md` |
| Threat model, OWASP mapping, data classification, key rotation | `docs/THREAT_MODEL.md` |
| Security checklist | `docs/SECURITY_CHECKLIST.md` |
| Infra as code (Docker, Compose, Kubernetes, Terraform/AWS) | `Dockerfile`, `docker-compose.yml`, `infra/` |
| Tests (unit + integration on real Postgres) + CI | `tests/`, `.github/workflows/ci.yml` |
| Observability (metrics, alerts, dashboard, traces, logs) | `observability/`, `src/lib/metrics.js`, `src/tracing.js` |
| Demo video script | `docs/DEMO_SCRIPT.md` |

## Quick start (Docker — one command)
```bash
docker compose up --build          # api :3000, worker, postgres, redis, prometheus :9090, grafana :3001, jaeger :16686
docker compose run --rm api node scripts/seed.js   # optional demo data
open http://localhost:3000/docs     # Swagger UI
```

## Local (no Docker)
```bash
# prerequisites: Node >= 20, PostgreSQL >= 14 (needs pg_trgm + btree_gist contrib extensions)
cp .env.example .env               # fill JWT_SECRET + ENCRYPTION_KEYRING
createdb amrutam && createdb amrutam_test
npm install
npm run migrate                    # applies migrations/*.sql
npm run seed                       # admin@amrutam.test / doctor1..3@amrutam.test / patient@amrutam.test  (pw Str0ngPassw0rd!)
npm run dev                        # API on :3000
npm run worker                     # separate terminal: outbox + hold-expiry sweeper
npm test                           # 34 tests against TEST_DATABASE_URL (default postgres://amrutam:amrutam@localhost:5432/amrutam_test)
```
Generate keys: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` → `ENCRYPTION_KEYRING=v1:<key>`.

## Try the golden path (curl)
```bash
B=http://localhost:3000
# 1. patient registers + logs in
curl -s $B/v1/auth/register -H 'content-type: application/json' -d '{"email":"me@x.com","password":"Str0ngPassw0rd!","fullName":"Me Patient","phone":"9876543210"}'
TOKEN=$(curl -s $B/v1/auth/login -H 'content-type: application/json' -d '{"email":"me@x.com","password":"Str0ngPassw0rd!"}' | jq -r .accessToken)
# 2. search doctors, pick a slot
curl -s "$B/v1/doctors?specialization=Ayurveda" -H "authorization: Bearer $TOKEN"
curl -s "$B/v1/doctors/<doctorId>/slots" -H "authorization: Bearer $TOKEN"
# 3. book (idempotent) then pay
curl -s $B/v1/consultations -H "authorization: Bearer $TOKEN" -H 'Idempotency-Key: book-0001-abcd' -H 'content-type: application/json' -d '{"slotId":"<slotId>","reason":"fever"}'
curl -s $B/v1/consultations/<id>/pay -H "authorization: Bearer $TOKEN" -H 'Idempotency-Key: pay-0001-abcd' -H 'content-type: application/json' -d '{"paymentToken":"tok_ok"}'
```
Mock gateway tokens: `tok_ok` success · `tok_flaky` (2 transient failures → retry succeeds) · `tok_declined` (permanent decline) · `tok_down` (provider outage → circuit breaker).

Doctors/admins must enrol MFA (`POST /v1/auth/mfa/setup` → scan `otpauthUrl` → `POST /v1/auth/mfa/enable`) to use privileged endpoints; admin verifies doctors via `POST /v1/admin/doctors/:id/verify`.

## Project layout
```
src/
  config.js            env-only configuration (fails fast in production)
  container.js         dependency-injection composition root
  app.js / server.js   HTTP wiring, graceful shutdown   |  worker.js  outbox + sweepers
  lib/                 crypto (AES-GCM keyring), db (tx+retry), retry/breaker, cache, metrics, rbac, validate, errors
  middleware/          auth (JWT/RBAC/MFA), idempotency, error mapping
  modules/             auth · doctors · consultations(+prescriptions, state machine) · payments · admin · audit
migrations/            SQL schema (partitioned audit, exclusion + partial unique constraints)
scripts/               migrate · seed · rotate-keys · loadtest (k6)
```

## Key design decisions (details in docs/ARCHITECTURE.md)
* **No double booking**: atomic CAS + DB exclusion/unique constraints; proven by a 12-way concurrency test.
* **Idempotency** on all unsafe writes via `Idempotency-Key` (replay, mismatch → 422, in-flight → 409).
* **Saga + outbox**: reserve → charge → confirm with compensations (hold expiry, failed payment, late success refund).
* **Security**: MFA step-up, RBAC, field-level PHI encryption with key rotation, hash-chained append-only audit log.
* **Resilience**: backoff+jitter retries only for transient errors, circuit breaker, graceful shutdown, Multi-AZ/DR plan.

## Limitations (honest notes)
Payment gateway and notification channels are **ports with mock/stub adapters** (swap in Razorpay/Stripe, SES/FCM). Terraform is a reference skeleton (EKS/ALB/ECR omitted); it has not been applied to a real AWS account. Load figures are design targets with a k6 script provided (`scripts/loadtest.js`) — run it against your environment to validate SLOs.
