-- file: db/migrations/20261006000003_patients.sql
-- migrate:up
CREATE TYPE sex_code AS ENUM ('female', 'male', 'other', 'unknown');
CREATE TYPE identifier_kind AS ENUM ('abha_number', 'abha_address', 'facility_mrn', 'pmjay_id');  -- never Aadhaar
CREATE TYPE contact_relationship AS ENUM ('self', 'parent', 'child', 'spouse', 'sibling', 'other_family', 'caregiver', 'asha_worker');
CREATE TYPE consent_purpose AS ENUM ('care_coordination', 'ai_assisted_intake', 'history_sharing', 'whatsapp_notifications', 'deidentified_analytics');
CREATE TYPE clinical_source AS ENUM ('patient_reported', 'clinician_recorded', 'imported_abdm');

-- A phone number (later: email, ABHA address) that can reach one or more patients.
CREATE TABLE contact_points (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  kind             text NOT NULL CHECK (kind IN ('phone')),
  value_hash       bytea NOT NULL,                 -- HMAC-SHA256(blind-index key, normalised E.164)
  value_enc        bytea NOT NULL,
  key_version      smallint NOT NULL,
  whatsapp_capable boolean,
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value_hash)
);

CREATE TABLE patients (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  display_name            text NOT NULL,           -- as given, any script
  name_search             text NOT NULL,           -- lower-case Latin transliteration, used for fuzzy search
  sex                     sex_code NOT NULL DEFAULT 'unknown',
  birth_date              date,                    -- exact, when known
  birth_year              smallint,                -- otherwise derived from stated age
  birth_date_is_estimated boolean NOT NULL DEFAULT false,
  preferred_language      text NOT NULL DEFAULT 'hi',   -- BCP 47: 'hi', 'gu', 'en', 'mr', ...
  district_code           text,
  pincode                 char(6),
  address_enc             bytea,
  key_version             smallint,
  abha_linked             boolean NOT NULL DEFAULT false,
  merged_into_id          uuid REFERENCES patients(id),   -- duplicate-merge pointer
  status                  record_status NOT NULL DEFAULT 'active',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  version                 int NOT NULL DEFAULT 0,
  CONSTRAINT age_known CHECK (birth_date IS NOT NULL OR birth_year IS NOT NULL)
);
CREATE INDEX patients_name_trgm_idx ON patients USING gin (name_search gin_trgm_ops);
CREATE INDEX patients_district_year_idx ON patients (district_code, birth_year);
CREATE TRIGGER patients_updated_at BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE patient_identifiers (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  patient_id  uuid NOT NULL REFERENCES patients(id),
  kind        identifier_kind NOT NULL,
  facility_id uuid REFERENCES facilities(id),      -- set only for facility_mrn
  value_hash  bytea NOT NULL,
  value_enc   bytea NOT NULL,
  key_version smallint NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mrn_has_facility CHECK ((kind = 'facility_mrn') = (facility_id IS NOT NULL))
);
CREATE UNIQUE INDEX patient_identifiers_uq ON patient_identifiers (kind, facility_id, value_hash) NULLS NOT DISTINCT;
CREATE INDEX patient_identifiers_patient_idx ON patient_identifiers (patient_id);

-- Household model: one phone can reach many patients (family phone, ASHA worker).
CREATE TABLE patient_contacts (
  contact_point_id uuid NOT NULL REFERENCES contact_points(id),
  patient_id       uuid NOT NULL REFERENCES patients(id),
  relationship     contact_relationship NOT NULL,
  is_primary       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_point_id, patient_id)
);
CREATE INDEX patient_contacts_patient_idx ON patient_contacts (patient_id);

-- Append-only: every grant or refusal is a new row; the latest row per (contact, patient, purpose) is current.
CREATE TABLE consents (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  contact_point_id uuid NOT NULL REFERENCES contact_points(id),
  patient_id       uuid REFERENCES patients(id),
  purpose          consent_purpose NOT NULL,
  granted          boolean NOT NULL,
  notice_version   text NOT NULL,                  -- which consent notice text was shown
  language         text NOT NULL,
  channel          text NOT NULL,
  captured_by      uuid REFERENCES users(id),      -- staff member, when captured at a counter
  evidence         jsonb NOT NULL DEFAULT '{}',    -- e.g. {"message_id": "..."} of the patient's YES reply
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_lookup_idx ON consents (contact_point_id, purpose, created_at DESC);

CREATE TABLE allergies (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  patient_id     uuid NOT NULL REFERENCES patients(id),
  substance_code text,                             -- formulary / SNOMED code when known
  substance_text text NOT NULL,
  reaction       text,
  severity       text NOT NULL DEFAULT 'unknown' CHECK (severity IN ('mild', 'moderate', 'severe', 'unknown')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'entered_in_error')),
  source         clinical_source NOT NULL,
  recorded_by    uuid REFERENCES users(id),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  encounter_id   uuid                              -- soft reference (encounters is partitioned)
);
CREATE INDEX allergies_patient_idx ON allergies (patient_id) WHERE status = 'active';

CREATE TABLE conditions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  patient_id      uuid NOT NULL REFERENCES patients(id),
  code_system     text NOT NULL DEFAULT 'local' CHECK (code_system IN ('icd10', 'snomed', 'local')),
  code            text,
  display_text    text NOT NULL,
  clinical_status text NOT NULL DEFAULT 'active' CHECK (clinical_status IN ('active', 'resolved', 'entered_in_error')),
  is_chronic      boolean NOT NULL DEFAULT false,
  onset_date      date,
  expires_at      date,                            -- for time-bound states such as pregnancy
  source          clinical_source NOT NULL,
  recorded_by     uuid REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  encounter_id    uuid                             -- soft reference
);
CREATE INDEX conditions_patient_idx ON conditions (patient_id) WHERE clinical_status = 'active';

-- Denormalised read model for the doctor pre-brief: one row per patient, rebuilt by a worker
-- whenever an encounter closes or allergies / conditions / prescriptions change.
CREATE TABLE patient_clinical_summaries (
  patient_id         uuid PRIMARY KEY REFERENCES patients(id),
  allergies          jsonb NOT NULL DEFAULT '[]',
  active_conditions  jsonb NOT NULL DEFAULT '[]',
  active_medications jsonb NOT NULL DEFAULT '[]',
  recent_encounters  jsonb NOT NULL DEFAULT '[]',  -- last 5, compact
  risk_flags         text[] NOT NULL DEFAULT '{}', -- 'age_60_plus', 'under_5', 'pregnant', 'diabetes', 'hypertension', ...
  last_encounter_at  timestamptz,
  source_version     bigint NOT NULL DEFAULT 0,    -- bumped on every rebuild; part of the cache key
  rebuilt_at         timestamptz NOT NULL DEFAULT now()
);

-- migrate:down
DROP TABLE IF EXISTS patient_clinical_summaries, conditions, allergies, consents, patient_contacts,
  patient_identifiers, patients, contact_points;
DROP TYPE IF EXISTS clinical_source, consent_purpose, contact_relationship, identifier_kind, sex_code;
