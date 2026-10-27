# Security Checklist  (✅ implemented & tested · 🟡 infra/config in IaC · ⬜ roadmap)

## Authentication & session
- ✅ bcrypt cost-12 password hashing; strong password policy (≥10, upper/lower/digit)
- ✅ Account lockout (5 failures → 15 min) · ✅ uniform "Invalid credentials" + timing equalisation
- ✅ TOTP MFA (secret encrypted at rest); ✅ mandatory MFA step-up for doctor/admin operations
- ✅ JWT HS256 pinned, iss/aud checked, 15 min TTL · ✅ refresh rotation + reuse detection (family revoke)
- ✅ Admin role cannot be self-registered · ⬜ WebAuthn, recovery codes

## Authorization
- ✅ Permission-based RBAC, fail-closed · ✅ object-level checks (IDOR → 404) · ✅ doctor verification gate

## Input & API hardening
- ✅ zod strict schemas on every route (unknown keys rejected) · ✅ parameterised SQL only · ✅ LIKE-escape
- ✅ Body size limit · ✅ pagination caps · ✅ rate limiting (global + auth) · ✅ idempotency on writes
- ✅ helmet (CSP, HSTS, nosniff, frameguard) · ✅ CORS allow-list (deny by default) · ✅ no stack traces to clients

## Data protection
- ✅ Field-level AES-256-GCM (PHI/PII), AAD-bound, versioned keys · ✅ rotation script
- ✅ Log redaction · 🟡 KMS/RDS/EBS/S3 encryption · 🟡 TLS only · ⬜ DEK-per-record envelope

## Integrity & audit
- ✅ Append-only audit table (trigger) + SHA-256 hash chain + verify endpoint · ✅ PHI read auditing
- ✅ DB invariants (exclusion, unique partial indexes, checks) · 🟡 WORM archive (S3 Object Lock)

## Supply chain & delivery
- ✅ `npm audit` gate · ✅ Trivy image scan · ✅ gitleaks secret scan · ✅ CodeQL SAST · ✅ lockfile + `npm ci`
- ✅ Non-root, read-only FS, dropped caps, minimal base image, tini · ⬜ cosign signing, SBOM

## Operations
- ✅ Secrets only via env (prod fails fast if missing) · 🟡 Secrets Manager + External Secrets
- ✅ Health/readiness probes, graceful shutdown · ✅ alerts (SLO, burn-rate, backlog) · 🟡 NetworkPolicy, WAF, private subnets
- ⬜ Pen-test before go-live · ⬜ DPDP/HIPAA compliance review & consent/deletion workflows
