# Threat Model & Security Design

## 1. Assets & data classification
| Class | Data | Controls |
|---|---|---|
| **Restricted (PHI/PII)** | consultation reason/notes, prescriptions, phone, DOB, address, MFA secrets | AES-256-GCM field-level encryption (versioned keys, AAD-bound to row), TLS in transit, disk encryption (KMS), access audited, never logged |
| **Confidential** | email, payment refs, audit logs | RBAC, DB encryption at rest, hash-chained append-only audit |
| **Secrets** | JWT secret, keyring, DB creds | Secrets Manager → env at runtime; never in repo/images; gitleaks in CI |
| **Public** | doctor name/specialisation/fee | cached, rate-limited |

## 2. Attack surface
Public HTTPS API (auth, search, booking, prescriptions) · admin routes · `/metrics` & `/docs` (network-restricted) · Postgres/Redis (private subnets) · payment webhook/gateway egress · CI/CD pipeline & container registry · dependencies (npm) · operators with prod access.

## 3. STRIDE analysis
| Threat | Example | Mitigation (implemented unless marked ▲ infra) |
|---|---|---|
| **S**poofing | credential stuffing, stolen JWT, `alg=none` | bcrypt(12), lockout (5 fails/15 min), auth rate-limit, uniform error + dummy-hash timing equalisation, TOTP MFA (mandatory step-up for doctor/admin), pinned HS256 + iss/aud + 15 min TTL, refresh rotation + **reuse detection** revokes family |
| **T**ampering | edit another user's record, tamper audit rows, swap ciphertexts | zod strict schemas (unknown fields rejected → mass-assignment safe), parameterised SQL, DB constraints, GCM auth tags + AAD, audit trigger blocks UPDATE/DELETE, **hash chain** + `/audit-logs/verify` detects privileged tampering |
| **R**epudiation | "I never booked/prescribed" | audit entry in the *same transaction* as each state change (actor, role, IP, request-id), PHI reads audited, admin PHI access audited |
| **I**nformation disclosure | IDOR, verbose errors, log leakage, DB dump theft | ownership checks return 404 (no existence oracle), generic 500s, pino redaction, field encryption (dump alone is useless), least-privilege roles, helmet/HSTS |
| **D**enial of service | flood, expensive queries, slot-hoarding | global + per-auth rate limits, body limit 100 KB, pagination caps, 5 s statement timeout, pool limits, analytics range ≤ 366 d + cache, 10-min hold expiry, circuit breaker; ▲ WAF + ALB shielding |
| **E**levation of privilege | patient → doctor/admin, vertical via MFA bypass | role immutable at registration (admin cannot self-register), permission-based RBAC (fail closed), `requireMfa` on privileged ops, doctor must be admin-verified before offering slots |

## 4. OWASP Top 10 (2021) mapping
| # | Risk | Mitigation |
|---|---|---|
| A01 Broken Access Control | RBAC matrix, ownership checks everywhere, 404 on foreign objects, MFA step-up; tests for IDOR & role escalation |
| A02 Cryptographic Failures | AES-256-GCM field encryption, key versioning + rotation script, bcrypt, TLS 1.2+/HSTS, KMS-backed storage |
| A03 Injection | 100 % parameterised queries; LIKE wildcards escaped; zod validation; test with SQLi payload |
| A04 Insecure Design | threat model, saga/idempotency by design, DB-level invariants, rate limits, state machine |
| A05 Security Misconfiguration | helmet, no `x-powered-by`, CSP `default-src 'none'`, read-only root FS, non-root container, drop caps, prod fails fast on missing secrets |
| A06 Vulnerable Components | `npm audit` gate, Trivy image scan, Dependabot, lockfile, minimal alpine image |
| A07 Identification & Auth Failures | MFA, lockout, strong password policy, rotation/reuse detection, short-lived access tokens |
| A08 Software & Data Integrity | CI-built immutable images, lockfile (`npm ci`), hash-chained audit, ▲ image signing (cosign) |
| A09 Logging & Monitoring Failures | structured logs with request-id, audit trail, alerts on auth failures/5xx/backlog |
| A10 SSRF | no user-controlled outbound URLs; egress only to the configured payment provider (▲ egress NetworkPolicy) |

## 5. Encryption & key rotation
* **In transit:** TLS 1.2+ at ALB; ▲ mTLS/service mesh optional; DB `sslmode=require`.
* **At rest:** RDS/EBS KMS encryption **plus** application-level AES-256-GCM for PHI/PII (protects against DB-level access, backups leaking, rogue DBAs).
* **Rotation:** keyring `v1:…,v2:…`; deploy with `ACTIVE_KEY_VERSION=v2` (new writes use v2, old reads still work) → `npm run rotate-keys` re-encrypts in resumable batches with compare-and-swap → `-- --check` shows 0 stale → retire v1. JWT secret rotation: ▲ dual-key verify window (planned). KMS CMK auto-rotates yearly.
* **Passwords:** bcrypt cost 12.

## 6. Residual risks / future work
Access tokens are stateless (a suspended user's token lives ≤ 15 min; mitigate with a short deny-list in Redis) · HS256 shared secret → move to RS256/EdDSA with JWKS for multi-service · MFA recovery codes & WebAuthn · per-tenant KEK envelope encryption (DEK per record) · SIEM export for audit logs · real payment-provider webhooks with signature verification · consent management & data-subject deletion workflow (DPDP Act / HIPAA-style).
