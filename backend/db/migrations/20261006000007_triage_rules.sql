-- file: db/migrations/20261006000007_triage_rules.sql
-- migrate:up
CREATE TYPE rule_set_status AS ENUM ('draft', 'published', 'retired');

CREATE TABLE triage_rule_sets (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  version      int NOT NULL UNIQUE,
  status       rule_set_status NOT NULL DEFAULT 'draft',
  rules        jsonb NOT NULL,                 -- rules DSL (§9.4)
  test_cases   jsonb NOT NULL,                 -- clinician-authored cases; 100% must pass before publishing
  checksum     bytea NOT NULL,                 -- sha256 of the canonical JSON of rules
  authored_by  uuid NOT NULL REFERENCES users(id),
  approved_by  uuid REFERENCES users(id),
  published_at timestamptz,
  retired_at   timestamptz,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT published_needs_approval CHECK (status = 'draft' OR (approved_by IS NOT NULL AND published_at IS NOT NULL)),
  CONSTRAINT four_eyes CHECK (approved_by IS NULL OR approved_by <> authored_by)   -- 🔒 author cannot approve own rules
);
CREATE UNIQUE INDEX triage_rule_sets_single_published ON triage_rule_sets ((true)) WHERE status = 'published';

-- 🔒 Published and retired rule sets are immutable; only the status transition is allowed.
CREATE FUNCTION forbid_rule_set_edits() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.rules IS DISTINCT FROM OLD.rules
                                OR NEW.test_cases IS DISTINCT FROM OLD.test_cases
                                OR NEW.version IS DISTINCT FROM OLD.version
                                OR NEW.checksum IS DISTINCT FROM OLD.checksum) THEN
    RAISE EXCEPTION 'triage rule set v% is % and cannot be edited; create a new version', OLD.version, OLD.status;
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'retired rule set v% cannot be re-published', OLD.version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER triage_rule_sets_immutable BEFORE UPDATE ON triage_rule_sets
  FOR EACH ROW EXECUTE FUNCTION forbid_rule_set_edits();

ALTER TABLE triage_assessments
  ADD CONSTRAINT triage_assessments_rule_set_fk FOREIGN KEY (rule_set_id) REFERENCES triage_rule_sets(id);

CREATE TABLE symptom_catalog (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  code                   text NOT NULL UNIQUE,          -- 'SYM_CHEST_PAIN'
  snomed_code            text,
  body_system            text NOT NULL,
  labels                 jsonb NOT NULL,                -- {"en": "...", "hi": "...", "gu": "..."}
  synonyms               text[] NOT NULL DEFAULT '{}',  -- lower-case colloquial phrases, incl. Hinglish: 'pet mein jalan'
  default_specialty_code text NOT NULL,
  is_red_flag            boolean NOT NULL DEFAULT false,
  embedding              halfvec(1024),                 -- of labels + synonyms; NULL until embedded
  embedding_model        text,
  status                 record_status NOT NULL DEFAULT 'active',
  clinically_reviewed_by uuid REFERENCES users(id),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX symptom_catalog_embedding_idx ON symptom_catalog USING hnsw (embedding halfvec_cosine_ops) WHERE status = 'active';
CREATE INDEX symptom_catalog_synonyms_idx ON symptom_catalog USING gin (synonyms);

-- Vetted, translated questions. The LLM may only choose among these codes (D8).
CREATE TABLE intake_questions (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  code                   text NOT NULL UNIQUE,          -- 'Q_FEVER_DAYS'
  answer_type            text NOT NULL CHECK (answer_type IN ('yes_no', 'single_choice', 'multi_choice', 'number', 'duration', 'free_text')),
  prompts                jsonb NOT NULL,                -- per language
  options                jsonb NOT NULL DEFAULT '[]',   -- [{"code": "...", "labels": {...}}]; <= 3 fit WhatsApp buttons, <= 10 a list
  sets_fact              text NOT NULL,                 -- fact populated by the answer, e.g. 'fever_days'
  applies_to_symptoms    text[] NOT NULL DEFAULT '{}',  -- empty = general question
  priority               smallint NOT NULL DEFAULT 100, -- lower is asked first in deterministic mode
  status                 record_status NOT NULL DEFAULT 'active',
  clinically_reviewed_by uuid REFERENCES users(id),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intake_questions_symptoms_idx ON intake_questions USING gin (applies_to_symptoms) WHERE status = 'active';

-- migrate:down
DROP TABLE IF EXISTS intake_questions, symptom_catalog;
ALTER TABLE triage_assessments DROP CONSTRAINT IF EXISTS triage_assessments_rule_set_fk;
DROP TABLE IF EXISTS triage_rule_sets;
DROP FUNCTION IF EXISTS forbid_rule_set_edits();
DROP TYPE IF EXISTS rule_set_status;
