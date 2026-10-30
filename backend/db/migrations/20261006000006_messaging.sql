-- file: db/migrations/20261006000006_messaging.sql
-- migrate:up
CREATE TYPE channel_kind AS ENUM ('whatsapp', 'web', 'kiosk', 'sms', 'ivr');
CREATE TYPE intake_status AS ENUM ('in_progress', 'completed', 'abandoned', 'escalated_to_staff');
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE message_status AS ENUM ('received', 'queued', 'sent', 'delivered', 'read', 'failed');
CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'delivered', 'failed', 'suppressed');

-- One conversation per channel identity (e.g. per WhatsApp number). Holds the intake state machine position.
CREATE TABLE conversations (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  channel             channel_kind NOT NULL,
  contact_point_id    uuid REFERENCES contact_points(id),   -- NULL for anonymous web / kiosk sessions
  external_ref_hash   bytea,                                 -- HMAC of the WhatsApp wa_id
  facility_id         uuid REFERENCES facilities(id),        -- chosen or derived (QR code, location)
  language            text NOT NULL DEFAULT 'hi',
  state               text NOT NULL DEFAULT 'idle',
  state_data          jsonb NOT NULL DEFAULT '{}',
  active_encounter_id uuid,                                  -- soft reference
  last_inbound_at     timestamptz,                           -- WhatsApp 24-hour customer-service window
  last_outbound_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 0
) WITH (fillfactor = 80);
CREATE UNIQUE INDEX conversations_channel_ref_uq ON conversations (channel, external_ref_hash) WHERE external_ref_hash IS NOT NULL;
CREATE INDEX conversations_contact_idx ON conversations (contact_point_id);

-- HOT table (7 days). The structured result is copied into triage_assessments when intake completes.
CREATE TABLE intake_sessions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  encounter_id    uuid NOT NULL UNIQUE REFERENCES encounters(id),
  conversation_id uuid REFERENCES conversations(id),
  status          intake_status NOT NULL DEFAULT 'in_progress',
  mode            text NOT NULL DEFAULT 'ai_assisted' CHECK (mode IN ('ai_assisted', 'structured_fallback')),
  step            text NOT NULL,
  facts           jsonb NOT NULL DEFAULT '{}',    -- facts collected so far (§9.4)
  questions_asked text[] NOT NULL DEFAULT '{}',
  llm_calls       smallint NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 0
) WITH (fillfactor = 80);
CREATE INDEX intake_sessions_expiry_idx ON intake_sessions (expires_at) WHERE status = 'in_progress';

CREATE TABLE messages (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  conversation_id     uuid NOT NULL REFERENCES conversations(id),
  direction           message_direction NOT NULL,
  channel             channel_kind NOT NULL,
  provider_message_id text,                       -- WhatsApp message id (wamid)
  content_type        text NOT NULL,              -- 'text', 'interactive', 'audio', 'image', 'template', 'location'
  body_enc            bytea,                      -- full payload, encrypted
  body_redacted       text,                       -- identifiers stripped; safe for debugging and analytics
  template_code       text,
  status              message_status NOT NULL,
  error_code          text,
  encounter_id        uuid,                       -- soft reference
  created_at          timestamptz NOT NULL DEFAULT now(),
  status_updated_at   timestamptz,
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, id DESC);
CREATE INDEX messages_provider_idx ON messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- Durable backstop for webhook deduplication (Redis SET NX is the fast path). HOT table (8 days).
CREATE TABLE inbound_dedupe (
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id)
);
CREATE INDEX inbound_dedupe_received_idx ON inbound_dedupe (received_at);

-- Every patient-facing sentence comes from here (clinically reviewed where medical).
CREATE TABLE message_templates (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  code                   text NOT NULL,           -- 'intake.ask_duration', 'queue.your_turn', 'triage.emergency_go_now'
  channel                channel_kind NOT NULL,
  language               text NOT NULL,
  version                int NOT NULL,
  body                   text NOT NULL,           -- with {{named}} placeholders
  variables              text[] NOT NULL DEFAULT '{}',
  provider_template_name text,                    -- approved WhatsApp template name, for messages outside the 24h window
  provider_status        text,
  is_medical             boolean NOT NULL DEFAULT false,
  clinically_reviewed_by uuid REFERENCES users(id),
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, channel, language, version),
  CONSTRAINT medical_templates_reviewed CHECK (NOT is_medical OR status <> 'active' OR clinically_reviewed_by IS NOT NULL)
);
CREATE UNIQUE INDEX message_templates_active_uq ON message_templates (code, channel, language) WHERE status = 'active';

CREATE TABLE notifications (
  id                  uuid NOT NULL DEFAULT uuidv7(),
  contact_point_id    uuid NOT NULL,
  channel             channel_kind NOT NULL,
  template_code       text NOT NULL,
  language            text NOT NULL,
  variables           jsonb NOT NULL DEFAULT '{}',
  dedupe_key          text NOT NULL,              -- e.g. 'eta:<tokenId>:5' — each threshold alert is sent once
  status              notification_status NOT NULL DEFAULT 'pending',
  provider_message_id text,
  attempts            smallint NOT NULL DEFAULT 0,
  last_error          text,
  encounter_id        uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);
CREATE INDEX notifications_dedupe_idx ON notifications (dedupe_key);

INSERT INTO partition_registry (parent_table, retention_months, archive_before_drop, detach_order) VALUES
  ('messages',      12, true,  50),
  ('notifications',  6, false, 50);
SELECT ensure_partitions(1, 3);

-- migrate:down
DELETE FROM partition_registry WHERE parent_table::text IN ('messages', 'notifications');
DROP TABLE IF EXISTS notifications, message_templates, inbound_dedupe, messages, intake_sessions, conversations;
DROP TYPE IF EXISTS notification_status, message_status, message_direction, intake_status, channel_kind;
