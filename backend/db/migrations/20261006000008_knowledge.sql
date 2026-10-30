-- file: db/migrations/20261006000008_knowledge.sql
-- migrate:up
CREATE TYPE kb_doc_type AS ENUM ('timings', 'department_info', 'scheme', 'wayfinding', 'faq', 'self_care_leaflet', 'sop', 'notice');
CREATE TYPE kb_doc_status AS ENUM ('draft', 'processing', 'active', 'archived', 'failed');
CREATE TYPE patient_doc_kind AS ENUM ('old_prescription', 'lab_report', 'discharge_summary', 'referral_letter', 'imaging_report', 'other');

CREATE TABLE kb_documents (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id            uuid REFERENCES facilities(id),   -- NULL = applies state-wide
  doc_type               kb_doc_type NOT NULL,
  title                  text NOT NULL,
  language               text NOT NULL,
  storage_key            text NOT NULL,                    -- original file in object storage
  checksum               bytea NOT NULL,                   -- sha256 of the original; identical re-uploads are no-ops
  version                int NOT NULL DEFAULT 1,
  status                 kb_doc_status NOT NULL DEFAULT 'draft',
  symptom_codes          text[] NOT NULL DEFAULT '{}',     -- for self_care_leaflet: which symptoms it covers
  effective_from         date,
  effective_to           date,
  clinically_reviewed_by uuid REFERENCES users(id),
  approved_by            uuid REFERENCES users(id),
  error                  text,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- 🔒 self-care content shown to patients must be clinically reviewed before activation
  CONSTRAINT leaflets_reviewed CHECK (doc_type <> 'self_care_leaflet' OR status <> 'active' OR clinically_reviewed_by IS NOT NULL)
);
CREATE UNIQUE INDEX kb_documents_checksum_uq ON kb_documents (facility_id, checksum) NULLS NOT DISTINCT;
CREATE INDEX kb_documents_scope_idx ON kb_documents (facility_id, status);
CREATE INDEX kb_documents_leaflets_idx ON kb_documents USING gin (symptom_codes) WHERE doc_type = 'self_care_leaflet' AND status = 'active';

CREATE TABLE kb_chunks (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  document_id     uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  facility_id     uuid,                                    -- denormalised from the document (NULL = state-wide)
  doc_type        kb_doc_type NOT NULL,                    -- denormalised
  language        text NOT NULL,
  is_active       boolean NOT NULL DEFAULT false,          -- flipped in one transaction when a document version is published
  chunk_index     int NOT NULL,
  heading_path    text NOT NULL DEFAULT '',                -- 'OPD timings > Paediatrics'
  content         text NOT NULL,
  content_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('simple', heading_path || ' ' || content)) STORED,
  token_count     int NOT NULL,
  embedding       halfvec(1024) NOT NULL,
  embedding_model text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 128) WHERE is_active;
CREATE INDEX kb_chunks_tsv_idx ON kb_chunks USING gin (content_tsv) WHERE is_active;
CREATE INDEX kb_chunks_scope_idx ON kb_chunks (facility_id, language) WHERE is_active;

-- Curated question -> vetted answer pairs: the fast path that skips the LLM.
CREATE TABLE faq_entries (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id        uuid REFERENCES facilities(id),
  topic              text NOT NULL,
  answer_i18n        jsonb NOT NULL,                       -- {"en": "...", "hi": "...", "gu": "..."}
  source_document_id uuid REFERENCES kb_documents(id),
  status             record_status NOT NULL DEFAULT 'active',
  approved_by        uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE faq_variants (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  faq_id          uuid NOT NULL REFERENCES faq_entries(id) ON DELETE CASCADE,
  facility_id     uuid,                                    -- denormalised
  language        text NOT NULL,
  question        text NOT NULL,                           -- one phrasing; many per FAQ, in every language
  embedding       halfvec(1024) NOT NULL,
  embedding_model text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX faq_variants_embedding_idx ON faq_variants USING hnsw (embedding halfvec_cosine_ops) WHERE is_active;
CREATE INDEX faq_variants_faq_idx ON faq_variants (faq_id);

-- Phase 2: documents a patient shares (photo of an old prescription, a lab report PDF).
CREATE TABLE patient_documents (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  patient_id           uuid NOT NULL REFERENCES patients(id),
  encounter_id         uuid,                               -- soft reference
  kind                 patient_doc_kind NOT NULL,
  storage_key          text NOT NULL,
  mime_type            text NOT NULL,
  sha256               bytea NOT NULL,
  uploaded_via         channel_kind NOT NULL,
  uploaded_by_user_id  uuid REFERENCES users(id),
  extraction_status    text NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'done', 'failed', 'skipped')),
  document_date        date,
  source_facility_name text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, sha256)
);

CREATE TABLE patient_doc_chunks (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  patient_id      uuid NOT NULL REFERENCES patients(id),
  document_id     uuid NOT NULL REFERENCES patient_documents(id) ON DELETE CASCADE,
  chunk_index     int NOT NULL,
  content         text NOT NULL,
  content_tsv     tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  embedding       halfvec(1024) NOT NULL,
  embedding_model text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);
-- Deliberately NO HNSW index (D9): per-patient search is an exact scan over a few dozen rows — 100% recall.
CREATE INDEX patient_doc_chunks_patient_idx ON patient_doc_chunks (patient_id);

-- Retrieval quality is measured, not assumed.
CREATE TABLE kb_eval_cases (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  facility_id             uuid REFERENCES facilities(id),
  language                text NOT NULL,
  question                text NOT NULL,
  expected_document_id    uuid REFERENCES kb_documents(id),
  expected_answer_contains text[] NOT NULL DEFAULT '{}',
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kb_eval_runs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  run_at          timestamptz NOT NULL DEFAULT now(),
  embedding_model text NOT NULL,
  cases           int NOT NULL,
  recall_at_5     numeric(5,4) NOT NULL,
  mrr             numeric(5,4) NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'
);

-- migrate:down
DROP TABLE IF EXISTS kb_eval_runs, kb_eval_cases, patient_doc_chunks, patient_documents, faq_variants, faq_entries, kb_chunks, kb_documents;
DROP TYPE IF EXISTS patient_doc_kind, kb_doc_status, kb_doc_type;
