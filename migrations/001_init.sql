-- Amrutam telemedicine schema. Idempotent-by-runner (scripts/migrate.js tracks applied files).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  password_hash    text NOT NULL,
  role             text NOT NULL CHECK (role IN ('patient','doctor','admin')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','pending_verification')),
  mfa_enabled      boolean NOT NULL DEFAULT false,
  mfa_secret_enc   text,                       -- AES-256-GCM envelope, never plaintext
  failed_logins    int NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,            -- SHA-256 of opaque token
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);

CREATE TABLE profiles (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name    text NOT NULL,
  phone_enc    text,                           -- PII: encrypted
  dob_enc      text,                           -- PII: encrypted
  gender       text,
  address_enc  text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_name_trgm ON profiles USING gin (full_name gin_trgm_ops);

CREATE TABLE doctors (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialization          text NOT NULL,
  license_no              text NOT NULL UNIQUE,
  years_experience        int NOT NULL DEFAULT 0 CHECK (years_experience >= 0),
  consultation_fee_paise  int NOT NULL CHECK (consultation_fee_paise >= 0),
  languages               text[] NOT NULL DEFAULT '{}',
  bio                     text,
  rating                  numeric(2,1) NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  is_verified             boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctors_spec_idx ON doctors (specialization) WHERE is_verified;
CREATE INDEX doctors_lang_gin ON doctors USING gin (languages);

CREATE TABLE availability_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   uuid NOT NULL REFERENCES doctors(user_id) ON DELETE CASCADE,
  start_time  timestamptz NOT NULL,
  end_time    timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','held','booked','cancelled')),
  version     int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time),
  -- A doctor can never have two live overlapping slots (DB-level guarantee, not app-level)
  CONSTRAINT slots_no_overlap EXCLUDE USING gist (
    doctor_id WITH =, tstzrange(start_time, end_time) WITH &&
  ) WHERE (status <> 'cancelled')
);
CREATE INDEX slots_doctor_time_idx ON availability_slots (doctor_id, start_time) WHERE status = 'open';

CREATE TABLE consultations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id       uuid NOT NULL REFERENCES users(id),
  doctor_id        uuid NOT NULL REFERENCES doctors(user_id),
  slot_id          uuid NOT NULL REFERENCES availability_slots(id),
  status           text NOT NULL CHECK (status IN ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED')),
  scheduled_start  timestamptz NOT NULL,
  scheduled_end    timestamptz NOT NULL,
  reason_enc       text,                       -- PHI: encrypted
  notes_enc        text,                       -- PHI: encrypted
  hold_expires_at  timestamptz,
  cancelled_by     uuid REFERENCES users(id),
  cancel_reason    text,
  version          int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Second line of defence against double booking: one live consultation per slot.
CREATE UNIQUE INDEX consultations_slot_live_uq ON consultations (slot_id)
  WHERE status IN ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS','COMPLETED');
CREATE INDEX consultations_patient_idx ON consultations (patient_id, scheduled_start DESC);
CREATE INDEX consultations_doctor_idx  ON consultations (doctor_id, scheduled_start DESC);
CREATE INDEX consultations_expiry_idx  ON consultations (hold_expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX consultations_created_idx ON consultations (created_at);

CREATE TABLE prescriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  uuid NOT NULL UNIQUE REFERENCES consultations(id),
  doctor_id        uuid NOT NULL REFERENCES doctors(user_id),
  patient_id       uuid NOT NULL REFERENCES users(id),
  items_enc        text NOT NULL,              -- PHI: encrypted JSON (medicines, dosage)
  advice_enc       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC);

CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  uuid NOT NULL REFERENCES consultations(id),
  amount_paise     int NOT NULL CHECK (amount_paise >= 0),
  currency         char(3) NOT NULL DEFAULT 'INR',
  status           text NOT NULL CHECK (status IN ('INITIATED','SUCCEEDED','FAILED','REFUNDED')),
  provider_ref     text,
  failure_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_one_success_uq ON payments (consultation_id) WHERE status = 'SUCCEEDED';
CREATE INDEX payments_consult_idx ON payments (consultation_id);
CREATE INDEX payments_created_idx ON payments (created_at);

-- Idempotency store for all unsafe writes
CREATE TABLE idempotency_keys (
  user_id       uuid NOT NULL,
  key           text NOT NULL,
  request_hash  text NOT NULL,
  status        text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  status_code   int,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

-- Transactional outbox: events written in the same tx as state change, delivered by worker
CREATE TABLE outbox (
  id               bigserial PRIMARY KEY,
  topic            text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','dead')),
  attempts         int NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at) WHERE status = 'pending';

-- Append-only, hash-chained audit log, range-partitioned by month (retention / archival by DROP/DETACH)
CREATE TABLE audit_logs (
  id          bigserial,
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  ip          inet,
  request_id  text,
  metadata    jsonb NOT NULL DEFAULT '{}',
  prev_hash   text NOT NULL,
  hash        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE INDEX audit_entity_idx ON audit_logs (entity, entity_id, created_at DESC);
CREATE INDEX audit_actor_idx  ON audit_logs (actor_id, created_at DESC);

-- Immutability: block UPDATE/DELETE on audit_logs at DB level
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- Helper to pre-create monthly audit partitions (run by cron / worker)
CREATE FUNCTION ensure_audit_partition(month_start date) RETURNS void LANGUAGE plpgsql AS $$
DECLARE part text := 'audit_logs_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
      part, month_start, (month_start + interval '1 month')::date);
  END IF;
END $$;
