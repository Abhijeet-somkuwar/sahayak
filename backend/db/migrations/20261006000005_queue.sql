-- file: db/migrations/20261006000005_queue.sql
-- migrate:up
CREATE TYPE queue_session_status AS ENUM ('scheduled', 'open', 'paused', 'closed');
CREATE TYPE token_status AS ENUM ('waiting', 'called', 'in_consult', 'completed', 'skipped', 'cancelled', 'no_show', 'transferred');
CREATE TYPE token_source AS ENUM ('remote_booking', 'counter', 'kiosk', 'offline_block', 'staff_transfer');
CREATE TYPE queue_event_kind AS ENUM ('token_issued', 'checked_in', 'called', 'recalled', 'skipped', 'consult_started', 'consult_ended',
                                      'transferred', 'cancelled', 'no_show', 'lane_changed', 'session_opened', 'session_paused',
                                      'session_closed', 'doctor_status_changed', 'offline_tokens_synced');

-- One row per department per day per shift. last_token_no is the authoritative token counter (D6).
CREATE TABLE queue_sessions (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  department_id uuid NOT NULL REFERENCES departments(id),
  session_date  date NOT NULL,
  shift         text NOT NULL CHECK (shift IN ('morning', 'evening')),
  status        queue_session_status NOT NULL DEFAULT 'scheduled',
  token_prefix  text NOT NULL,
  last_token_no int NOT NULL DEFAULT 0 CHECK (last_token_no >= 0),
  capacity      int CHECK (capacity > 0),
  lane_ratio    smallint[] NOT NULL DEFAULT '{1,2}',  -- protected : general calls (urgent lane always first)
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL CHECK (ends_at > starts_at),
  opened_at     timestamptz,
  closed_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, session_date, shift)
) WITH (fillfactor = 70);   -- last_token_no is updated on every check-in; leave room for HOT updates
CREATE INDEX queue_sessions_facility_day_idx ON queue_sessions (facility_id, session_date);

-- Number ranges pre-allocated to kiosks / counters so they can keep issuing tokens offline (D17).
CREATE TABLE token_blocks (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  queue_session_id uuid NOT NULL REFERENCES queue_sessions(id),
  device_id        uuid NOT NULL REFERENCES devices(id),
  first_no         int NOT NULL,
  last_no          int NOT NULL,
  allocated_at     timestamptz NOT NULL DEFAULT now(),
  released_at      timestamptz,
  CHECK (last_no >= first_no)
);
CREATE INDEX token_blocks_session_idx ON token_blocks (queue_session_id);

-- HOT table: rows older than 14 days are deleted by the retention job after their facts are copied to encounters.
CREATE TABLE opd_tokens (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  queue_session_id    uuid NOT NULL REFERENCES queue_sessions(id),
  encounter_id        uuid NOT NULL REFERENCES encounters(id),
  facility_id         uuid NOT NULL,
  session_date        date NOT NULL,
  token_no            int NOT NULL CHECK (token_no > 0),
  display_code        text NOT NULL,                  -- 'MED-047'
  lane                smallint NOT NULL CHECK (lane BETWEEN 0 AND 2),  -- 0 urgent (triage 'priority'), 1 protected (60+, pregnant, disability), 2 general
  queue_entry_at      timestamptz NOT NULL,           -- ordering time within a lane (§9.5)
  status              token_status NOT NULL DEFAULT 'waiting',
  source              token_source NOT NULL,
  preferred_doctor_id uuid REFERENCES users(id),
  call_count          smallint NOT NULL DEFAULT 0,
  called_at           timestamptz,
  consult_started_at  timestamptz,
  consult_ended_at    timestamptz,
  served_by           uuid REFERENCES users(id),
  service_point_id    uuid REFERENCES service_points(id),
  eta_seconds_at_entry int,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 0,
  UNIQUE (queue_session_id, token_no)
) WITH (fillfactor = 85);
CREATE UNIQUE INDEX opd_tokens_one_live_per_encounter ON opd_tokens (encounter_id)
  WHERE status NOT IN ('transferred', 'cancelled');
CREATE INDEX opd_tokens_waiting_idx ON opd_tokens (queue_session_id, lane, queue_entry_at, token_no)
  WHERE status = 'waiting';
CREATE INDEX opd_tokens_active_idx ON opd_tokens (queue_session_id, served_by)
  WHERE status IN ('called', 'in_consult');
CREATE INDEX opd_tokens_session_date_idx ON opd_tokens (session_date);
CREATE TRIGGER opd_tokens_updated_at BEFORE UPDATE ON opd_tokens FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only event log of everything that happened in a queue. Rebuild source for the Redis read model.
CREATE TABLE queue_events (
  id               uuid NOT NULL DEFAULT uuidv7(),
  queue_session_id uuid NOT NULL,       -- soft references: the log outlives the hot tables
  token_id         uuid,
  encounter_id     uuid,
  facility_id      uuid NOT NULL,
  kind             queue_event_kind NOT NULL,
  actor_user_id    uuid,
  device_id        uuid,
  token_version    int,                 -- opd_tokens.version after the change (projection idempotency)
  payload          jsonb NOT NULL DEFAULT '{}',
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);
CREATE INDEX queue_events_session_idx ON queue_events (queue_session_id, id);

-- Emergency pre-arrival alerts shown on the casualty dashboard. HOT table (30 days).
CREATE TABLE emergency_prealerts (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id     uuid NOT NULL REFERENCES facilities(id),
  encounter_id    uuid NOT NULL REFERENCES encounters(id),
  summary         jsonb NOT NULL,       -- age band, sex, complaint, red flags fired; no direct identifiers
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'arrived', 'closed')),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emergency_prealerts_open_idx ON emergency_prealerts (facility_id, created_at)
  WHERE status IN ('open', 'acknowledged');

INSERT INTO partition_registry (parent_table, retention_months, archive_before_drop, detach_order)
VALUES ('queue_events', 24, true, 50);
SELECT ensure_partitions(1, 3);

-- migrate:down
DELETE FROM partition_registry WHERE parent_table::text = 'queue_events';
DROP TABLE IF EXISTS emergency_prealerts, queue_events, opd_tokens, token_blocks, queue_sessions;
DROP TYPE IF EXISTS queue_event_kind, token_source, token_status, queue_session_status;
