-- file: db/migrations/20261006000002_organisation.sql
-- migrate:up
CREATE TYPE record_status AS ENUM ('active', 'inactive');
CREATE TYPE facility_kind AS ENUM ('medical_college', 'district_hospital', 'sub_district_hospital', 'chc', 'phc', 'uphc', 'other');
CREATE TYPE service_point_kind AS ENUM ('consult_room', 'registration_counter', 'triage_desk', 'lab', 'radiology', 'pharmacy', 'help_desk', 'emergency_bay');
CREATE TYPE staff_role AS ENUM ('state_admin', 'facility_admin', 'doctor', 'nurse', 'registration_clerk', 'help_desk',
                                'pharmacist', 'lab_technician', 'clinical_reviewer', 'dpo', 'auditor');
CREATE TYPE device_kind AS ENUM ('queue_display', 'kiosk', 'counter_terminal');

CREATE TABLE facilities (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  code          text NOT NULL UNIQUE,              -- short code used in QR deep links, e.g. 'GJ-AMD-CIVIL'
  name          text NOT NULL,
  name_i18n     jsonb NOT NULL DEFAULT '{}',       -- {"hi": "...", "gu": "..."}
  kind          facility_kind NOT NULL,
  state_code    char(2) NOT NULL,                  -- e.g. 'GJ'
  district_code text NOT NULL,                     -- LGD district code
  hfr_id        text UNIQUE,                       -- ABDM Health Facility Registry id
  address       text,
  pincode       char(6),
  latitude      numeric(9,6),
  longitude     numeric(9,6),
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  opd_config    jsonb NOT NULL DEFAULT '{}',       -- registration hours, lane ratio, reporting-window size, ETA defaults
  status        record_status NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facilities_district_idx ON facilities (state_code, district_code) WHERE status = 'active';
CREATE TRIGGER facilities_updated_at BEFORE UPDATE ON facilities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE departments (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id             uuid NOT NULL REFERENCES facilities(id),
  code                    text NOT NULL,           -- 'GEN_MED'
  specialty_code          text NOT NULL,           -- canonical specialty used by routing: 'general_medicine', 'paediatrics', 'obgyn', ...
  name                    text NOT NULL,
  name_i18n               jsonb NOT NULL DEFAULT '{}',
  token_prefix            text NOT NULL,           -- 'MED' -> tokens 'MED-047'
  is_emergency            boolean NOT NULL DEFAULT false,
  accepts_routing         boolean NOT NULL DEFAULT true,
  default_consult_seconds int NOT NULL DEFAULT 300 CHECK (default_consult_seconds BETWEEN 30 AND 3600),
  display_order           smallint NOT NULL DEFAULT 0,
  status                  record_status NOT NULL DEFAULT 'active',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, code)
);
CREATE INDEX departments_routing_idx ON departments (facility_id, specialty_code) WHERE status = 'active' AND accepts_routing;
CREATE TRIGGER departments_updated_at BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE service_points (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  department_id   uuid REFERENCES departments(id),
  kind            service_point_kind NOT NULL,
  label           text NOT NULL,                   -- 'Room 7'
  label_i18n      jsonb NOT NULL DEFAULT '{}',
  floor           text,
  wayfinding_i18n jsonb NOT NULL DEFAULT '{}',     -- "Ground floor, left of the main gate"
  status          record_status NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (facility_id, label)
);
CREATE INDEX service_points_department_idx ON service_points (department_id) WHERE status = 'active';

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  display_name       text NOT NULL,
  email              text,
  phone_hash         bytea UNIQUE,                 -- HMAC blind index of the normalised E.164 number
  phone_enc          bytea,
  key_version        smallint,
  password_hash      text,                         -- argon2id
  mfa_secret_enc     bytea,                        -- TOTP secret, encrypted
  hpr_id             text UNIQUE,                  -- ABDM Healthcare Professional Registry id (doctors, nurses)
  status             record_status NOT NULL DEFAULT 'active',
  failed_login_count smallint NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE staff_memberships (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid NOT NULL REFERENCES users(id),
  facility_id   uuid REFERENCES facilities(id),    -- NULL only for state-level roles
  role          staff_role NOT NULL,
  department_id uuid REFERENCES departments(id),
  status        record_status NOT NULL DEFAULT 'active',
  valid_from    date NOT NULL DEFAULT current_date,
  valid_to      date,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facility_required_for_facility_roles
    CHECK (role IN ('state_admin', 'auditor', 'dpo') OR facility_id IS NOT NULL)
);
CREATE UNIQUE INDEX staff_memberships_uq ON staff_memberships (user_id, facility_id, role) NULLS NOT DISTINCT WHERE status = 'active';
CREATE INDEX staff_memberships_facility_idx ON staff_memberships (facility_id, role) WHERE status = 'active';

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES users(id),
  family_id    uuid NOT NULL,                      -- all rotations of one login share a family; reuse of an old token revokes the family
  token_hash   bytea NOT NULL UNIQUE,              -- sha256 of the opaque token
  device_label text,
  ip           inet,
  expires_at   timestamptz NOT NULL,
  rotated_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE devices (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id       uuid NOT NULL REFERENCES facilities(id),
  kind              device_kind NOT NULL,
  label             text NOT NULL,
  department_ids    uuid[] NOT NULL DEFAULT '{}',  -- which queues a display shows
  service_point_ids uuid[] NOT NULL DEFAULT '{}',
  api_key_hash      bytea NOT NULL UNIQUE,
  last_seen_at      timestamptz,
  status            record_status NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_facility_idx ON devices (facility_id) WHERE status = 'active';

CREATE TABLE doctor_schedules (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id      uuid NOT NULL REFERENCES facilities(id),
  department_id    uuid NOT NULL REFERENCES departments(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  service_point_id uuid REFERENCES service_points(id),
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO 8601: 1 = Monday
  shift            text NOT NULL CHECK (shift IN ('morning', 'evening')),
  starts_at        time NOT NULL,
  ends_at          time NOT NULL CHECK (ends_at > starts_at),
  effective_from   date NOT NULL,
  effective_to     date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctor_schedules_lookup_idx ON doctor_schedules (department_id, weekday, shift);
CREATE INDEX doctor_schedules_user_idx ON doctor_schedules (user_id);

CREATE TABLE doctor_schedule_overrides (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id uuid NOT NULL REFERENCES facilities(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  on_date     date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('leave', 'extra_duty', 'emergency_duty', 'rounds_extended')),
  starts_at   time,
  ends_at     time,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctor_schedule_overrides_day_idx ON doctor_schedule_overrides (facility_id, on_date);

-- migrate:down
DROP TABLE IF EXISTS doctor_schedule_overrides, doctor_schedules, devices, refresh_tokens,
  staff_memberships, users, service_points, departments, facilities;
DROP TYPE IF EXISTS device_kind, staff_role, service_point_kind, facility_kind, record_status;
