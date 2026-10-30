-- file: db/migrations/20261006000004_encounters.sql
-- migrate:up
CREATE TYPE encounter_kind AS ENUM ('opd_new', 'opd_followup', 'emergency', 'info_only');
CREATE TYPE encounter_channel AS ENUM ('whatsapp', 'web', 'kiosk', 'counter', 'ivr', 'offline_sync');
CREATE TYPE encounter_status AS ENUM ('intake', 'triaged', 'booked', 'checked_in', 'in_consult', 'completed', 'referred',
                                      'cancelled', 'no_show', 'left_without_being_seen', 'self_care_advised', 'emergency_redirected');
-- Declared from MOST to LEAST urgent: comparisons rely on this order ('emergency' < 'routine').
CREATE TYPE triage_level AS ENUM ('emergency', 'priority', 'routine', 'self_care');
CREATE TYPE followup_kind AS ENUM ('symptom_checkin', 'report_ready', 'medication_reminder', 'revisit_due');
CREATE TYPE followup_status AS ENUM ('scheduled', 'sent', 'responded', 'escalated', 'cancelled', 'failed');

CREATE TABLE encounters (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  facility_id         uuid NOT NULL REFERENCES facilities(id),
  patient_id          uuid REFERENCES patients(id),       -- NULL until "who is this visit for" is answered
  contact_point_id    uuid REFERENCES contact_points(id),
  kind                encounter_kind NOT NULL DEFAULT 'opd_new',
  channel             encounter_channel NOT NULL,
  status              encounter_status NOT NULL DEFAULT 'intake',
  session_date        date NOT NULL,                      -- IST service date
  department_id       uuid REFERENCES departments(id),
  triage_level        triage_level,
  doctor_user_id      uuid REFERENCES users(id),
  token_display       text,                               -- copied from opd_tokens (tokens roll off after 14 days)
  wait_seconds        int,
  consult_seconds     int,
  checked_in_at       timestamptz,
  consult_started_at  timestamptz,
  consult_ended_at    timestamptz,
  closed_at           timestamptz,
  parent_encounter_id uuid,                               -- soft reference: follow-up chains may cross partitions
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);
CREATE INDEX encounters_patient_idx ON encounters (patient_id, id DESC) WHERE patient_id IS NOT NULL;
CREATE INDEX encounters_facility_day_idx ON encounters (facility_id, session_date, status);
CREATE INDEX encounters_active_idx ON encounters (facility_id, department_id)
  WHERE status IN ('booked', 'checked_in', 'in_consult');
CREATE TRIGGER encounters_updated_at BEFORE UPDATE ON encounters FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 1:1 with the encounter, so the encounter id IS the primary key (same partition, perfect pruning).
CREATE TABLE triage_assessments (
  encounter_id          uuid NOT NULL REFERENCES encounters(id),
  facility_id           uuid NOT NULL,
  rule_set_id           uuid NOT NULL,                    -- FK added in migration 0007
  rule_level            triage_level NOT NULL,
  rules_fired           text[] NOT NULL DEFAULT '{}',
  llm_level             triage_level,
  final_level           triage_level NOT NULL,
  symptoms              jsonb NOT NULL,                   -- [{code, severity, duration_hours, body_site}]
  facts                 jsonb NOT NULL,                   -- the exact fact set the rules engine evaluated
  red_flags             text[] NOT NULL DEFAULT '{}',
  risk_factors          text[] NOT NULL DEFAULT '{}',
  routed_specialty_code text,
  routed_department_id  uuid REFERENCES departments(id),
  routing_confidence    numeric(4,3) CHECK (routing_confidence BETWEEN 0 AND 1),
  routing_method        text NOT NULL CHECK (routing_method IN ('rule', 'llm', 'catalog_default', 'fallback_default', 'staff')),
  mode                  text NOT NULL CHECK (mode IN ('ai_assisted', 'structured_fallback', 'staff_entered')),
  overridden_by         uuid REFERENCES users(id),
  override_reason       text,
  overridden_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (encounter_id),
  -- 🔒 Safety invariant: the final level is never less urgent than the rules' level unless a staff member overrode it with a reason.
  CONSTRAINT final_not_less_urgent_than_rules
    CHECK (final_level <= rule_level OR (overridden_by IS NOT NULL AND override_reason IS NOT NULL))
) PARTITION BY RANGE (encounter_id);
CREATE INDEX triage_assessments_facility_idx ON triage_assessments (facility_id, final_level);

CREATE TABLE prebriefs (
  encounter_id   uuid NOT NULL REFERENCES encounters(id),
  id             uuid NOT NULL DEFAULT uuidv7(),
  facility_id    uuid NOT NULL,
  status         text NOT NULL CHECK (status IN ('ready', 'fallback', 'failed')),
  content        jsonb NOT NULL,                          -- see §9.6 for the shape
  model          text,
  prompt_version text,
  input_digest   bytea,                                   -- sha256 of the assembled context, for reproducibility
  latency_ms     int,
  generated_at   timestamptz NOT NULL DEFAULT now(),
  viewed_at      timestamptz,
  viewed_by      uuid REFERENCES users(id),
  feedback       smallint CHECK (feedback IN (-1, 1)),    -- doctor thumbs down / up
  feedback_note  text,
  PRIMARY KEY (encounter_id, id)
) PARTITION BY RANGE (encounter_id);

CREATE TABLE encounter_diagnoses (
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  id           uuid NOT NULL DEFAULT uuidv7(),
  facility_id  uuid NOT NULL,
  patient_id   uuid NOT NULL,
  code_system  text NOT NULL CHECK (code_system IN ('icd10', 'snomed', 'local')),
  code         text,
  display_text text NOT NULL,
  is_primary   boolean NOT NULL DEFAULT false,
  recorded_by  uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (encounter_id, id)
) PARTITION BY RANGE (encounter_id);

CREATE TABLE prescription_items (
  encounter_id      uuid NOT NULL REFERENCES encounters(id),
  id                uuid NOT NULL DEFAULT uuidv7(),
  facility_id       uuid NOT NULL,
  patient_id        uuid NOT NULL,
  drug_code         text,                                 -- state essential-drug-list / formulary code
  drug_name         text NOT NULL,
  strength          text,
  dosage_form       text,
  dose              text NOT NULL,
  frequency         text NOT NULL,
  duration_days     smallint CHECK (duration_days > 0),
  route             text,
  instructions_i18n jsonb NOT NULL DEFAULT '{}',          -- written or approved by the doctor, never generated
  prescribed_by     uuid NOT NULL REFERENCES users(id),
  dispensed_qty     int,
  dispensed_at      timestamptz,
  dispensed_by      uuid REFERENCES users(id),
  stock_status      text CHECK (stock_status IN ('available', 'partial', 'out_of_stock')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (encounter_id, id)
) PARTITION BY RANGE (encounter_id);
CREATE INDEX prescription_items_patient_idx ON prescription_items (patient_id, encounter_id DESC);

CREATE TABLE observations (
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  id           uuid NOT NULL DEFAULT uuidv7(),
  facility_id  uuid NOT NULL,
  patient_id   uuid NOT NULL,
  code         text NOT NULL,                             -- 'bp_systolic', 'bp_diastolic', 'pulse', 'temp_c', 'spo2', 'weight_kg', 'rbs_mg_dl'
  value_num    numeric,
  value_text   text,
  unit         text,
  source       text NOT NULL CHECK (source IN ('staff', 'device', 'patient_reported')),
  recorded_by  uuid REFERENCES users(id),
  observed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (encounter_id, id),
  CONSTRAINT has_value CHECK (value_num IS NOT NULL OR value_text IS NOT NULL)
) PARTITION BY RANGE (encounter_id);
CREATE INDEX observations_patient_idx ON observations (patient_id, code, observed_at DESC);

CREATE TABLE followups (
  encounter_id            uuid NOT NULL REFERENCES encounters(id),
  id                      uuid NOT NULL DEFAULT uuidv7(),
  facility_id             uuid NOT NULL,
  patient_id              uuid NOT NULL,
  contact_point_id        uuid NOT NULL,
  kind                    followup_kind NOT NULL,
  status                  followup_status NOT NULL DEFAULT 'scheduled',
  due_at                  timestamptz NOT NULL,
  sent_at                 timestamptz,
  responded_at            timestamptz,
  template_code           text NOT NULL,
  payload                 jsonb NOT NULL DEFAULT '{}',
  response                jsonb,
  escalation_encounter_id uuid,                           -- new encounter opened when the patient reports no improvement
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (encounter_id, id)
) PARTITION BY RANGE (encounter_id);
CREATE INDEX followups_due_idx ON followups (due_at) WHERE status = 'scheduled';

INSERT INTO partition_registry (parent_table, retention_months, archive_before_drop, detach_order) VALUES
  ('encounters',          NULL, true, 20),   -- medical records: archived by policy, never auto-dropped
  ('triage_assessments',  NULL, true, 10),
  ('prebriefs',           NULL, true, 10),
  ('encounter_diagnoses', NULL, true, 10),
  ('prescription_items',  NULL, true, 10),
  ('observations',        NULL, true, 10),
  ('followups',           NULL, true, 10);
SELECT ensure_partitions(1, 3);

-- migrate:down
-- Registry rows first: once a table is dropped, its regclass value no longer resolves to a name.
DELETE FROM partition_registry WHERE parent_table::text IN
  ('encounters', 'triage_assessments', 'prebriefs', 'encounter_diagnoses', 'prescription_items', 'observations', 'followups');
DROP TABLE IF EXISTS followups, observations, prescription_items, encounter_diagnoses, prebriefs, triage_assessments, encounters;
DROP TYPE IF EXISTS followup_status, followup_kind, triage_level, encounter_status, encounter_channel, encounter_kind;
