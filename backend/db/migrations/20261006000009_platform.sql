-- file: db/migrations/20261006000009_platform.sql
-- migrate:up
CREATE TYPE llm_purpose AS ENUM ('intake_extract', 'question_select', 'department_route', 'prebrief', 'kb_answer',
                                 'patient_doc_extract', 'doctor_qa');
CREATE TYPE llm_outcome AS ENUM ('ok', 'invalid_output', 'timeout', 'provider_error', 'blocked_by_guardrail',
                                 'budget_exceeded', 'circuit_open');
CREATE TYPE actor_kind AS ENUM ('staff', 'patient', 'system', 'device');

-- Transactional outbox (D18). Written in the same transaction as the state change it describes.
CREATE TABLE outbox_events (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  aggregate_type text NOT NULL,          -- 'opd_token', 'encounter', 'queue_session', ...
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,          -- 'token.called', 'encounter.completed', ...
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       smallint NOT NULL DEFAULT 0
) WITH (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 1000);
CREATE INDEX outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;

CREATE TABLE llm_calls (
  id                uuid NOT NULL DEFAULT uuidv7(),
  purpose           llm_purpose NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  prompt_version    text NOT NULL,
  facility_id       uuid,
  encounter_id      uuid,
  input_tokens      int,
  output_tokens     int,
  cache_read_tokens int,
  latency_ms        int NOT NULL,
  outcome           llm_outcome NOT NULL,
  error_code        text,
  request_digest    bytea NOT NULL,      -- sha256 of the de-identified request
  response_redacted jsonb,               -- validated structured output, identifiers removed
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);
CREATE INDEX llm_calls_encounter_idx ON llm_calls (encounter_id) WHERE encounter_id IS NOT NULL;

CREATE TABLE audit_events (
  id            uuid NOT NULL DEFAULT uuidv7(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_kind    actor_kind NOT NULL,
  actor_id      uuid,
  facility_id   uuid,
  action        text NOT NULL,           -- 'patient.read', 'patient.search', 'prebrief.view', 'triage.override', 'breakglass.open', ...
  resource_type text NOT NULL,
  resource_id   uuid,
  patient_id    uuid,                    -- whose data was touched: powers "who accessed my record"
  purpose       text,                    -- 'treatment', 'breakglass', 'audit', 'administration'
  request_id    text,
  ip            inet,
  details       jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);
CREATE INDEX audit_events_patient_idx ON audit_events (patient_id, id DESC) WHERE patient_id IS NOT NULL;
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, id DESC);

-- 🔒 Append-only tables: row updates and deletes are rejected even for the table owner.
-- (Retention drops whole partitions, which row triggers do not block.)
CREATE FUNCTION forbid_row_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();
CREATE TRIGGER consents_append_only BEFORE UPDATE OR DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();

-- Hourly tamper-evidence chain over audit_events, also exported to write-once object storage.
CREATE TABLE audit_digests (
  period_start timestamptz PRIMARY KEY,
  period_end   timestamptz NOT NULL,
  row_count    bigint NOT NULL,
  digest       bytea NOT NULL,           -- sha256(prev_digest || sha256 of the period's rows in id order)
  prev_digest  bytea,
  created_at   timestamptz NOT NULL DEFAULT now(),
  exported_to  text
);

INSERT INTO partition_registry (parent_table, retention_months, archive_before_drop, detach_order) VALUES
  ('llm_calls',     6, false, 50),
  ('audit_events', 24, true,  60);
SELECT ensure_partitions(1, 3);

-- migrate:down
DELETE FROM partition_registry WHERE parent_table::text IN ('llm_calls', 'audit_events');
DROP TRIGGER IF EXISTS consents_append_only ON consents;
DROP TABLE IF EXISTS audit_digests, audit_events, llm_calls, outbox_events;
DROP FUNCTION IF EXISTS forbid_row_mutation();
DROP TYPE IF EXISTS actor_kind, llm_outcome, llm_purpose;
