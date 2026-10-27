# 5-minute demo video script

| Time | Show | Say |
|---|---|---|
| 0:00 | README + architecture diagram | Problem, stack, goals (100k/day, p95, 99.95 %) |
| 0:30 | `docker compose up`, Swagger `/docs` | One-command stack, OpenAPI-first |
| 1:00 | Register patient/doctor → doctor MFA enrol → admin verifies doctor | Roles, MFA step-up, doctor verification gate |
| 1:45 | Doctor creates slots; overlapping slot → 409 | DB exclusion constraint |
| 2:15 | Patient searches (filters) → books with Idempotency-Key; replay same key → `Idempotent-Replayed: true` | Idempotency design |
| 3:00 | Pay with `tok_flaky` (retry/backoff), `tok_declined` ×3 (compensation: slot released) | Saga, retries, circuit breaker |
| 3:40 | `npm test` → 12-way race test: 1 winner | Concurrency safety, 34 tests, CI pipeline |
| 4:10 | Grafana dashboard + Prometheus alerts, Jaeger trace, JSON logs with requestId | Observability |
| 4:40 | `/v1/admin/audit-logs/verify` valid → show tamper → invalid; threat model & key rotation | Compliance & security |
| 5:00 | Wrap: trade-offs & roadmap | Honest limits (mock gateway, audit-lock trade-off) |
