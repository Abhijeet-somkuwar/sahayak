# Sahayak — Backend Design Specification

> **Sahayak** (working name, Hindi for "helper"): an AI-assisted OPD intake, triage, queue and doctor pre-brief platform for Indian government hospitals.
> Version 1.0 · Target stack: Node.js (JavaScript) · PostgreSQL 18 + pgvector · Redis · React (frontend spec is a separate document).

---

## 0. How to use this document (instructions for Claude Code)

This file is the single source of truth for the backend. Build exactly what is described here.

1. **Read sections 1–5 fully before writing code.** They contain the non-negotiable principles and the decisions (with reasons) that every module depends on.
2. **The SQL in section 6 is the schema.** Copy each migration block into `db/migrations/` with the file name given in its first comment line. The SQL has been executed end-to-end on PostgreSQL 18.3 + pgvector 0.8.1; do not "simplify" it (e.g. by removing partitioning, constraints or partial indexes) without a written reason.
3. **Build in the milestone order of section 18.** Each milestone has acceptance criteria. Do not start a milestone until the previous one passes its criteria.
4. **When something is ambiguous**, check section 20 (Open decisions). If it is not answered there, stop and ask the user rather than inventing a new pattern.
5. **Never trade away a safety rule for convenience.** The rules marked 🔒 are safety or compliance requirements. They are enforced in code *and*, where possible, in the database.

Conventions used in this document: `MUST` / `MUST NOT` are hard requirements. `SHOULD` means do it unless there is a documented reason not to. IST = Asia/Kolkata (UTC+05:30).

---

## 1. Product scope

### 1.1 What the backend does

| Capability | Summary |
|---|---|
| Multichannel intake | Patients start on WhatsApp (primary), web, or a hospital kiosk. One intake engine, many channel adapters. |
| Triage | Deterministic red-flag rules decide urgency; an LLM helps extract symptoms and pick the department, but can only escalate urgency, never lower it. |
| Routing | Symptoms → specialty → the facility's department that is open today. |
| Smart OPD queue | Tokens, lanes (urgent / protected / general), call-next, live position and ETA, WhatsApp alerts, hospital TV displays, offline counters. |
| Doctor pre-brief | Before the doctor calls the token, a 5-line summary: today's complaint, red flags, allergies, medicines, chronic conditions, recent visits. |
| Hospital knowledge bot | Answers "what are OPD timings", "which documents for Ayushman card", "where is the X-ray room" from hospital documents (RAG), in Hindi/Gujarati/English. |
| Follow-ups | Day-3 symptom check-in, report-ready alerts, medicine reminders, revisit reminders. |
| Patient records | Household-aware patient identity (shared family phones), ABHA linking, allergies, conditions, visit history, uploaded old prescriptions (phase 2). |
| Analytics | Per-department daily wait times, no-shows, triage mix, AI fallback rate, hourly arrival curves. |
| Audit & compliance | Every read of patient data is logged; consent is recorded; data stays in India. |

### 1.2 What the backend does NOT do

- 🔒 It does **not** diagnose, prescribe, or give medicine names or doses to patients. India's Telemedicine Practice Guidelines (2020) do not permit AI/ML platforms to counsel patients or prescribe medicines; AI may only assist a registered medical practitioner.
- It does **not** replace the hospital's HMIS (e.g. NIC e-Hospital) or the national appointment portal (ORS). It integrates with them (phase 3) and adds the intake/queue/AI layer they lack.
- It does **not** store Aadhaar numbers. ABHA (Ayushman Bharat Health Account) is the health identifier.

---

## 2. Design principles (non-negotiable)

1. **AI is an accelerator, never a dependency.** Every flow has a deterministic path that works when the LLM, the embedding provider, or the ASR service is down. A token can always be issued.
2. 🔒 **Rules decide urgency; the LLM can only escalate.** `final_level` is never less urgent than `rule_level` unless a named staff member overrides it with a reason. This is enforced by a CHECK constraint (§6, migration 0004).
3. 🔒 **The LLM never writes patient-facing medical advice.** It extracts structure, ranks pre-approved questions, and selects pre-approved (clinically reviewed) content. Every sentence a patient reads comes from a reviewed template or a reviewed document.
4. **PostgreSQL is the system of record; Redis is for speed.** Every state change is committed to Postgres first. Redis holds read models, locks, rate limits and job queues, and can be rebuilt from Postgres at any time.
5. **Hot data small, history partitioned.** Operational tables that change constantly stay tiny (rolling windows). High-volume history is append-only and partitioned by month.
6. **Exact where it matters, approximate where it scales.** Allergies and medicines come from SQL, never from similarity search. Approximate vector search is only used for large shared corpora (hospital documents).
7. **Fail closed on access.** Facility isolation is enforced by row-level security; a missing session setting returns zero rows, not all rows.
8. **Everything is auditable.** Who saw which patient's data, which rule set and prompt version produced a triage decision, and who overrode it.
9. **Built for India's reality.** Shared family phones, low digital literacy, regional languages, voice notes, ASHA workers registering villagers, flaky hospital internet, 24-hour WhatsApp windows, morning registration surges.

---

## 3. Scale targets and capacity model

The architecture is designed for a **state-level deployment** ("cell") and scales nationally by adding cells. The numbers below are planning assumptions to size the first deployment; they MUST be re-validated with load tests (§16) and real footfall data.

### 3.1 Assumptions per cell (one state)

| Parameter | Assignment demo | State cell (design target) |
|---|---|---|
| Facilities | 1–3 | 500 (medical colleges, district & sub-district hospitals, CHCs) |
| OPD encounters / day | ~500 | 300,000 (largest single hospitals: 10–15k/day) |
| Morning surge | — | 60% of the day's check-ins between 08:00 and 11:00 IST |
| Peak check-ins | — | average ~17/s in the surge; design for 5× bursts → **~85/s** |
| WhatsApp messages | — | ~15 per encounter (intake + alerts) → ~4.5M/day; design for **~1,000 msg/s** bursts |
| Patients waiting at the same time | — | ~120,000 at 10:30 IST |
| Queue position reads | — | design for **5,000 req/s** (status pages + displays) served from Redis |
| Concurrent staff/device sockets | — | ~20,000 (doctors, counters, TV displays) |
| LLM calls | — | ~1M/day, peak ~60/s (provider rate limits are the real constraint → priorities, caching, fallback) |

### 3.2 Storage growth per cell (approximate, before indexes)

| Data | Rows / month | Size / month |
|---|---|---|
| Encounters + clinical children | ~9M encounters, ~40M child rows | ~6 GB |
| Messages | ~135M | ~40 GB |
| Audit events | ~300M | ~60 GB |
| LLM call logs | ~30M | ~10 GB |
| **Total** | | **~120 GB/month (~180 GB with indexes) → ~2 TB/year** |

This is why high-volume tables are partitioned monthly and have explicit retention/archival rules (§14.6).

### 3.3 Latency budgets (SLOs, measured at the API, p99 unless stated)

| Operation | Budget |
|---|---|
| Queue position / ETA read | 50 ms |
| Token check-in (issue token) | 300 ms |
| Call next patient (doctor) | 300 ms (pre-brief already cached) |
| Patient lookup by phone / ABHA | 100 ms |
| Patient fuzzy name search | 250 ms |
| KB answer — curated FAQ hit | 150 ms |
| KB answer — retrieval + LLM | 4 s (p95) |
| WhatsApp first reply after inbound message | 3 s (p95), excluding LLM steps; 6 s (p95) including them |
| Pre-brief ready after check-in | 10 s (p95) — it only needs to be ready before the doctor calls the token |
| Availability during OPD hours (08:00–17:00 IST) | 99.9% |

---

## 4. Architecture

### 4.1 Topology: one cell per state

```mermaid
flowchart LR
  subgraph Patients
    WA[WhatsApp] --- WEB[Web / PWA] --- KIOSK[Kiosk]
  end
  subgraph Cell["State cell (all data stays in India)"]
    LB[Load balancer / WAF]
    API[api]
    RT[realtime]
    WH[webhook]
    WK[worker]
    SCH[scheduler]
    PGB[(PgBouncer)]
    PG[(PostgreSQL 18 primary\n+ 2 replicas)]
    RC[(redis-core\nnoeviction + AOF)]
    RCA[(redis-cache\nLRU)]
    S3[(Object storage\nS3-compatible)]
  end
  EXT[LLM gateway → Claude API\nEmbeddings · ASR]
  WA --> WH
  WEB --> LB --> API
  KIOSK --> LB
  LB --> RT
  API --> PGB --> PG
  WK --> PGB
  API --> RC
  API --> RCA
  WH --> RC
  WK --> RC
  RT --> RC
  WK --> S3
  WK --> EXT
  API --> EXT
```

- **Cell = one state.** Each state gets its own database cluster, Redis and app processes. This matches how government health administration is organised (state health departments) and how ABDM is designed (federated: records stay where they were created; sharing happens through consent-based exchange). Cross-state patient history is fetched through ABDM's consent flow, not by sharing a database.
- **Within a cell**, `facility_id` is the tenant key on every facility-scoped table, enforced by row-level security (§13.3).
- For the assignment demo, the whole cell runs on one machine with `docker compose` (§19). The code is identical.

### 4.2 One codebase, five process roles (modular monolith)

| Role | Entry point | Responsibility | Scales with |
|---|---|---|---|
| `api` | `src/apps/api.ts` | REST API for patients, staff, admins, devices | HTTP traffic |
| `realtime` | `src/apps/realtime.ts` | Socket.IO for doctor dashboards, TV displays, patient status pages | Connected sockets |
| `webhook` | `src/apps/webhook.ts` | Receives WhatsApp webhooks, verifies signatures, dedupes, enqueues, returns 200 in < 100 ms | Inbound message rate |
| `worker` | `src/apps/worker.ts` | BullMQ consumers: intake steps, LLM calls, outbound messages, pre-briefs, ingestion, follow-ups, outbox relay | Job backlog |
| `scheduler` | `src/apps/scheduler.ts` | Repeatable jobs: partitions, retention, rollups, next-day queue sessions, audit digests (singleton via Redis lock) | Fixed (1 active + 1 standby) |

Modules live in `src/modules/<name>` and talk to each other only through their exported service interfaces and domain events. No module imports another module's repository. This keeps the door open to extracting a module into its own service later without rewriting it.

### 4.3 Request flow examples

**A. Patient sends "pet mein jalan hai 3 din se" on WhatsApp**

1. `webhook` verifies `X-Hub-Signature-256`, dedupes on the WhatsApp message id (Redis `SET NX`), enqueues `wa-inbound` (job id = message id), returns 200.
2. `worker` takes the per-conversation lock, loads conversation state, stores the message (encrypted), and advances the intake state machine (§9.3).
3. The complaint text passes the deterministic emergency screen (no hit), then the LLM extracts `SYM_ABDOMINAL_BURNING, duration 72h` (validated against the symptom catalog).
4. The clarifier picks the next vetted question ("Any vomiting?") from the question bank; the answer is a WhatsApp button reply.
5. Rules evaluate → `routine`; routing → `general_medicine` → "Medicine OPD, Room 7".
6. The patient gets a reporting window and a QR check-in code. At the gate, scanning the QR issues the token (§9.5). From then on, position and ETA alerts arrive on WhatsApp.

**B. Doctor clicks "Next patient"**

1. `api` runs the call-next transaction (`FOR UPDATE SKIP LOCKED` on the lane head, §7 Q5), writes the queue event and an outbox row, commits.
2. It updates the Redis read model and publishes `token.called` → `realtime` pushes to the room TV display, the doctor's dashboard and the patient's status page; `worker` sends the "Your turn — Room 7" WhatsApp message.
3. The doctor's screen already shows the pre-brief, generated when the patient checked in and cached in Redis.

---

## 5. Technology stack and decision log

### 5.1 Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 24 LTS, TypeScript (strict) | ESM modules |
| HTTP framework | Fastify 5 | Schema-based validation and serialization; fastest mainstream Node framework |
| Validation / contracts | Zod → OpenAPI 3.1 (via a Fastify Zod type provider + `@fastify/swagger`) | One schema for validation, types and docs |
| Database | PostgreSQL 18 | Native `uuidv7()`, async I/O, mature partitioning |
| Vector search | pgvector 0.8.x | `halfvec`, HNSW, iterative index scans for filtered search |
| Text search | Postgres full-text (`simple` config) + `pg_trgm` | Works for Hindi/Gujarati/English tokens and transliterated names |
| DB access | `pg` (node-postgres) + Kysely (type-safe SQL builder) | No heavy ORM: partitioning, `SKIP LOCKED`, CTEs and pgvector operators need full SQL control |
| Migrations | dbmate (plain `.sql` files with `-- migrate:up` / `-- migrate:down`) | Migrations are reviewable SQL, exactly as in §6 |
| Connection pooling | PgBouncer (transaction mode, `max_prepared_statements` enabled) | Session features (LISTEN/NOTIFY, session advisory locks, `SET` without `LOCAL`) MUST NOT be used through it |
| Cache / coordination | Redis 8 (or Valkey 8), two deployments (§8) | `ioredis` client |
| Job queues | BullMQ 5 | On `redis-core` |
| Realtime | Socket.IO 4 + Redis adapter | Rooms per queue / display / doctor / token |
| Object storage | S3-compatible (MinIO in dev/on-prem; an in-country S3 service in prod) | Documents, media, audit exports |
| LLM | Claude API via `@anthropic-ai/sdk`, behind an internal LLM gateway | Fast model for extraction/routing, stronger model for pre-briefs; models are config, not code |
| Embeddings | Provider interface; multilingual 1024-dim model | Hosted API or self-hosted (e.g. BGE-M3) — see §20 |
| Speech / translation (phase 2) | Provider interface; Bhashini (Government of India language platform) recommended | For voice notes in regional languages |
| Crypto | Node `crypto` (AES-256-GCM, HMAC-SHA256), `argon2` (argon2id) | Envelope encryption with KMS-held key-encryption keys |
| Observability | pino (JSON logs, PHI redaction), OpenTelemetry traces, Prometheus metrics (`prom-client`) | |
| Testing | Vitest, Testcontainers (`pgvector/pgvector:pg18`, `redis:8`), k6 | |

### 5.2 Decision log

Each decision lists what was chosen, what was rejected, and why. Claude Code MUST NOT reverse these without the user's approval.

| # | Decision | Rejected alternatives | Why |
|---|---|---|---|
| D1 | **Modular monolith** with five process roles | Microservices | One team, one deploy, transactional consistency between queue and encounter writes. Process roles still scale independently. |
| D2 | **Cell per state** | One national database; sharding by hash | Matches administrative and data-residency boundaries and ABDM's federated model; a failure in one state never affects another. |
| D3 | **UUIDv7 primary keys** generated by Postgres `uuidv7()` (or by the app with a v7 library when the id is needed before insert) | UUIDv4; `bigint` identity | v4 is random → index pages split everywhere → write amplification and cache misses at this scale. `bigint` leaks volumes, collides across cells and needs a round-trip to get ids. v7 is globally unique, time-ordered (B-tree inserts append at the right edge), sortable for keyset pagination, and usable as a partition key. |
| D4 | **Monthly range partitioning on the UUIDv7 key**; encounter-scoped tables are **co-partitioned on `encounter_id`** | Partitioning by `created_at`; no partitioning | Partitioning on the key itself keeps `PRIMARY KEY (id)` legal (Postgres requires the partition key inside every unique constraint) and keeps foreign keys to `encounters(id)` possible. Co-partitioning puts an encounter and all its children in the same month partition, so lookups by `encounter_id` prune to one partition, joins can be partition-wise, and a whole month can be archived together. |
| D5 | **Hot/historical split**: `opd_tokens` (14 days), `intake_sessions` (7 days), `inbound_dedupe` (8 days) are small unpartitioned tables; their facts are copied into partitioned history | One big partitioned table for everything | Hot tables need *global* unique constraints (e.g. one token number per queue per day) that partitioned tables can't enforce, and their indexes must stay small enough to live in memory. |
| D6 | **Token numbers are allocated in Postgres** under a row lock on `queue_sessions` | Redis `INCR` | A token number is a promise to a patient; it must never be lost or duplicated, even when Redis fails over. The lock is held ~1–2 ms and is per department, so throughput is far above need. Redis serves the 5,000 req/s of *reads*. |
| D7 | **Rules engine for urgency; LLM may only escalate** — enforced by a DB CHECK constraint | LLM-decided triage | Safety and auditability. Rules are versioned, clinician-approved (four-eyes) and covered by test cases. |
| D8 | **LLM selects from vetted questions and vetted content** | Free-form generated questions and advice | Consistent, translatable, clinically reviewed; prevents the model from improvising medical advice. |
| D9 | **Patient history = SQL + a denormalized summary row**; RAG only over unstructured documents; **exact** (not approximate) vector search per patient | Embedding everything into one vector index | A missed allergy because of approximate recall is unacceptable. A single patient's document chunks are a few dozen rows: exact search is 100% recall and sub-millisecond. |
| D10 | **Hybrid KB retrieval**: pgvector + full-text, fused with Reciprocal Rank Fusion, plus a curated-FAQ fast path | Vector-only search | Vector search misses exact terms (room numbers, scheme names, "PMJAY"); full-text misses paraphrases. RRF needs no score calibration. Curated answers skip the LLM entirely for the most common questions. |
| D11 | **`halfvec(1024)` + HNSW + iterative index scans** | `vector(1536)` float32; IVFFlat | Half the memory with negligible recall loss; HNSW needs no training and handles inserts; iterative scans (pgvector ≥ 0.8) keep recall high when filtering by facility and language. |
| D12 | **Kysely + raw SQL migrations** | Prisma / TypeORM / Drizzle schema-first | The schema relies on partitioning, partial and HNSW indexes, RLS, CHECK constraints with enums and SQL functions, which ORM schema tools model poorly. |
| D13 | **Two Redis deployments** | One Redis | BullMQ and the queue read model need `noeviction` + AOF persistence; caches need LRU eviction. Mixing them means either losing jobs or running out of memory. |
| D14 | **Application-level encryption + blind indexes** for direct identifiers (phone, ABHA number, address) | Plaintext; DB-level `pgcrypto` | Keys stay out of the database and out of SQL logs. HMAC blind indexes still allow exact lookups. |
| D15 | **Household model**: a phone number is a *contact point* that can link to many patients | `patients.phone UNIQUE` | In India one phone is often shared by a whole family, or belongs to an ASHA worker who registers many villagers. |
| D16 | **WhatsApp-first; web and kiosk are adapters on the same engine** | Website form as the primary channel | Reaches users who won't install apps or fill web forms. The intake engine is channel-agnostic. |
| D17 | **Offline token blocks** for counters and kiosks | Requiring connectivity for every token | Hospital internet is unreliable. A device holds a pre-allocated number range and syncs later without conflicts. |
| D18 | **Transactional outbox** for every side effect (Redis projection, notifications, realtime) | Fire-and-forget after commit | Side effects survive crashes between commit and publish; consumers are idempotent. |

---

## 6. Database design

### 6.1 Conventions

- Table names: `snake_case`, plural. Columns: `snake_case`. Foreign keys: `<entity>_id`.
- Every entity table has `id uuid PRIMARY KEY DEFAULT uuidv7()`. Small rollup tables keyed by natural composite keys (e.g. `facility_daily_stats`) are the only exception: they are aggregates, not entities.
- All timestamps are `timestamptz` (stored in UTC). Business dates (`session_date`, `stat_date`) are `date` values computed in IST by the application.
- Status fields use Postgres `ENUM` types. Enum declaration order is meaningful where noted (e.g. `triage_level` is declared from most to least urgent, so `<` means "more urgent").
- Mutable entities carry `version int` for optimistic concurrency (`UPDATE ... WHERE id = $1 AND version = $2`, then `version = version + 1`). The API exposes it as an `ETag`.
- No soft-delete flags on clinical data. Records change status (`entered_in_error`, `inactive`) and are never silently hidden.
- Encrypted columns end in `_enc` (AES-256-GCM ciphertext, `bytea`), blind-index columns end in `_hash` (HMAC-SHA256, `bytea`), and rows with encrypted columns carry `key_version smallint` (§13.2).

### 6.2 Table tiers

| Tier | Tables | Storage strategy |
|---|---|---|
| **Reference / entity** (long-lived, moderate size) | facilities, departments, service_points, users, staff_memberships, devices, schedules, contact_points, patients, patient_identifiers, patient_contacts, consents, allergies, conditions, patient_clinical_summaries, conversations, queue_sessions, kb_*, faq_*, symptom_catalog, intake_questions, triage_rule_sets, message_templates, patient_documents | Unpartitioned, UUIDv7 PK |
| **Hot operational** (small, constantly updated, strict constraints) | opd_tokens (14 days), intake_sessions (7 days), emergency_prealerts (30 days), inbound_dedupe (8 days), outbox_events (1 day after publish) | Unpartitioned, rolling window enforced by the retention job, `fillfactor` < 100 for HOT updates |
| **History** (append-mostly, high volume) | encounters, triage_assessments, prebriefs, encounter_diagnoses, prescription_items, observations, followups, queue_events, messages, notifications, llm_calls, audit_events | `PARTITION BY RANGE` on the UUIDv7 key, one partition per month |
| **Rollups** | facility_daily_stats, facility_hourly_arrivals | Composite natural PK, upserted by scheduled jobs |

🔒 **Rule:** a long-lived table MUST NOT hold a foreign key into a partitioned history table (use a plain `uuid` column, a "soft reference", with a comment). Otherwise old partitions could never be detached for archival. Co-partitioned children are the exception: they hold an FK to `encounters` and are detached together with it (children first).

### 6.3 Partitioning on UUIDv7

A UUIDv7 starts with a 48-bit Unix timestamp in milliseconds, and Postgres compares `uuid` values byte by byte. So all ids generated in October 2026 fall between two fixed UUIDs: the timestamp of 1 Oct 2026 00:00 UTC followed by zero bits, and the same for 1 Nov 2026. The function `uuid7_boundary(ts)` (migration 0001) computes these bounds, and `create_month_partition()` uses them:

```
encounters_p202610  FOR VALUES FROM ('01a0f4c2-c400-0000-0000-000000000000')   -- uuid7_boundary('2026-10-01 00:00 UTC')
                                TO   ('01a19467-e800-0000-0000-000000000000')   -- uuid7_boundary('2026-11-01 00:00 UTC')
```

An id generated on 6 Oct 2026, e.g. `01a11271-9781-7fff-a525-eb2c24ae94ac`, sorts between the two bounds, so it lands in `encounters_p202610`. (`uuid_extract_timestamp()` returns NULL for the bounds themselves because their version bits are zero; they are comparison bounds, not real ids.)

Consequences the application MUST respect:

1. **Lookups by key prune to one partition automatically** (`WHERE id = $1`, `WHERE encounter_id = $1`).
2. **Lookups by another column** (e.g. `patient_id`) SHOULD add a time bound on the key so old partitions are skipped: `AND id >= $bound` where `$bound = uuid7Boundary(now − 24 months)` is computed in TypeScript (`src/shared/ids.ts`, same algorithm as the SQL function).
3. **Child rows of an encounter use the encounter's id as their partition key**, so they always land in the same month as the encounter, even if they are written weeks later (a follow-up response, a late lab result).
4. **Ids that must exist before the insert** (e.g. the encounter id is needed to build the outbox payload) are generated in the app with a UUIDv7 library (`uuid` package `v7()`), never with v4.
5. Partitions are created 3 months ahead by the daily `partition-maintenance` job (`SELECT ensure_partitions(1, 3)`). There is deliberately **no DEFAULT partition**: an insert into a missing month fails loudly instead of silently piling rows into a catch-all. An alert fires if fewer than 2 future partitions exist (§15).

### 6.4 Migrations

Each block below is one dbmate migration file. The `-- file:` line is the path to create. dbmate wraps each file in a transaction.

#### Migration 0001 — foundation (extensions, roles, helpers, partition tooling)

```sql
-- file: db/migrations/20261006000001_foundation.sql
-- migrate:up
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Group roles. Login users (e.g. sahayak_api IN ROLE app_rw) are created by infrastructure code.
-- The migration user owns all objects; app_rw / app_ro never own tables (so RLS applies to them).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN CREATE ROLE app_rw NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ro') THEN CREATE ROLE app_ro NOLOGIN; END IF;
END $$;

-- Smallest UUIDv7 that can be generated at or after ts: 48-bit ms timestamp followed by zero bits.
CREATE FUNCTION uuid7_boundary(ts timestamptz) RETURNS uuid
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (lpad(to_hex(floor(extract(epoch FROM ts) * 1000)::bigint), 12, '0')
          || '00000000000000000000')::uuid
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Request scope for row-level security. The API sets these per transaction:
--   SELECT set_config('app.facility_ids', '<uuid>,<uuid>', true), set_config('app.scope', 'facility', true);
-- Unset or empty settings mean "no facilities" (fail closed).
CREATE FUNCTION app_facility_ids() RETURNS uuid[]
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN coalesce(current_setting('app.facility_ids', true), '') = '' THEN '{}'::uuid[]
              ELSE string_to_array(current_setting('app.facility_ids', true), ',')::uuid[] END
$$;

CREATE FUNCTION app_is_state_scope() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('app.scope', true), '') = 'state'
$$;

-- Registry of monthly-partitioned tables and their retention.
CREATE TABLE partition_registry (
  parent_table        regclass PRIMARY KEY,
  retention_months    int CHECK (retention_months IS NULL OR retention_months >= 1), -- NULL = never auto-expire
  archive_before_drop boolean NOT NULL DEFAULT true,
  detach_order        smallint NOT NULL DEFAULT 50  -- lower = detached earlier (children before parents)
);

CREATE FUNCTION create_month_partition(p_parent regclass, p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_rel   text;
  v_nsp   text;
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text;
BEGIN
  SELECT c.relname, n.nspname INTO v_rel, v_nsp
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = p_parent;

  v_name := v_rel || '_p' || to_char(v_start, 'YYYYMM');
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
    v_nsp, v_name, v_nsp, v_rel,
    uuid7_boundary(v_start::timestamp AT TIME ZONE 'UTC'),
    uuid7_boundary(v_end::timestamp AT TIME ZONE 'UTC'));
  RETURN v_name;
END $$;

-- Idempotent. Run daily by the scheduler and at the end of every migration that adds a partitioned table.
CREATE FUNCTION ensure_partitions(p_months_back int DEFAULT 1, p_months_ahead int DEFAULT 3)
RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  m int;
BEGIN
  FOR r IN SELECT parent_table FROM partition_registry ORDER BY detach_order DESC LOOP
    FOR m IN -p_months_back .. p_months_ahead LOOP
      RETURN NEXT create_month_partition(
        r.parent_table,
        (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => m))::date);
    END LOOP;
  END LOOP;
END $$;

-- Partitions older than their table's retention. The retention job exports each one to object
-- storage, then runs ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY and DROP TABLE outside a transaction.
CREATE FUNCTION list_expired_partitions()
RETURNS TABLE (parent_table regclass, partition_name text, partition_month date, detach_order smallint)
LANGUAGE sql STABLE AS $$
  SELECT r.parent_table, c.relname::text, to_date(right(c.relname, 6), 'YYYYMM'), r.detach_order
  FROM partition_registry r
  JOIN pg_inherits i ON i.inhparent = r.parent_table
  JOIN pg_class c    ON c.oid = i.inhrelid
  WHERE r.retention_months IS NOT NULL
    AND c.relname ~ '_p[0-9]{6}$'
    AND to_date(right(c.relname, 6), 'YYYYMM')
        < (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => r.retention_months))::date
  ORDER BY r.detach_order, 3
$$;

-- migrate:down
DROP FUNCTION IF EXISTS list_expired_partitions();
DROP FUNCTION IF EXISTS ensure_partitions(int, int);
DROP FUNCTION IF EXISTS create_month_partition(regclass, date);
DROP TABLE IF EXISTS partition_registry;
DROP FUNCTION IF EXISTS app_is_state_scope();
DROP FUNCTION IF EXISTS app_facility_ids();
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS uuid7_boundary(timestamptz);
```

#### Migration 0002 — organisation, staff and devices

```sql
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
```

#### Migration 0003 — patients, households, consent, clinical summary

```sql
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
```

#### Migration 0004 — encounters and clinical history (partitioned, co-partitioned on encounter id)

```sql
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
```

> Down migrations exist for local development only. In production, never roll back a migration that dropped or rewrote data; write a forward migration instead.

#### Migration 0005 — OPD queue

```sql
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
```

#### Migration 0006 — conversations, intake, messaging

```sql
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
```

#### Migration 0007 — triage rules, symptom catalog, question bank

```sql
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
```

#### Migration 0008 — knowledge base, FAQ, patient documents

```sql
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
```

#### Migration 0009 — outbox, LLM call log, audit trail

```sql
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
```

#### Migration 0010 — analytics rollups

```sql
-- file: db/migrations/20261006000010_analytics.sql
-- migrate:up
CREATE TABLE facility_daily_stats (
  facility_id             uuid NOT NULL REFERENCES facilities(id),
  department_id           uuid NOT NULL REFERENCES departments(id),
  stat_date               date NOT NULL,
  registrations           int NOT NULL DEFAULT 0,
  checked_in              int NOT NULL DEFAULT 0,
  seen                    int NOT NULL DEFAULT 0,
  no_shows                int NOT NULL DEFAULT 0,
  left_without_being_seen int NOT NULL DEFAULT 0,
  triage_emergency        int NOT NULL DEFAULT 0,
  triage_priority         int NOT NULL DEFAULT 0,
  triage_routine          int NOT NULL DEFAULT 0,
  triage_self_care        int NOT NULL DEFAULT 0,
  triage_overrides        int NOT NULL DEFAULT 0,
  ai_fallback_count       int NOT NULL DEFAULT 0,
  wait_p50_seconds        int,
  wait_p90_seconds        int,
  consult_p50_seconds     int,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  is_final                boolean NOT NULL DEFAULT false,
  PRIMARY KEY (facility_id, department_id, stat_date)
);

CREATE TABLE facility_hourly_arrivals (
  facility_id   uuid NOT NULL REFERENCES facilities(id),
  department_id uuid NOT NULL REFERENCES departments(id),
  stat_date     date NOT NULL,
  hour          smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),   -- IST hour
  arrivals      int NOT NULL,
  PRIMARY KEY (facility_id, department_id, stat_date, hour)
);

-- migrate:down
DROP TABLE IF EXISTS facility_hourly_arrivals, facility_daily_stats;
```

#### Migration 0011 — grants and row-level security

```sql
-- file: db/migrations/20261006000011_access_control.sql
-- migrate:up
GRANT USAGE ON SCHEMA public TO app_rw, app_ro;

-- Grant on top-level tables only. Partitions get NO direct grants, so the application can only reach
-- partitioned data through the parent table, where the RLS policies below apply.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_rw', t.relname);
    EXECUTE format('GRANT SELECT ON %I TO app_ro', t.relname);
  END LOOP;
END $$;

-- Append-only and maintenance-only tables.
REVOKE UPDATE, DELETE ON audit_events, consents, queue_events, llm_calls FROM app_rw;
REVOKE INSERT, UPDATE, DELETE ON partition_registry FROM app_rw;
REVOKE ALL ON partition_registry FROM app_ro;
REVOKE EXECUTE ON FUNCTION create_month_partition(regclass, date), ensure_partitions(int, int) FROM PUBLIC;

-- 🔒 Facility isolation (fail closed). The (SELECT ...) wrappers make Postgres evaluate the scope once per query.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'encounters', 'triage_assessments', 'prebriefs', 'encounter_diagnoses', 'prescription_items', 'observations',
    'followups', 'queue_sessions', 'opd_tokens', 'queue_events', 'emergency_prealerts',
    'facility_daily_stats', 'facility_hourly_arrivals']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY facility_isolation ON %I TO app_rw, app_ro
         USING ((SELECT app_is_state_scope()) OR facility_id = ANY ((SELECT app_facility_ids())::uuid[]))', t);
  END LOOP;
END $$;

-- migrate:down
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'encounters', 'triage_assessments', 'prebriefs', 'encounter_diagnoses', 'prescription_items', 'observations',
    'followups', 'queue_sessions', 'opd_tokens', 'queue_events', 'emergency_prealerts',
    'facility_daily_stats', 'facility_hourly_arrivals']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS facility_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
```

How the API uses RLS (in every request transaction, via a Kysely helper `withScope(trx, scope)`):

```sql
SELECT set_config('app.scope', 'facility', true),                       -- or 'state' for state admins and system jobs
       set_config('app.facility_ids', '<uuid1>,<uuid2>', true);         -- facilities from the caller's active memberships
```

`set_config(..., true)` is transaction-local, so it is safe with PgBouncer transaction pooling. Workers and the scheduler use `app.scope = 'state'`. Migrations and partition maintenance run as the owner role, which is not subject to these policies.

---

## 7. Indexing strategy and hot-query catalogue

### 7.1 Indexing rules

1. Every foreign key column used in a join or lookup has an index (or is the leading column of one).
2. **Partial indexes for "live" subsets.** The queue only ever scans `status = 'waiting'` tokens, so `opd_tokens_waiting_idx` contains only those rows: a few thousand entries state-wide, always in memory.
3. **Index column order follows the query:** equality columns first, then the sort order. `opd_tokens_waiting_idx (queue_session_id, lane, queue_entry_at, token_no)` serves "head of this lane" as a single index probe.
4. **On partitioned tables, indexes are created on the parent** (they cascade to every partition). In later migrations, to add an index without locking, create it `CONCURRENTLY` on each partition, then `CREATE INDEX ... ON ONLY parent` and `ALTER INDEX ... ATTACH PARTITION` for each (§14.5).
5. **Bound queries on non-key columns** of partitioned tables with `AND id >= $bound` (§6.3) so old partitions are pruned.
6. **Vector indexes only where the corpus is large and shared** (kb_chunks, faq_variants, symptom_catalog). Never on per-patient data.
7. Every new query on a hot path ships with its `EXPLAIN (ANALYZE, BUFFERS)` output on seeded data in the PR description.

### 7.2 Hot queries

These are the queries the hot paths depend on, with the index each one must use. Repositories MUST implement them as written (Kysely `sql` template literals are fine). Parameter types are noted in the header comment.

**Q1 — Household lookup by phone** (registration, WhatsApp "who is this visit for"). Uses `contact_points_kind_value_hash_key` → `patient_contacts_pkey` → `patients_pkey`.

```sql
-- query: Q1  $1 bytea = HMAC blind index of the normalised phone number
SELECT p.id, p.display_name, p.sex, p.birth_date, p.birth_year, pc.relationship, pc.is_primary
FROM contact_points cp
JOIN patient_contacts pc ON pc.contact_point_id = cp.id
JOIN patients p ON p.id = pc.patient_id AND p.status = 'active' AND p.merged_into_id IS NULL
WHERE cp.kind = 'phone' AND cp.value_hash = $1
ORDER BY pc.is_primary DESC, p.display_name
LIMIT 20;
```

**Q2 — Patient by ABHA number** (exact). Uses `patient_identifiers_uq`. For a facility MRN, use `kind = 'facility_mrn' AND facility_id = $2` instead of `facility_id IS NULL`.

```sql
-- query: Q2  $1 bytea = HMAC blind index of the ABHA number
SELECT p.id, p.display_name, p.sex, p.birth_date, p.birth_year
FROM patient_identifiers pi
JOIN patients p ON p.id = pi.patient_id
WHERE pi.kind = 'abha_number' AND pi.facility_id IS NULL AND pi.value_hash = $1;
```

**Q3 — Fuzzy patient search** at the counter ("Ramesh Patel, about 45, Sanand"). Uses `patients_name_trgm_idx`. Run `SET LOCAL pg_trgm.similarity_threshold = 0.35` in the same transaction.

```sql
-- query: Q3  $1 text = normalised Latin name, $2 text = district code, $3 int = estimated birth year
SELECT id, display_name, sex, birth_year, similarity(name_search, $1) AS score
FROM patients
WHERE name_search % $1
  AND district_code = $2
  AND birth_year BETWEEN $3 - 3 AND $3 + 3
  AND status = 'active'
  AND merged_into_id IS NULL
ORDER BY score DESC
LIMIT 20;
```

**Q4 — Check-in: allocate the token number** (D6). First statement of the check-in transaction (§9.5.3). The row lock on the session serialises check-ins for one department for ~1–2 ms.

```sql
-- query: Q4  $1 uuid = queue_session_id
UPDATE queue_sessions
SET last_token_no = last_token_no + 1
WHERE id = $1
  AND status IN ('scheduled', 'open')
  AND (capacity IS NULL OR last_token_no < capacity)
RETURNING last_token_no AS token_no, token_prefix;
```

Zero rows returned means the session is closed or full: the API answers `409 queue_unavailable`.

**Q5 — Call next patient.** The lane is chosen by the lane-selection algorithm (§9.5.4) before this runs; if the chosen lane returns no row, the next lane is tried. Uses `opd_tokens_waiting_idx`. `SKIP LOCKED` lets two doctors serving the same queue call at the same instant without blocking or double-calling.

```sql
-- query: Q5  $1 uuid = queue_session_id, $2 smallint = lane, $3 uuid = doctor user id, $4 uuid = service point id
WITH next AS (
  SELECT id
  FROM opd_tokens
  WHERE queue_session_id = $1
    AND status = 'waiting'
    AND lane = $2
    AND (preferred_doctor_id IS NULL OR preferred_doctor_id = $3)
  ORDER BY queue_entry_at, token_no
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE opd_tokens t
SET status = 'called',
    called_at = now(),
    call_count = t.call_count + 1,
    served_by = $3,
    service_point_id = $4,
    version = t.version + 1
FROM next
WHERE t.id = next.id
RETURNING t.id, t.encounter_id, t.display_code, t.lane, t.version;
```

**Q6 — Recent visits for the pre-brief.** Uses `encounters_patient_idx` per partition with a Merge Append in id order, so only a handful of index entries are read even across 24 partitions. The child subqueries prune to one partition each because they filter on `encounter_id`.

```sql
-- query: Q6  $1 uuid = patient_id, $2 uuid = uuid7Boundary(now - 24 months), $3 int = limit (5)
SELECT e.id, e.session_date, e.facility_id, e.department_id, e.triage_level, e.status,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('code', d.code, 'text', d.display_text)
                                  ORDER BY d.is_primary DESC), '[]'::jsonb)
          FROM encounter_diagnoses d WHERE d.encounter_id = e.id) AS diagnoses,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('drug', p.drug_name, 'dose', p.dose,
                                                     'frequency', p.frequency, 'days', p.duration_days)), '[]'::jsonb)
          FROM prescription_items p WHERE p.encounter_id = e.id) AS prescriptions
FROM encounters e
WHERE e.patient_id = $1
  AND e.id >= $2
  AND e.status IN ('completed', 'referred')
ORDER BY e.id DESC
LIMIT $3;
```

**Q7 — Hybrid knowledge-base retrieval** (D10). One round trip: approximate vector top-40 and full-text top-40, fused by Reciprocal Rank Fusion (k = 60). Run in a transaction preceded by:

```sql
SET LOCAL hnsw.ef_search = 100;
SET LOCAL hnsw.iterative_scan = relaxed_order;   -- keep scanning the graph until 40 rows pass the facility/language filter
```

```sql
-- query: Q7  $1 halfvec(1024) = query embedding, $2 text = query text, $3 uuid = facility_id, $4 text[] = languages, $5 int = k
WITH vec AS (
  SELECT id, row_number() OVER (ORDER BY dist) AS rnk
  FROM (
    SELECT id, embedding <=> $1::halfvec(1024) AS dist
    FROM kb_chunks
    WHERE is_active
      AND (facility_id = $3 OR facility_id IS NULL)
      AND language = ANY ($4)
    ORDER BY embedding <=> $1::halfvec(1024)
    LIMIT 40
  ) v
),
fts AS (
  SELECT id, row_number() OVER (ORDER BY rank DESC) AS rnk
  FROM (
    SELECT c.id, ts_rank_cd(c.content_tsv, q) AS rank
    FROM kb_chunks c, websearch_to_tsquery('simple', $2) q
    WHERE c.is_active
      AND c.content_tsv @@ q
      AND (c.facility_id = $3 OR c.facility_id IS NULL)
      AND c.language = ANY ($4)
    ORDER BY rank DESC
    LIMIT 40
  ) f
),
fused AS (
  SELECT id, sum(1.0 / (60 + rnk)) AS rrf
  FROM (SELECT id, rnk FROM vec UNION ALL SELECT id, rnk FROM fts) u
  GROUP BY id
)
SELECT c.id, c.document_id, c.doc_type, c.heading_path, c.content, f.rrf,
       1 - (c.embedding <=> $1::halfvec(1024)) AS cosine_similarity
FROM fused f
JOIN kb_chunks c ON c.id = f.id
ORDER BY f.rrf DESC
LIMIT $5;
```

Planner behaviour (verified on PostgreSQL 18.3 + pgvector 0.8.1): when the facility + language slice is small (e.g. 100 chunks), the planner uses `kb_chunks_scope_idx` and sorts the slice exactly, which gives 100% recall in a few milliseconds. When the slice is large (state-wide documents, several languages), it switches to `kb_chunks_embedding_idx` (HNSW) with the filter applied during the iterative scan. Do not force one plan with hints; both are correct, and the choice tracks the data.

**Q8 — Curated FAQ fast path.** If the best `similarity` ≥ the calibrated threshold (start at 0.88; tune on `kb_eval_cases`), the vetted answer is returned directly with no LLM call.

```sql
-- query: Q8  $1 halfvec(1024) = query embedding, $2 uuid = facility_id, $3 text = language
SELECT v.faq_id, f.answer_i18n, v.question, 1 - (v.embedding <=> $1::halfvec(1024)) AS similarity
FROM faq_variants v
JOIN faq_entries f ON f.id = v.faq_id AND f.status = 'active'
WHERE v.is_active
  AND (v.facility_id = $2 OR v.facility_id IS NULL)
  AND v.language = $3
ORDER BY v.embedding <=> $1::halfvec(1024)
LIMIT 3;
```

**Q9 — Symptom normalisation candidates.** Exact synonym hits first (`symptom_catalog_synonyms_idx`), then the 5 nearest catalog entries by embedding. The LLM extractor must pick codes from these candidates (§9.3).

```sql
-- query: Q9  $1 text = normalised phrase, $2 halfvec(1024) = phrase embedding
SELECT code, labels, default_specialty_code, is_red_flag, max(similarity) AS similarity
FROM (
  SELECT code, labels, default_specialty_code, is_red_flag, 1.0::float8 AS similarity
  FROM symptom_catalog
  WHERE status = 'active' AND synonyms @> ARRAY[$1]::text[]
  UNION ALL
  (SELECT code, labels, default_specialty_code, is_red_flag, 1 - (embedding <=> $2::halfvec(1024))
   FROM symptom_catalog
   WHERE status = 'active' AND embedding IS NOT NULL
   ORDER BY embedding <=> $2::halfvec(1024)
   LIMIT 5)
) candidates
GROUP BY code, labels, default_specialty_code, is_red_flag
ORDER BY similarity DESC;
```

**Q10 — Search one patient's documents** (phase 2, D9). Exact nearest-neighbour over that patient's chunks only: `patient_doc_chunks_patient_idx` → sort a few dozen rows → 100% recall.

```sql
-- query: Q10  $1 uuid = patient_id, $2 halfvec(1024) = question embedding
SELECT c.document_id, c.chunk_index, c.content, 1 - (c.embedding <=> $2::halfvec(1024)) AS similarity
FROM patient_doc_chunks c
WHERE c.patient_id = $1
ORDER BY c.embedding <=> $2::halfvec(1024)
LIMIT 8;
```

**Q11 — Outbox relay batch.** Two relay instances can run concurrently thanks to `SKIP LOCKED`.

```sql
-- query: Q11  (no parameters)
SELECT id, aggregate_type, aggregate_id, event_type, payload
FROM outbox_events
WHERE published_at IS NULL
ORDER BY id
LIMIT 500
FOR UPDATE SKIP LOCKED;
```

**Q12 — Due follow-ups sweep** (safety net behind BullMQ delayed jobs). The bound prunes old partitions.

```sql
-- query: Q12  $1 uuid = uuid7Boundary(now - 6 months)
SELECT encounter_id, id, contact_point_id, kind, template_code, payload
FROM followups
WHERE status = 'scheduled'
  AND due_at <= now()
  AND encounter_id >= $1
ORDER BY due_at
LIMIT 500
FOR UPDATE SKIP LOCKED;
```

**Q13 — WhatsApp delivery status update.** Status callbacks can arrive out of order; the enum order (`queued < sent < delivered < read`) prevents a late "delivered" from overwriting "read". The id bound limits the search to the last 7 days.

```sql
-- query: Q13  $1 text = provider message id, $2 message_status = new status, $3 uuid = uuid7Boundary(now - 7 days)
UPDATE messages
SET status = $2, status_updated_at = now()
WHERE provider_message_id = $1
  AND direction = 'outbound'
  AND id >= $3
  AND status < $2;
```

**Q14 — "Who accessed my record"** (patient right of access, DPO investigations).

```sql
-- query: Q14  $1 uuid = patient_id, $2 uuid = uuid7Boundary(now - 12 months)
SELECT occurred_at, actor_kind, actor_id, facility_id, action, purpose
FROM audit_events
WHERE patient_id = $1 AND id >= $2
ORDER BY id DESC
LIMIT 100;
```

**Q15 — Queue snapshot for rebuilding the Redis read model** (§8.4).

```sql
-- query: Q15  $1 uuid = queue_session_id
SELECT id, lane, queue_entry_at, token_no, status, display_code, served_by, service_point_id, version
FROM opd_tokens
WHERE queue_session_id = $1
  AND status IN ('waiting', 'called', 'in_consult');
```

---

## 8. Redis design

### 8.1 Two deployments (D13)

| Instance | Holds | Config |
|---|---|---|
| `redis-core` | BullMQ queues, queue read model, locks, rate limits, idempotency keys, dedupe keys, OTPs, version counters, Socket.IO adapter channels | `maxmemory-policy noeviction`, `appendonly yes`, `appendfsync everysec`, 1 primary + 1 replica + 3 Sentinels (or a managed equivalent). Alert at 70% memory. |
| `redis-cache` | Facility config, patient summaries, pre-briefs, KB answers, public wait boards | `maxmemory-policy allkeys-lru`, no persistence, 1 primary (+ replica optional). Losing it only costs latency. |

Both use TLS and ACL users per process role. 🔒 Key names never contain direct identifiers (no phone numbers, names or ABHA numbers): use UUIDs or HMAC hashes. 🔒 Values that contain PHI are encrypted with AES-256-GCM using a cache data key before being written (`src/infra/cache.ts` does this transparently for keys declared `phi: true`).

All keys of one queue session share the hash tag `{<queueSessionId>}` so that Lua scripts can touch them atomically, and so the move to Redis Cluster later needs no key changes.

### 8.2 Key catalogue

| Key | Type | Instance | TTL | Purpose |
|---|---|---|---|---|
| `q:{qs}:lane:0` / `:1` / `:2` | ZSET (member = tokenId, score = queue_entry_at in ms) | core | session end + 6 h | Waiting tokens per lane |
| `q:{qs}:tok:<tokenId>` | HASH (`v`, `status`, `lane`, `code`, `room`) | core | 24 h (2 h after completion) | Token state for status pages and displays; `v` = opd_tokens.version |
| `q:{qs}:meta` | HASH (`status`, `ewma_consult_sec`, `active_servers`, `ratio_protected`, `ratio_general`, `served_protected`, `served_general`, `starts_at`) | core | session end + 6 h | ETA and lane-selection inputs |
| `q:{qs}:serving` | HASH (doctorUserId → tokenId) | core | session end + 6 h | Who is with whom |
| `tokref:<publicRef>` | STRING → `<qsId>:<tokenId>` | core | 36 h | Resolves the patient's status link |
| `doc:<userId>:status` | HASH (`status`, `qs`, `since`) | core | 15 min, refreshed by dashboard heartbeat every 60 s | Doctor availability: `in_opd`, `on_rounds`, `in_surgery`, `on_break`, `off` |
| `lock:conv:<conversationId>` | STRING (random owner token) | core | 30 s | Per-conversation processing lock (§9.9) |
| `lock:leader:scheduler` | STRING | core | 30 s, renewed every 10 s | Single active scheduler |
| `dedupe:wa:<providerMessageId>` | STRING | core | 8 days | Webhook dedupe fast path |
| `notif:once:<dedupeKey>` | STRING | core | 48 h | Each threshold alert is sent once |
| `idem:<principalId>:<idempotencyKey>` | STRING (JSON of status + body) | core | 24 h | Idempotent POST replay |
| `otp:<contactHash>` | HASH (`code_hash`, `attempts`) | core | 5 min | Patient OTP |
| `rl:<scope>:<id>:<window>` | STRING counter | core | window length | Rate limits (§13.5) |
| `kbver:<facilityId>` / `kbver:state` | STRING counter | core | none | KB version, part of answer-cache keys (must not be evicted) |
| `rulesver` | STRING counter | core | none | Triage rule set version for in-process caches |
| `llm:budget:<facilityId>:<yyyymmdd>` | STRING counter (tokens) | core | 48 h | Daily LLM budget per facility |
| `cb:<provider>` | HASH | core | 10 min | Shared circuit-breaker state |
| `cfg:facility:<facilityId>` | STRING (JSON) | cache | 10 min + pub/sub invalidation | Departments, service points, today's schedule |
| `pt:summary:<patientId>:<sourceVersion>` | STRING (encrypted JSON) | cache | 15 min | Clinical summary read model |
| `prebrief:<encounterId>` | STRING (encrypted JSON) | cache | 12 h | Doctor pre-brief |
| `kb:ans:<facilityId>:<lang>:<kbver>:<sha1(normalised question)>` | STRING (JSON) | cache | 6 h | KB answers; a new `kbver` makes old entries unreachable |
| `waitboard:<facilityId>` | STRING (JSON) | cache | 15 s | Public per-department wait snapshot |

### 8.3 Queue read model scripts

All queue mutations happen in Postgres first. After commit, the API applies the change to Redis with `apply_token_state.lua`; the outbox relay replays the same call if the API crashed in between. The script is version-guarded, so replays and out-of-order deliveries are harmless.

```lua
-- apply_token_state.lua — idempotent, version-guarded projection of one token.
-- KEYS[1] = q:{qs}:tok:<tokenId>, KEYS[2] = q:{qs}:lane:0, KEYS[3] = q:{qs}:lane:1, KEYS[4] = q:{qs}:lane:2
-- ARGV[1] = tokenId, ARGV[2] = version, ARGV[3] = status, ARGV[4] = lane (0-2),
-- ARGV[5] = score (queue_entry_at, epoch ms), ARGV[6] = display code, ARGV[7] = room label
local current = tonumber(redis.call('HGET', KEYS[1], 'v') or '-1')
local version = tonumber(ARGV[2])
if version <= current then return 0 end                       -- stale or duplicate event
for i = 2, 4 do redis.call('ZREM', KEYS[i], ARGV[1]) end
if ARGV[3] == 'waiting' then
  redis.call('ZADD', KEYS[tonumber(ARGV[4]) + 2], ARGV[5], ARGV[1])
end
redis.call('HSET', KEYS[1], 'v', version, 'status', ARGV[3], 'lane', ARGV[4], 'code', ARGV[6], 'room', ARGV[7])
local terminal = { completed = true, cancelled = true, no_show = true, transferred = true }
redis.call('EXPIRE', KEYS[1], terminal[ARGV[3]] and 7200 or 86400)
return 1
```

```lua
-- token_position.lua — position, people ahead, and ETA for one waiting token. O(log n).
-- KEYS[1..3] = q:{qs}:lane:0..2, KEYS[4] = q:{qs}:meta
-- ARGV[1] = tokenId, ARGV[2] = lane (0-2)
local lane = tonumber(ARGV[2])
local rank = redis.call('ZRANK', KEYS[lane + 1], ARGV[1])
if not rank then return nil end
local urgent    = redis.call('ZCARD', KEYS[1])
local protected = redis.call('ZCARD', KEYS[2])
local general   = redis.call('ZCARD', KEYS[3])
local m = redis.call('HMGET', KEYS[4], 'ewma_consult_sec', 'active_servers', 'ratio_protected', 'ratio_general')
local ewma    = tonumber(m[1]) or 300
local servers = math.max(tonumber(m[2]) or 1, 1)
local rp      = math.max(tonumber(m[3]) or 1, 1)
local rg      = math.max(tonumber(m[4]) or 2, 1)
local ahead
if lane == 0 then
  ahead = rank
elseif lane == 1 then
  ahead = urgent + rank + math.min(general, math.ceil((rank + 1) * rg / rp))
else
  ahead = urgent + rank + math.min(protected, math.ceil((rank + 1) * rp / rg))
end
return { rank, ahead, math.ceil((ahead + 1) / servers) * ewma }
```

The API adds the "session has not started yet" offset (`max(0, starts_at − now)`) and presents the ETA as a range: `[0.8 × eta, 1.3 × eta]`, rounded to 5 minutes. 🔒 Never show a single exact time; it creates false precision and crowding at the door.

### 8.4 Rebuild and reconciliation

- **Rebuild** (on Redis failover, on demand, or after a reconcile mismatch): run Q15, then in one pipeline delete the session's lane keys and call `apply_token_state.lua` for each token with its current version. Takes milliseconds per session.
- **Reconcile** (scheduler, every 60 s for each open session): compare `ZCARD` of each lane with `SELECT lane, count(*) FROM opd_tokens WHERE queue_session_id = $1 AND status = 'waiting' GROUP BY lane` (index-only on `opd_tokens_waiting_idx`). On mismatch: rebuild the session and increment `queue_projection_rebuilds_total`.
- **Redis unavailable:** the API serves position reads from Postgres with an equivalent SQL rank (slower, rate-limited to staff and displays), patients get WhatsApp updates only, and token issuance continues normally because it never depended on Redis (D6).

---

## 9. Module designs

Each module lives in `src/modules/<name>/` with `routes.ts`, `service.ts`, `repo.ts`, `schemas.ts`, `events.ts`, `jobs.ts` and `__tests__/`. Services are the only public surface.

### 9.1 Identity, authentication and authorisation (`auth`)

**Staff.** Login with email or phone plus password (argon2id; at least 19 MiB memory, 2 iterations, parallelism 1). TOTP MFA is mandatory for `doctor`, `facility_admin`, `state_admin`, `dpo` and `clinical_reviewer`. Five failed attempts lock the account for 15 minutes.

- Access token: JWT signed with EdDSA, 15-minute lifetime. Claims: `sub`, `sid` (session id), `mem` (array of `{f: facilityId | null, r: role, d: departmentId | null}`).
- Refresh token: 32 random bytes, stored only as a SHA-256 hash in `refresh_tokens`, rotated on every use, 12-hour idle and 7-day absolute lifetime. Presenting an already-rotated token revokes the whole `family_id` (stolen-token detection).
- Revocation: deactivating a user writes `revoked:<userId>` to Redis for 15 minutes; the auth hook rejects tokens issued before that time.

**Patients.** No passwords. One-time codes are sent via a WhatsApp authentication template (SMS fallback): 6 digits, 5-minute TTL, 5 attempts, stored as an HMAC in Redis, at most 3 requests per phone per 10 minutes. A patient session is bound to a `contact_point_id` (it covers the whole household) and lasts 24 hours.

**Token status links** (`/t/<publicRef>`) work without login. `publicRef` is a random 10-character base32 string mapped in Redis (`tokref:`), valid for 36 hours. 🔒 The status page shows only the token code, department, room, position and ETA range: no name and no clinical data.

**Devices** (TV displays, kiosks, counter terminals) authenticate with a per-device API key (only its hash is stored) and are restricted to their facility and listed departments. 🔒 Displays never receive names, only token codes and rooms.

**Authorisation** has three layers, all mandatory:

1. **RBAC** in `src/shared/rbac.ts`: a static map from role to permission codes. Each route declares one permission.

   | Permission | Roles |
   |---|---|
   | `queue.operate` (call next, recall, skip, start, complete) | doctor, nurse |
   | `queue.checkin` | registration_clerk, nurse, help_desk, kiosk device |
   | `patient.demographics.read` / `.write` | registration_clerk, help_desk, nurse, doctor |
   | `patient.clinical.read` | doctor, nurse (subject to rule 3) |
   | `encounter.clinical.write` (diagnosis, prescription, vitals) | doctor (vitals: nurse) |
   | `triage.override` | doctor, nurse |
   | `kb.manage`, `facility.configure` | facility_admin |
   | `rules.author` / `rules.approve` | clinical_reviewer (approve: a different user than the author) |
   | `templates.review` | clinical_reviewer |
   | `audit.read` | dpo, auditor |
   | `state.analytics` | state_admin |

2. **Facility scope**: every request transaction sets `app.facility_ids` from the caller's active memberships, so RLS (§6.4, migration 0011) filters every query.
3. 🔒 **Care relationship** (`src/shared/access.ts → assertClinicalAccess(staff, patientId, purpose)`): a clinician may read a patient's clinical history only if the patient has an encounter today in the clinician's queue, or had one at the clinician's facility in the last 30 days. Anything else requires **break-glass**: the clinician enters a reason, access is granted for 4 hours, an `audit_events` row with `purpose = 'breakglass'` is written, and the DPO dashboard flags it for review.

### 9.2 Patients, households and consent (`patients`)

- **Normalisation before hashing.** Phone: E.164 (`+91XXXXXXXXXX`). ABHA number: 14 digits, no separators. Blind index = `HMAC-SHA256(K_blind, "<kind>:" + normalised)`, using a different key from the encryption keys (§13.2).
- **Household flow.** A phone lookup (Q1) returns every patient linked to that contact point. WhatsApp shows them as a list ("Who is this visit for? 1. Ramesh 2. Sunita 3. Someone else"). "Someone else" creates a new patient linked with a relationship.
- **ASHA workers** are contact points with relationship `asha_worker`. They can start intakes for many patients; every encounter records which contact point started it.
- **Duplicate prevention.** Creating a patient at a counter first runs Q1 and Q3 and shows possible matches. Merging is a staff action (`merged_into_id`), audited, never automatic.
- **Age.** Many patients know only an approximate age. Store `birth_year` with `birth_date_is_estimated = true`; derive age bands from it.
- **Consent.** The intake asks for `care_coordination` (needed to book) and `ai_assisted_intake` (needed for AI steps) using the versioned notice template `consent.notice` in the patient's language. Refusing AI consent switches the intake to structured mode; refusing care coordination ends the remote flow and directs the patient to the registration counter. Withdrawal takes effect immediately: a new row with `granted = false`. The current state is the latest row per `(contact_point_id, patient_id, purpose)`.
- **Clinical summary rebuild.** A worker rebuilds `patient_clinical_summaries` on `encounter.completed`, `allergy.changed`, `condition.changed` and `prescription.recorded`, increments `source_version`, and the cache key changes with it.
- **ABHA (phase 3).** ABHA creation/verification and record linking follow ABDM's published APIs. The schema already stores ABHA identifiers and `hfr_id` / `hpr_id`.

### 9.3 Intake engine (`intake`)

One state machine serves every channel. A channel adapter converts raw input into an `InboundEvent` and renders `OutboundMessage`s (text from a template, up to 3 buttons, a list of up to 10 rows, a location request, a link). The engine never knows which channel it is talking to.

**States**

| State | Asks / does | Next |
|---|---|---|
| `language` | Detect script (Gujarati / Devanagari / Latin) of the first message; ask if unclear | `facility` |
| `facility` | From the QR deep link (`wa.me/<number>?text=<FACILITY_CODE>`), previous visit, or "share location" → nearest active facilities in the district | `consent` |
| `consent` | If no current consent: notice + YES / NO buttons | `who_for` |
| `who_for` | Household list from Q1 or "someone else" → name, sex, age | `purpose` |
| `purpose` | New problem · Follow-up visit · Collect a report · Question about the hospital · Emergency now | `complaint`, `kb_answer`, or `outcome_emergency` |
| `complaint` | Free text or voice note. 🔒 Runs the **emergency pre-screen** before anything else | `extract` or `outcome_emergency` |
| `extract` | Q9 candidates → LLM picks codes from candidates only; fallback: body-system menu → symptom list | `clarify` |
| `clarify` | Up to 5 vetted questions (see below) | `risk` |
| `risk` | Pregnancy (female, 12–50), known chronic conditions (pre-filled from the summary, confirm), disability (for the protected lane) | `triage` |
| `triage` | Rules engine (§9.4) + routing | an `outcome_*` state |
| `outcome_emergency` | "Go to Casualty now / call 108." Creates an `emergency_prealerts` row for the facility | `idle` |
| `outcome_opd` | Department, room, reporting window, ETA range, QR check-in code | `idle` |
| `outcome_self_care` | Vetted leaflet + warning signs + **"Book a visit anyway"** button | `idle` or `outcome_opd` |
| `kb_answer` | Knowledge bot (§9.7) | `purpose` |

Rules that apply to every state:

- 🔒 **Emergency pre-screen**: the normalised complaint is matched against the published rule set's `emergency_phrases` (multilingual, clinician-maintained) *before* any LLM call. A hit goes straight to `outcome_emergency`. The pre-screen is also re-run on every free-text answer.
- 🔒 **Self-harm or suicide mentions** go to a dedicated response: crisis helplines (Tele-MANAS 14416, emergency 112), a prompt to go to the hospital's casualty, and a staff alert. The normal intake does not continue.
- **Idempotency**: each step is keyed by the inbound message id; reprocessing a message is a no-op.
- **Timeouts**: one reminder after 10 minutes idle; the session is marked `abandoned` after 2 hours.
- **Voice notes**: the worker stores the audio in object storage and sends it to the ASR provider. Low-confidence transcripts (below 0.6) are confirmed with the patient ("Did you say: ...?") or replaced by the symptom menu.
- **Structured fallback mode** (no AI consent, LLM down, circuit open, or budget exceeded): the same states, but `extract` uses menus and `clarify` asks questions in deterministic priority order. `intake_sessions.mode` records which mode ran.

**LLM extraction contract** (validated with Zod; invalid output → one retry → fallback):

```json
{
  "symptoms": [
    { "code": "SYM_ABD_BURN", "mention": "pet mein jalan", "duration_hours": 72,
      "severity": "moderate", "body_site": "upper abdomen" }
  ],
  "unmatched_mentions": ["..."],
  "possible_emergency": false
}
```

`code` MUST be one of the Q9 candidates sent in the prompt. Unmatched mentions trigger the symptom menu. If `possible_emergency` is true, the engine immediately re-runs the rules on what it has and asks the red-flag questions first: the LLM can make the intake *more* cautious, never less.

**Question selection.** Candidates are the active `intake_questions` that (a) apply to an extracted symptom or are general, (b) have not been asked, and (c) set a fact that the rules engine reports as missing (`missingFacts`, §9.4). In AI mode the LLM returns one code from the candidate list; in structured mode the lowest `priority` wins. Stop when the rules engine reports no missing facts, when an `emergency` level is reached, or after 5 questions.

### 9.4 Triage rules engine (`triage`)

A pure TypeScript function with no I/O: `evaluate(ruleSet, facts) → { level, firedRules, missingFacts, specialty, selfCareEligible }`. It is unit-tested exhaustively, and every published rule set carries its own test cases.

**Facts** (all optional except age and sex):

```ts
type Facts = {
  age_years: number; sex: 'female' | 'male' | 'other' | 'unknown';
  symptoms: string[];                  // symptom codes
  duration_hours?: number;             // of the main complaint
  fever_days?: number; pain_score?: number;            // 0-10
  breathless_at_rest?: boolean; chest_pain?: boolean; unconscious_or_confused?: boolean;
  seizure_now?: boolean; heavy_bleeding?: boolean; pregnant?: boolean; pregnancy_weeks?: number;
  injury_mechanism?: 'fall' | 'road_traffic' | 'assault' | 'burn' | 'bite' | 'other';
  chronic: string[];                   // 'diabetes', 'hypertension', 'ckd', 'copd', ...
  disability?: boolean;
};
```

**Rules DSL** (stored in `triage_rule_sets.rules`). The content below is an *illustrative example of the format only*. 🔒 Real rules MUST be authored and approved by clinicians.

```json
{
  "emergency_phrases": {
    "en": ["chest pain", "can't breathe", "unconscious", "fits"],
    "hi": ["सीने में दर्द", "सांस नहीं", "बेहोश"],
    "hi-Latn": ["seene mein dard", "saans nahi", "behosh"]
  },
  "rules": [
    { "id": "EM-CHEST-PAIN-30", "level": "emergency",
      "when": { "all": [ { "fact": "symptoms", "op": "contains", "value": "SYM_CHEST_PAIN" },
                         { "fact": "age_years", "op": ">=", "value": 30 } ] } },
    { "id": "EM-BREATHLESS-REST", "level": "emergency",
      "when": { "fact": "breathless_at_rest", "op": "==", "value": true } },
    { "id": "PR-FEVER-5D", "level": "priority",
      "when": { "fact": "fever_days", "op": ">=", "value": 5 } },
    { "id": "PR-INFANT-FEVER", "level": "priority",
      "when": { "all": [ { "fact": "age_years", "op": "<", "value": 1 },
                         { "fact": "symptoms", "op": "contains", "value": "SYM_FEVER" } ] } }
  ],
  "self_care": {
    "allowed_symptoms": ["SYM_COMMON_COLD", "SYM_MILD_HEADACHE", "SYM_MINOR_SCRAPE"],
    "max_duration_hours": 72,
    "exclude_if_any": [
      { "fact": "age_years", "op": "<", "value": 5 },
      { "fact": "age_years", "op": ">=", "value": 60 },
      { "fact": "pregnant", "op": "==", "value": true },
      { "fact": "chronic", "op": "not_empty" }
    ],
    "required_facts": ["duration_hours", "pain_score"]
  },
  "routing": [
    { "when": { "fact": "pregnant", "op": "==", "value": true }, "specialty": "obgyn" },
    { "when": { "fact": "age_years", "op": "<", "value": 14 }, "specialty": "paediatrics" }
  ],
  "default_level": "routine"
}
```

Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `contains_any`, `in`, `exists`, `not_empty`; combinators `all`, `any`, `not`.

**Evaluation**

1. `level` = the most urgent level among fired rules.
2. If no rule fired: `self_care` only if *every* self-care condition holds and all `required_facts` are known; otherwise `default_level`.
3. 🔒 **Unknown facts never make the outcome less urgent.** A comparison with a missing fact is false, and its fact is added to `missingFacts` when the rule's other conditions are satisfiable by the known symptoms. Self-care requires its facts to be *known*.
4. `specialty`: the first matching routing rule; otherwise the LLM's choice (§9.3) if its confidence is ≥ 0.6; otherwise the primary symptom's `default_specialty_code`; otherwise `general_medicine`. The department is the facility's active department with that `specialty_code` (fallback: General Medicine). `routing_method` records which path was used.

**Combining with the LLM.** `final_level = min(rule_level, llm_level)` in enum order, i.e. the more urgent of the two. The database CHECK constraint rejects any write where `final_level` is less urgent than `rule_level` without a staff override and reason.

**Publishing a rule set.** Draft → automated test run (all `test_cases` must pass, in CI and again in the publish API) → approval by a `clinical_reviewer` other than the author (four-eyes, enforced in the database) → one transaction that retires the current set and publishes the new one → `INCR rulesver` and a `rules:published` pub/sub message so every process reloads its in-memory copy. Every `triage_assessments` row stores the `rule_set_id` and the exact `facts` it evaluated, so any decision can be replayed later.

Test case format:

```json
[
  { "name": "55y chest pain is emergency",
    "facts": { "age_years": 55, "sex": "male", "symptoms": ["SYM_CHEST_PAIN"], "chronic": [] },
    "expect": { "level": "emergency" } },
  { "name": "cold in a pregnant woman is never self-care",
    "facts": { "age_years": 26, "sex": "female", "symptoms": ["SYM_COMMON_COLD"], "pregnant": true,
               "duration_hours": 24, "pain_score": 1, "chronic": [] },
    "expect": { "level": "routine", "specialty": "obgyn" } }
]
```

### 9.5 Smart OPD queue (`queue`)

#### 9.5.1 Concepts

- **Queue session**: one department, one date, one shift. Created nightly for the next day from `doctor_schedules` (job `queue-sessions-create`). Opened by the first check-in or by staff.
- **Lanes** inside a session: `0` urgent (triage `priority`), `1` protected (age 60+, pregnant, disability — common policy in government hospitals), `2` general. Lane 0 is always served first; lanes 1 and 2 share calls in `lane_ratio` (default 1 : 2) with aging (§9.5.4).
- **Remote booking vs token.** A remote booking gives a *reporting window* (30-minute slot) and an ETA range, not a token number. The token number is allocated at **physical check-in** (QR scan at the gate kiosk, or the counter). This prevents people from booking from home and blocking the queue. On-time arrivals are rewarded: `queue_entry_at = window_start` if the patient checks in within the window, otherwise the check-in time.
- 🔒 Triage `emergency` never enters an OPD queue: the patient is sent to casualty with a pre-alert.

#### 9.5.2 Token lifecycle

```mermaid
stateDiagram-v2
  [*] --> waiting: check-in (token number allocated)
  waiting --> called: call next / recall
  called --> in_consult: doctor starts consult
  called --> skipped: not present after 3 calls
  skipped --> waiting: patient returns (re-queued with penalty)
  in_consult --> completed: consult ended
  waiting --> transferred: moved to another department (new token issued there)
  waiting --> cancelled: patient cancels, or session closed before they were seen
  skipped --> no_show: session closed and patient never returned
  completed --> [*]
```

Every transition: `UPDATE opd_tokens ... WHERE id = $1 AND version = $2` (optimistic lock), `INSERT queue_events`, `INSERT outbox_events`, all in one transaction; then `apply_token_state.lua` after commit.

#### 9.5.3 Check-in transaction

```
BEGIN;
  SELECT set_config('app.scope','facility',true), set_config('app.facility_ids',$facilities,true);
  Q4  → token_no, token_prefix                                  -- row lock on queue_sessions, ~1-2 ms
  INSERT INTO opd_tokens (... status 'waiting', lane, queue_entry_at ...)
  UPDATE encounters SET status = 'checked_in', checked_in_at = now(), version = version + 1
    WHERE id = $encounter AND version = $v;                     -- 0 rows → 409 conflict, rollback
  INSERT INTO queue_events (kind 'checked_in', token_version 0, ...);
  INSERT INTO outbox_events ('token.checked_in', payload {qsId, tokenId, version, lane, score, code, room});
COMMIT;
→ apply_token_state.lua; enqueue prebrief.generate (priority = people ahead); reply with token code + ETA range.
```

The check-in endpoint requires an `Idempotency-Key` header: a kiosk retrying after a timeout gets the same token back instead of a second one.

#### 9.5.4 Call next: lane selection

```
selectLane(meta, heads):
  if lane0 not empty: return 0
  oldest = the lane head (1 or 2) with the earliest queue_entry_at
  if now - oldest.queue_entry_at > facility.max_wait_minutes (default 120): return oldest.lane   -- aging guard
  protectedShareBehind = served_protected * ratio_general <= served_general * ratio_protected
  if protectedShareBehind and lane1 not empty: return 1
  if lane2 not empty: return 2
  return lane1 not empty ? 1 : none
```

Then run Q5 with that lane. If it returns no row (another doctor took the last one), try the next lane. On success, `HINCRBY served_<lane>`, project the token, publish `token.called`, and return the encounter with its cached pre-brief.

#### 9.5.5 Recall, skip, re-queue

- A called patient who doesn't arrive within 5 minutes can be recalled (max 3 calls in total), after which the doctor marks them `skipped`.
- A skipped patient who comes back is re-queued in the same lane with `queue_entry_at = original + 15 minutes` (configurable penalty), so they neither lose their place entirely nor jump the queue.

#### 9.5.6 ETA inputs

- `ewma_consult_sec`: exponentially weighted moving average (α = 0.2) of `consult_ended_at − consult_started_at`, clamped to [30 s, 30 min] to ignore outliers. Seeded at session open from the median of the last 4 same-weekday sessions (`facility_daily_stats.consult_p50_seconds`), else `departments.default_consult_seconds`.
- `active_servers`: doctors with `doc:<id>:status = in_opd` for this session (heartbeat-based). If it drops to 0 (all doctors on rounds), ETAs are shown as "doctor currently unavailable" instead of a misleading number, and waiting patients get one WhatsApp message explaining the delay.

#### 9.5.7 Patient alerts

After every `token.called` event for a session, the worker reads the first 12 members of each lane, computes `ahead` with `token_position.lua`, and sends threshold alerts at **10 ahead**, **3 ahead** and **"your turn — Room 7"**. Each alert has a dedupe key `eta:<tokenId>:<threshold>` (Redis `SET NX` + the `notifications.dedupe_key` column), so it is sent exactly once even with retries.

#### 9.5.8 Offline tokens (D17)

1. While online, a kiosk or counter terminal requests a block: `POST /v1/devices/me/token-blocks` → the server bumps `last_token_no` by the block size (default 20) under the Q4 lock and records the range in `token_blocks`.
2. Offline, the device issues numbers from its block, stamping each with a client-generated UUIDv7 and local time.
3. On reconnect, `POST /v1/devices/me/offline-tokens` uploads them (idempotent by the client UUID). Numbers cannot conflict because the range was reserved. If the device clock differs from server time by more than 5 minutes, the server uses its receive time for ordering.
4. Unused numbers in a released block are simply skipped. Displays tolerate gaps.

#### 9.5.9 Session lifecycle

`scheduled → open → (paused ↔ open) → closed`. Pausing (doctor called to an emergency) freezes ETAs and notifies waiting patients once. At close:

- Tokens still `waiting` → token `cancelled` (event payload `reason: session_closed`), encounter `left_without_being_seen`, and the patient is offered a priority slot in the next session via WhatsApp.
- Tokens still `skipped` (called, never came back) → token `no_show`, encounter `no_show`.
- Both counts feed `facility_daily_stats`, because unserved patients are exactly what the hospital needs to see.

### 9.6 Doctor pre-brief (`prebrief`)

**Goal:** a summary the doctor can read in under 10 seconds, ready before the token is called. 🔒 It assists a registered medical practitioner; it is never shown to the patient.

**Trigger:** the `token.checked_in` event enqueues `prebrief.generate` with BullMQ priority = people ahead (patients about to be called are generated first). It is regenerated if vitals or allergies are recorded before the call.

**Context assembly** (3 queries, no vector search — D9): the `patient_clinical_summaries` row, Q6 (recent visits), and today's `triage_assessments` + `observations`.

**Output shape** (`prebriefs.content`):

```json
{
  "deterministic": {
    "patient": { "age_band": "45-49", "sex": "male" },
    "today": { "complaint_codes": ["SYM_ABD_BURN"], "duration_hours": 72, "triage_level": "routine",
               "red_flags": [], "vitals": [{ "code": "bp_systolic", "value": 148, "unit": "mmHg" }] },
    "allergies": [{ "substance": "Penicillin", "reaction": "rash", "severity": "moderate" }],
    "active_medications": [{ "drug": "Metformin 500 mg", "dose": "1 tab", "frequency": "BD" }],
    "chronic_conditions": ["Type 2 diabetes mellitus"],
    "risk_flags": ["diabetes"]
  },
  "narrative": {
    "headline": "45-49M, 3 days of upper abdominal burning; known diabetic on metformin; BP 148 today.",
    "key_points": [
      { "text": "Same complaint 5 months ago, treated at CHC Sanand.", "source_refs": ["enc:01a0..."] },
      { "text": "Metformin can cause GI upset; check timing with meals.", "source_refs": ["rx:01a0..."] }
    ],
    "questions_to_consider": ["Any black stools or vomiting blood?"]
  },
  "generated_by": { "model": "...", "prompt_version": "prebrief.v3", "ai": true }
}
```

Rules:

1. 🔒 **The deterministic block is rendered by code from SQL rows**, never by the LLM. Allergies and medicines are shown verbatim from the database.
2. The narrative is produced by the stronger model (§10) from a **de-identified** context: no name, phone, ABHA number or address; age as a 5-year band; dates as relative ("5 months ago"); other facilities as their type and district.
3. **Validation before storing**: every `source_refs` entry must exist in the context; any drug or allergen name in the narrative must appear in the context (dictionary match), otherwise the point is dropped; the narrative is capped at 1 headline + 5 points + 3 questions.
4. **Fallback**: if the LLM fails, times out, or the circuit is open, the pre-brief is stored with `status = 'fallback'` (deterministic block only). The doctor always gets something.
5. **Delivery**: the row is stored in `prebriefs`, the encrypted JSON is cached at `prebrief:<encounterId>`, and `prebrief.ready` is pushed to the doctor's room. Q5's response includes it; viewing writes `viewed_at` and an audit event.
6. **Feedback**: thumbs up/down with an optional note. A weekly report of down-votes goes to the clinical reviewers, together with the prompt version.

### 9.7 Hospital knowledge bot (`kb`)

**Ingestion** (job `kb-ingest`, one document at a time per facility):

1. Admin uploads a file → stored in object storage → `kb_documents` row (`draft`). An identical file (same SHA-256 for the same facility) is a no-op.
2. Extract text: PDF (`unpdf`), DOCX (`mammoth`), HTML (readability). Scanned PDFs need OCR with Hindi/Gujarati/English language packs (phase 2); until then they fail with a clear `error`.
3. Normalise: Unicode NFC, collapse whitespace, drop headers/footers repeated on every page.
4. Chunk by structure: split on headings, target ~350 tokens (max 500), ~15% overlap between neighbouring chunks. Tables stay whole when they fit, otherwise split by row groups with the header row repeated.
5. Contextual header: embed `"<document title> > <heading path>\n<chunk text>"`, so a chunk like "8 AM to 1 PM" still carries "Medicine OPD timings" in its vector. The path is stored in `heading_path`; `content` stays clean.
6. Detect language per chunk; embed in batches of 64; insert chunks with `is_active = false`.
7. Publish in one transaction: old version's chunks `is_active = false` and document `archived`; new chunks `is_active = true` and document `active`. Then `INCR kbver:<facilityId>` (or `kbver:state`) so cached answers for the old version are never served again.

**Self-care leaflets** (`doc_type = 'self_care_leaflet'`) are whole, clinically reviewed documents (enforced by the `leaflets_reviewed` constraint), selected by `symptom_codes` overlap in `outcome_self_care`. They are sent as written, never summarised by the LLM.

**Answering** (`POST /v1/kb/ask`, and the WhatsApp `kb_answer` state):

1. Normalise the question; check the answer cache (`kb:ans:...`).
2. Embed the question (normalised-question embeddings are cached in Redis for 24 h).
3. **Curated FAQ fast path** (Q8): best similarity ≥ threshold → return the vetted answer in the patient's language. No LLM call.
4. **Hybrid retrieval** (Q7, k = 6).
5. **Confidence gate**: if the best cosine similarity is below the calibrated floor (start at 0.35) *and* there is no full-text hit, answer with the `kb.not_found` template plus the help-desk number. No LLM call, no guessing.
6. **Grounded answer** (fast model): the prompt contains only the retrieved chunks, each with an id. Output schema: `{ answer, cited_chunk_ids[], is_medical_question }`.
7. **Validate**: every cited id must be one that was provided; an answer with no citations is replaced by `kb.not_found`. 🔒 If `is_medical_question` is true ("what medicine for fever?"), the answer is replaced by the `kb.medical_redirect` template, which offers to start an intake.
8. Cache the answer for 6 h under the current `kbver`; log the LLM call.

**Retrieval quality is measured** (D10): each facility keeps at least 30 evaluation questions per language in `kb_eval_cases`, including paraphrases, Hinglish and typos. The nightly `kb-eval` job computes recall@5 and MRR for steps 3–4 and stores them in `kb_eval_runs`. Alert when recall@5 < 0.90 or drops by more than 5 points from the previous run. A change of embedding model is only allowed after it beats the current model on this set.

**Changing the embedding model**: build `kb_chunks_next` (same shape, new vectors) in the background, run the eval on it, switch reads with a config flag, then drop the old table. Never mix vectors from two models in one index; `embedding_model` exists to catch that.

### 9.8 Patient documents (phase 2, `patientdocs`)

- During intake, the patient can send photos or PDFs of old prescriptions and reports. Files go straight to object storage (server-side encryption); a `patient_documents` row is created; job `patient-doc-extract` produces text, chunks it and embeds it into `patient_doc_chunks`.
- Doctors can ask questions over one patient's documents (`POST /v1/patients/{id}/ask`, care relationship required). Retrieval is Q10: exact search over that patient's chunks only.
- 🔒 Content from uploaded documents is always labelled **"patient-provided, unverified"** in the pre-brief and the Q&A answer. It never updates allergies, conditions or medications automatically; a clinician must confirm and record them.

### 9.9 WhatsApp channel (`whatsapp`)

**Webhook** (`webhook` process):

1. `GET /v1/webhooks/whatsapp`: respond to Meta's verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`).
2. `POST`: keep the raw body; verify `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(app secret, raw body) with a constant-time comparison. Mismatch → 401 and a metric.
3. For each message: `SET dedupe:wa:<id> 1 NX EX 691200`. Already set → skip. Otherwise enqueue `wa-inbound` with `jobId = <message id>` (BullMQ also dedupes on job id). 🔒 The job data is encrypted (AES-256-GCM) because it contains the sender's phone number and message text.
4. Status callbacks (`sent`, `delivered`, `read`, `failed`) → `wa-status` jobs → Q13.
5. Respond 200. Target p99 < 100 ms; nothing slow happens in this process.

**Inbound processing** (`worker`):

- Find or create the conversation by `HMAC(wa_id)` (`INSERT ... ON CONFLICT DO NOTHING`, then select).
- Take `lock:conv:<conversationId>` (`SET NX PX 30000` with a random owner token; release with a compare-and-delete Lua script). If it is held, `job.moveToDelayed(now + 300 ms)` and throw BullMQ's `DelayedError`: messages from one person are processed one at a time, in order, without a global lock.
- A message whose timestamp is older than the last processed one is stored but only drives the state machine if it answers the currently open question.
- Media (voice, images, documents): stream from the Graph API media URL to object storage, max 16 MB. No local disk.

**Outbound** (`wa-outbound` queue):

- BullMQ rate limiter per sending phone number, configured to the account's throughput tier.
- Inside the 24-hour customer-service window (`now − last_inbound_at < 24 h`): free-form session messages (text, buttons, lists). Outside it: only Meta-approved templates (`message_templates.provider_template_name`). Templates are approved per language; a sync job refreshes `provider_status`.
- Interactive limits: at most 3 reply buttons (titles ≤ 20 characters), lists of at most 10 rows. Question options are designed within these limits (§6.4, `intake_questions.options`).
- Retries: HTTP 429 / 5xx → exponential backoff with jitter (8 attempts, base 2 s). Permanent 4xx such as "recipient not on WhatsApp" → set `contact_points.whatsapp_capable = false`; critical messages ("your turn", emergency instructions) fall back to SMS using DLT-registered templates (required for commercial SMS in India).
- 🔒 No marketing messages, ever.

### 9.10 Follow-ups and notifications (`followups`, `notifications`)

- When the doctor completes an encounter, they tick which follow-ups to schedule: `symptom_checkin` (default +72 h), `medication_reminder` (patient opt-in, daily at chosen times until the prescription's duration ends), `revisit_due`. `report_ready` is triggered by staff now, and by lab integration in phase 3.
- Each follow-up is a BullMQ delayed job (`jobId` = follow-up id) **and** a row in `followups`; Q12 sweeps every 5 minutes as a safety net for jobs lost in a Redis failover.
- **Symptom check-in**: "How are you feeling now? Better / Same / Worse". Better → close. Same → offer a revisit booking. Worse → re-run the emergency pre-screen and the red-flag questions; a red flag → emergency outcome; otherwise a `priority`-lane booking, linked through `escalation_encounter_id`.
- **One notification API**: `notify(contactPointId, templateCode, vars, { dedupeKey, critical })`. It checks `whatsapp_notifications` consent for non-critical messages, applies quiet hours (21:00–07:00 IST) to non-urgent ones, picks the channel, writes a `notifications` row and enqueues the send. Critical messages (your turn, emergency, appointment changes) ignore quiet hours.

### 9.11 Analytics (`analytics`)

The `stats-rollup` job runs every 15 minutes for today (`is_final = false`) and at 01:00 IST for yesterday (`is_final = true`), well before the 14-day `opd_tokens` retention removes the source rows. Dashboards read only rollups, from a replica.

Wait-time statistics per department and day:

```sql
-- query: Q16  $1 date = stat date (IST), $2 boolean = is_final
INSERT INTO facility_daily_stats AS s
  (facility_id, department_id, stat_date, checked_in, seen, no_shows,
   wait_p50_seconds, wait_p90_seconds, consult_p50_seconds, computed_at, is_final)
SELECT qs.facility_id, qs.department_id, qs.session_date,
       count(*),
       count(*) FILTER (WHERE t.status = 'completed'),
       count(*) FILTER (WHERE t.status = 'no_show'),
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.called_at - t.queue_entry_at))::int,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM t.called_at - t.queue_entry_at))::int,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.consult_ended_at - t.consult_started_at))::int,
       now(), $2
FROM opd_tokens t
JOIN queue_sessions qs ON qs.id = t.queue_session_id
WHERE t.session_date = $1
GROUP BY qs.facility_id, qs.department_id, qs.session_date
ON CONFLICT (facility_id, department_id, stat_date) DO UPDATE
SET checked_in = EXCLUDED.checked_in,
    seen = EXCLUDED.seen,
    no_shows = EXCLUDED.no_shows,
    wait_p50_seconds = EXCLUDED.wait_p50_seconds,
    wait_p90_seconds = EXCLUDED.wait_p90_seconds,
    consult_p50_seconds = EXCLUDED.consult_p50_seconds,
    computed_at = now(),
    is_final = EXCLUDED.is_final
WHERE NOT s.is_final;
```

A second statement in the same job fills `registrations`, `left_without_being_seen` and the triage-mix columns from `encounters` and `triage_assessments` (filtered by `facility_id, session_date`, which `encounters_facility_day_idx` serves), plus `ai_fallback_count` from `intake_sessions.mode` and `triage_overrides` from `triage_assessments.overridden_by`. `facility_hourly_arrivals` is filled from `opd_tokens.queue_entry_at` and feeds reporting-window capacity: the expected arrivals for a slot are the average of the same weekday and hour over the last 4 weeks.

### 9.12 Audit and compliance (`audit`)

- **What is audited**: every read of clinical data (`patient.clinical.read`, `prebrief.view`, `patient.history.read`, `patientdocs.read`), every patient search (with the number of results, not the query text), every clinical write, triage overrides, break-glass, consent changes, rule-set publication, template approval, staff role changes, logins and failed logins, data exports.
- 🔒 **Audit is written before the response is sent** (a Fastify `onSend` hook inserts the request's audit rows in one multi-row insert). If the insert fails, the request fails with 500: no unaudited reads of patient data.
- **Tamper evidence**: the hourly `audit-digest` job hashes the hour's rows in id order, chains the hash with the previous hour's digest into `audit_digests`, and exports the hour as JSONL.gz to write-once (object-lock) storage. Retention follows `partition_registry` (24 months default; at least the 180 days CERT-In requires, kept in India).
- **DPO tooling**: Q14 ("who accessed my record") for patients and investigations, the break-glass review queue, the consent ledger per contact point, and data-principal requests (access, correction, erasure). 🔒 Erasure requests anonymise non-clinical data (contact points, conversations, messages) but do not delete clinical records that the hospital is legally required to keep; each decision is recorded.
- **Incidents**: the runbook (§14.7) covers reporting to CERT-In (within 6 hours under its 2022 directions) and notifying the Data Protection Board and affected people under the DPDP Rules, 2025, whose main obligations apply from May 2027. Exact obligations MUST be confirmed with the hospital's legal team (§20).

---

## 10. LLM gateway (`src/infra/llm`)

### 10.1 Interface

```ts
type LlmResult<T> = { ok: true; data: T; callId: string } | { ok: false; reason: LlmOutcome; callId: string };

llm.call<T>({
  purpose: LlmPurpose,              // 'intake_extract' | 'question_select' | ...
  prompt: PromptRef,                // { id: 'intake.extract', version: 4 }
  input: DeidentifiedInput,         // branded type: only `deidentify()` can produce it (🔒)
  schema: ZodType<T>,               // output contract
  facilityId?: string, encounterId?: string,
}): Promise<LlmResult<T>>;          // never throws for provider failures; callers MUST handle { ok: false }
```

Structured output uses tool use with a single tool whose input schema is generated from the Zod schema, with `tool_choice` forced to that tool. The tool input is validated with Zod; one retry on invalid output, then `{ ok: false, reason: 'invalid_output' }`.

### 10.2 Routing table

| Purpose | Model tier | Timeout | Max output tokens | Retries | Fallback when `ok: false` |
|---|---|---|---|---|---|
| `intake_extract` | fast | 4 s | 400 | 1 | Symptom menu |
| `question_select` | fast | 2.5 s | 50 | 0 | Deterministic priority order |
| `department_route` | fast | 2.5 s | 100 | 0 | Catalog default specialty → General Medicine |
| `kb_answer` | fast | 6 s | 500 | 1 | `kb.not_found` + help desk |
| `prebrief` | smart | 15 s | 700 | 1 | Deterministic-only pre-brief |
| `patient_doc_extract` | smart (vision) | 30 s | 1,500 | 2 | Marked `failed`; shown as an attachment only |
| `doctor_qa` | smart | 10 s | 500 | 1 | "Could not answer; open the documents" |

Model ids are configuration (`LLM_MODEL_FAST`, `LLM_MODEL_SMART`), not code, e.g. `claude-haiku-4-5-20251001` for fast and `claude-sonnet-5-5` for smart. Confirm current model ids in the provider documentation when building.

### 10.3 Prompts

- Prompts live in code: `src/modules/<module>/prompts/<name>.v<N>.ts`, exporting the system prompt, the input builder and the output schema. `llm_calls.prompt_version` records `<name>.v<N>`.
- A prompt change is a new version file, a PR, and an eval run (§10.7) attached to the PR. Old versions stay until no longer referenced.
- Static parts (system prompt, symptom candidate format, specialty list) are placed first so the provider's prompt caching can reuse them across calls.

### 10.4 🔒 Data minimisation and residency

- `deidentify()` is the only way to build an LLM input. It removes names (including the household's known names), phone numbers (Indian mobile patterns), 12- and 14-digit identifiers (Aadhaar/ABHA-like), emails, addresses and PIN codes from free text; converts ages to 5-year bands and dates to relative phrases; and replaces other facility names with type + district.
- Patient free text is sent only for `intake_extract` (redacted) and nowhere else. Pre-brief context is structured data, de-identified.
- Whether any data may be processed by an LLM endpoint outside India, even de-identified, is an **open decision** (§20). The gateway supports per-purpose provider configuration so that, for example, pre-briefs can be routed to an in-country endpoint while FAQ answers (no patient data at all) use any endpoint.

### 10.5 Prompt-injection defence

Patient text is passed as a clearly delimited data field, never concatenated into instructions. Outputs are constrained to schemas and enumerated codes; the model has no tools that act on anything, no URL fetching, and its output is never executed or rendered as HTML. Anything outside the allowed codes is discarded by validation.

### 10.6 Reliability and cost

- **Circuit breaker** per provider and model (state shared in Redis `cb:<provider>`): opens at ≥ 50% failures over the last 20 calls within 30 s; half-opens after 30 s.
- **Concurrency limits** per purpose, so a pre-brief backlog cannot starve interactive intake calls.
- **Budgets**: daily token budget per facility (`llm:budget:<facility>:<date>`); when exhausted, purposes switch to their fallbacks and an alert fires.
- Every call writes an `llm_calls` row (purpose, model, prompt version, tokens, latency, outcome) and Prometheus metrics. Full prompts are not stored.

### 10.7 Evaluation

Each purpose has an offline eval set in the repo (`evals/<purpose>/*.jsonl`), run in CI whenever a prompt or model changes:

| Purpose | Eval set (minimum) | Pass criteria |
|---|---|---|
| `intake_extract` | 300 labelled complaints across English, Hindi, Gujarati, Hinglish, with typos and voice-transcript noise | symptom-code F1 ≥ 0.90; 🔒 **zero** emergency cases where a red-flag symptom is missed |
| `department_route` | 200 labelled cases | top-1 accuracy ≥ 0.85 |
| `kb_answer` | the `kb_eval_cases` questions with expected answers | ≥ 0.95 answers grounded (citations valid); 0 medical-advice answers |
| `prebrief` | 50 synthetic patient contexts, scored by clinicians with a rubric | no fabricated allergy/medicine; ≥ 4/5 usefulness median |

---

## 11. API specification

### 11.1 Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1`, JSON, UTF-8. OpenAPI 3.1 served at `/api/v1/openapi.json`; the frontend generates its client from it. |
| Authentication | `Authorization: Bearer <jwt>` (staff, patient) or `X-Device-Key` (devices). |
| IDs | UUIDv7 strings everywhere. |
| Pagination | Keyset: `?limit=50&cursor=<uuid>` → `{ "items": [...], "next_cursor": "<uuid>" \| null }`, implemented as `WHERE id < $cursor ORDER BY id DESC`. No `OFFSET`. |
| Idempotency | `Idempotency-Key` header REQUIRED on POSTs that create encounters, check-ins, tokens, follow-ups, notifications and offline-token uploads. The response is stored 24 h; the same key with a different body → `422 idempotency_key_reused`. |
| Concurrency | Mutable resources return `ETag: "<version>"`; mutations require `If-Match` → `412 version_conflict` on mismatch. |
| Errors | RFC 9457 `application/problem+json`: `{ type, title, status, code, detail, request_id, errors? }`. `code` is from a stable catalogue (`queue_unavailable`, `version_conflict`, `consent_required`, `care_relationship_required`, `possible_duplicates`, `rate_limited`, `validation_failed`, ...). |
| Tracing | `X-Request-Id` accepted or generated, returned on every response; W3C trace context propagated. |
| Time | Timestamps ISO 8601 UTC; business dates `YYYY-MM-DD` in IST. |
| Language | `Accept-Language` selects patient-facing template language (`en`, `hi`, `gu`, ...). |

### 11.2 Endpoints

**Public and patient**

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /facilities/{code}/public` | none | Name, departments open today, timings, live wait board |
| `GET /facilities/nearby?lat=&lng=` | none | Up to 5 nearest active facilities |
| `POST /auth/patient/otp` · `POST /auth/patient/otp/verify` | none (rate-limited) | Patient sign-in |
| `GET /me/household` · `GET /me/encounters?cursor=` | patient | Linked patients; own household's visits (summaries) |
| `POST /intake/sessions` | patient, or kiosk device | Start a web/kiosk intake → first prompt |
| `POST /intake/sessions/{id}/answers` | same | Submit an answer → next prompt or outcome |
| `GET /intake/sessions/{id}` | same | Resume |
| `POST /bookings/{encounterId}/cancel` | patient | Cancel a booking |
| `GET /t/{publicRef}` | none | Token status: code, department, room, position, ETA range (no PHI) |
| `POST /kb/ask` | none (rate-limited) or patient | Hospital knowledge bot |
| `GET`, `POST /webhooks/whatsapp` | Meta signature | WhatsApp webhook (`webhook` process) |

**Staff**

| Method & path | Permission | Purpose |
|---|---|---|
| `POST /auth/staff/login` · `/auth/staff/mfa/verify` · `/auth/refresh` · `/auth/logout` | — | Staff session |
| `GET /me` | any staff | Profile and memberships |
| `GET /facilities/{id}/queues/today` | `queue.checkin` or `queue.operate` | Sessions with lane counts and ETAs |
| `POST /queues/{sessionId}/open` · `/pause` · `/close` | `queue.operate` | Session lifecycle |
| `POST /queues/{sessionId}/checkins` | `queue.checkin` | Check in a booked encounter or register a walk-in (Idempotency-Key) |
| `POST /queues/{sessionId}/call-next` | `queue.operate` | Lane selection + Q5 → token, encounter, pre-brief |
| `POST /tokens/{id}/recall` · `/skip` · `/start` · `/complete` · `/transfer` · `/requeue` | `queue.operate` | Token transitions (If-Match) |
| `PUT /doctors/me/status` | doctor | `in_opd`, `on_rounds`, `in_surgery`, `on_break`, `off` (also the heartbeat) |
| `GET /patients/search?phone=` · `?abha=` · `?name=&district=&birth_year=` | `patient.demographics.read` | Q1 / Q2 / Q3 |
| `POST /patients` | `patient.demographics.write` | Create; may return `409 possible_duplicates` with candidates |
| `GET /patients/{id}` | `patient.demographics.read` | Demographics |
| `GET /patients/{id}/clinical-summary` · `/encounters?cursor=` | `patient.clinical.read` + care relationship | Clinical history |
| `POST /patients/{id}/breakglass` | `patient.clinical.read` | Reason → 4-hour access grant, audited |
| `POST /patients/{id}/allergies` · `/conditions` | `encounter.clinical.write` | Clinical facts |
| `POST /patients/{id}/ask` | `patient.clinical.read` + care relationship | Q&A over uploaded documents (phase 2) |
| `POST /encounters` | `queue.checkin` | Counter registration (Idempotency-Key) |
| `GET /encounters/{id}` · `GET /encounters/{id}/prebrief` | `patient.clinical.read` | Encounter; pre-brief (audited) |
| `POST /encounters/{id}/prebrief/feedback` | doctor | Thumbs up/down |
| `PATCH /encounters/{id}/triage` | `triage.override` | Override with mandatory reason (If-Match) |
| `POST /encounters/{id}/observations` · `/diagnoses` · `/prescriptions` | `encounter.clinical.write` | Clinical data |
| `POST /encounters/{id}/complete` | doctor | Complete + choose follow-ups |
| `GET /facilities/{id}/emergency-prealerts` · `POST /emergency-prealerts/{id}/ack` | doctor, nurse | Casualty dashboard |

**Administration**

| Method & path | Permission | Purpose |
|---|---|---|
| CRUD `/facilities/{id}/departments` · `/service-points` · `/doctor-schedules` · `/staff` · `/devices` | `facility.configure` | Facility setup |
| `POST /kb/documents` (multipart) · `POST /kb/documents/{id}/publish` · `GET /kb/documents` · `POST /kb/documents/{id}/archive` | `kb.manage` | Knowledge base |
| CRUD `/faq` | `kb.manage` | Curated answers |
| `GET /triage/rule-sets` · `POST /triage/rule-sets` · `POST /triage/rule-sets/{id}/test` · `/approve` · `/publish` | `rules.author` / `rules.approve` | Rule governance |
| CRUD `/message-templates` · `POST /message-templates/{id}/review` | `templates.review` | Templates |
| `GET /analytics/facilities/{id}/daily?from=&to=` · `/hourly` · `GET /analytics/state/daily` | facility_admin / `state.analytics` | Dashboards |
| `GET /audit/patients/{id}/access-log` · `GET /audit/breakglass?status=pending` · `POST /audit/breakglass/{id}/review` | `audit.read` | DPO tools |

**Devices and operations**

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /devices/me` · `GET /displays/me/snapshot` | device | Device config; display snapshot |
| `POST /devices/me/token-blocks` · `POST /devices/me/offline-tokens` | kiosk / counter device | Offline mode (§9.5.8) |
| `GET /healthz` · `GET /readyz` · `GET /metrics` | none (internal network for `/metrics`) | Liveness; readiness (Postgres + redis-core); Prometheus |

### 11.3 Realtime (Socket.IO)

- Namespaces: `/staff` (JWT), `/display` (device key), `/patient` (`publicRef` or patient token).
- Rooms: `queue:<sessionId>`, `doctor:<userId>`, `display:<deviceId>`, `ed:<facilityId>`, `token:<tokenId>`. Joining a room is authorised server-side on `subscribe`.
- Server → client events: `queue.snapshot`, `queue.updated` (lane counts, consult average, active doctors), `token.called` (code, room, lane), `token.status` (status, people ahead, ETA range), `prebrief.ready`, `doctor.status`, `ed.prealert`.
- Connection-state recovery is enabled (2 minutes) so short network drops don't lose events; after a longer drop, clients ask for `queue.snapshot`.
- 🔒 Display and patient payloads never include names or clinical data.

---

## 12. Background jobs

### 12.1 BullMQ queues (on `redis-core`)

| Queue | Produced by | Concurrency / process | Attempts, backoff | Job id (dedupe) | Notes |
|---|---|---|---|---|---|
| `wa-inbound` | webhook | 32 | 5, exponential 1 s | WhatsApp message id | Per-conversation lock (§9.9) |
| `wa-status` | webhook | 32 | 3, exponential 1 s | `<message id>:<status>` | Q13 |
| `wa-outbound` | notifications, intake | 16 + rate limiter | 8, exponential 2 s + jitter | notification id | 24-hour window logic |
| `sms-outbound` | notifications | 8 | 5, exponential 5 s | notification id | DLT templates |
| `intake-step` | wa-inbound, web API | 32 | 2, fixed 500 ms | inbound message id | LLM calls inside; fallback on failure |
| `prebrief` | outbox `token.checked_in` | 8 | 2, exponential 2 s | `<encounterId>:<summary version>` | BullMQ priority = people ahead |
| `summary-rebuild` | outbox clinical events | 8 | 5, exponential 1 s | `<patientId>` with 5 s delay (debounce) | |
| `notify-thresholds` | outbox `token.called` | 8 | 3, fixed 1 s | `<sessionId>:<eventId>` | §9.5.7 |
| `followup-dispatch` | delayed jobs | 8 | 5, exponential 30 s | follow-up id | |
| `kb-ingest` | admin upload | 2 | 3, exponential 10 s | `<documentId>:<version>` | |
| `patient-doc-extract` | intake | 4 | 3, exponential 10 s | document id | Phase 2 |

The **outbox relay** is not a BullMQ queue: it is a loop in the `worker` process (two instances) running Q11 every 200 ms while there is work and every 1 s when idle, publishing each event to its consumers and setting `published_at`.

### 12.2 Scheduled jobs (`scheduler`, times in IST)

| Job | Schedule | Does |
|---|---|---|
| `partition-maintenance` | daily 02:10 | `SELECT ensure_partitions(1, 3)`; alert if any table has fewer than 2 future partitions |
| `retention` | daily 03:10 | Deletes `opd_tokens` > 14 days (after verifying their facts are on `encounters`), `intake_sessions` > 7 days, `emergency_prealerts` > 30 days, `inbound_dedupe` > 8 days, published outbox rows > 1 day, expired refresh tokens; archives and detaches expired partitions (§14.6) |
| `queue-sessions-create` | daily 20:00 | Next day's sessions from schedules and overrides |
| `queue-reconcile` | every 60 s, 07:00–20:00 | §8.4 |
| `stats-rollup` | every 15 min; final at 01:00 | §9.11 |
| `followup-sweep` | every 5 min | Q12 |
| `intake-expiry` | every 5 min | Marks sessions past `expires_at` as abandoned |
| `audit-digest` | hourly at :05 | §9.12 |
| `kb-eval` | daily 04:00 | §9.7 |
| `template-sync` | every 6 h | WhatsApp template approval statuses |

---

## 13. Security and compliance

### 13.1 Threats and controls

| Threat | Control |
|---|---|
| Forged WhatsApp webhooks | HMAC signature verification with constant-time compare; reject before parsing |
| Stolen staff credentials or tokens | MFA for clinical/admin roles, 15-minute access tokens, rotating refresh tokens with reuse detection, revocation list |
| Insider browsing of patient records | Care-relationship rule, break-glass with DPO review, complete read audit, "who accessed my record" |
| Enumerating records by id | UUIDv7 ids carry 74 random bits and every access is authorised; public status links use separate random refs |
| Cross-facility data leakage | Row-level security, fail-closed scope, no grants on partitions |
| Prompt injection / data leakage via LLM | §10.4–§10.5 |
| SQL injection | Parameterised queries only (Kysely / `sql` tagged templates); a lint rule forbids string-built SQL |
| Abuse and floods during the morning surge | Rate limits (§13.5), WAF, autoscaling, queue-based webhook ingestion |
| Malicious uploads | Size limits, magic-byte type checks, files never served from the API origin; virus scanning in phase 2 |

### 13.2 Encryption and keys

- **In transit:** TLS 1.2+ everywhere, including Postgres (`sslmode=verify-full`) and Redis.
- **At rest:** encrypted volumes for Postgres, Redis and backups; server-side encryption for object storage.
- **Application-level envelope encryption** (`src/infra/crypto.ts`): a key-encryption key in an in-country KMS/HSM wraps per-purpose data keys (`pii`, `cache`, `jobs`). Data keys are unwrapped at startup and held only in memory. Ciphertext format: `version(1) | key_version(2) | nonce(12) | ciphertext | tag(16)`. Data keys rotate yearly; `key_version` lets a background job re-encrypt rows.
- **Blind indexes** use a separate HMAC key that is not rotated casually: rotating it means recomputing every hash, done with a dual-hash transition period.
- Passwords: argon2id. Refresh tokens, device keys and OTPs: stored only as hashes.

### 13.3 Database access

- Separate login roles per process (`sahayak_api`, `sahayak_worker`, `sahayak_maint` (owner, used only for migrations and partition maintenance), `sahayak_analytics` (`app_ro`, replica only)).
- Per-role settings: `statement_timeout` 5 s for the API, 60 s for workers; `idle_in_transaction_session_timeout` 10 s.
- `log_min_duration_statement = 500ms` with `log_parameter_max_length = 0`, so slow-query logs never contain parameter values (PHI).

### 13.4 Input handling

Zod validation on every input with unknown fields rejected; JSON bodies ≤ 256 KB; uploads ≤ 16 MB with type detection by magic bytes; user-supplied file names are never used as storage paths.

### 13.5 Rate limits (Redis sliding window via `@fastify/rate-limit`)

| Endpoint | Limit |
|---|---|
| `POST /auth/patient/otp` | 3 per phone per 10 min; 20 per IP per hour |
| `POST /auth/staff/login` | 10 per IP per minute; account lock after 5 failures |
| `POST /kb/ask` (anonymous) | 20 per IP per minute |
| `GET /t/{publicRef}` | 60 per IP per minute (displays use sockets) |
| Authenticated staff API | 600 per user per minute |
| WhatsApp webhook | Not rate-limited (signature-verified); WAF only |

### 13.6 Compliance checklist (to be confirmed by the hospital's legal team, §20)

- **DPDP Act 2023 and DPDP Rules 2025**: notice and consent (§9.2), purpose limitation, data-principal rights (§9.12), breach notification, retention limits (§14.6), a grievance contact (the `dpo` role). The Rules were notified in November 2025; most substantive obligations apply from May 2027.
- **CERT-In directions (2022)**: incident reporting within 6 hours, logs retained 180 days in India, clocks synchronised (NTP).
- **Telemedicine Practice Guidelines (2020)**: no AI counselling or prescribing (§1.2, §2).
- **ABDM**: ABHA, facility (HFR) and professional (HPR) identifiers stored; consent-based exchange in phase 3.
- **Data residency**: all data, backups and logs in India (State Data Centre or a MeitY-empanelled cloud).
- **GIGW 3.0 / accessibility**: covered in the frontend specification.

### 13.7 Secrets

Secrets come from a secret manager at runtime, never from the repository. `.env` files exist only for local development and are git-ignored. The app refuses to start if a required secret is missing (`config/env.ts`).

---

## 14. Reliability and operations

### 14.1 High availability

- PostgreSQL: primary + synchronous standby in another availability zone (automatic failover via Patroni or a managed service) + one asynchronous replica for reads and analytics.
- PgBouncer: 2 instances behind a TCP load balancer.
- `redis-core`: primary + replica + 3 Sentinels. `redis-cache`: single primary is acceptable.
- Stateless processes: at least 2 instances of each role across zones; the scheduler uses a Redis leader lock, so a standby takes over within 30 s.

### 14.2 Degradation matrix

| Failure | What users notice | System behaviour |
|---|---|---|
| LLM provider down / circuit open / budget exhausted | Intake asks menu questions instead of free text; pre-brief without narrative | Structured mode (§9.3), deterministic pre-brief, KB curated answers + `not_found` |
| Embedding provider down | KB answers slightly less precise | Full-text-only branch of Q7 and FAQ by full-text; KB ingestion paused |
| WhatsApp API down | Alerts delayed | Outbound retries; critical messages via SMS; status page and displays keep working; walk-ins use kiosk/counter |
| `redis-cache` down | Slightly slower pages | Read-through to Postgres |
| `redis-core` down | Patient alerts paused; position pages slower | Token issuance unaffected (Postgres); position reads from Postgres (rate-limited); webhook returns 503 so Meta retries delivery; realtime falls back to polling |
| PostgreSQL primary failover | ~30 s of write errors | API returns 503 + `Retry-After`; kiosks/counters buffer locally (offline mode); public pages read from replica |
| Hospital internet down | Kiosks and counters work; TV displays freeze | Offline token blocks (§9.5.8); counter terminal can drive a local display (frontend spec) |
| Full cloud outage | Paper tokens | Pre-printed token slips; data entered later via offline sync / backfill |

### 14.3 Backups

Weekly full + daily differential backups and continuous WAL archiving to in-country object storage (pgBackRest or the managed equivalent), encrypted. Point-in-time recovery. **RPO ≈ 0** for a primary failure (synchronous standby), **≤ 1 minute** for a region-level restore; **RTO ≤ 30 minutes**. A monthly restore drill into staging runs verification queries (row counts per partition, latest audit digest chain).

### 14.4 Starting capacity for a state cell (validate with k6, §16)

| Component | Size |
|---|---|
| PostgreSQL primary (and each replica) | 32 vCPU, 128 GB RAM, 2 TB NVMe. `shared_buffers = 32GB`, `effective_cache_size = 96GB`, `work_mem = 32MB`, `maintenance_work_mem = 4GB`, `max_connections = 400`, `random_page_cost = 1.1`, `effective_io_concurrency = 200`, `max_wal_size = 16GB`, `checkpoint_timeout = 15min`, `autovacuum_max_workers = 6`, `autovacuum_naptime = 15s` |
| PgBouncer | 2 × 2 vCPU; `pool_mode = transaction`, `default_pool_size = 80`, `max_client_conn = 5000`, `max_prepared_statements = 200` |
| `redis-core` | 2 × (4 vCPU, 16 GB) + Sentinels |
| `redis-cache` | 1–2 × (4 vCPU, 32 GB) |
| `api` | 6–20 × (2 vCPU, 2 GB), autoscaled on CPU and latency |
| `realtime` | 4–8 × (2 vCPU, 4 GB), ~10k sockets each |
| `webhook` | 2–6 × (1 vCPU, 1 GB) |
| `worker` | 4–16 × (2 vCPU, 2 GB), autoscaled on BullMQ waiting counts |
| `scheduler` | 2 × (1 vCPU, 1 GB), one active |

### 14.5 Zero-downtime migrations

- Expand → migrate data → contract. Every migration sets `SET lock_timeout = '3s'` and the deploy retries on timeout.
- New columns are nullable or have constant defaults (no table rewrite). Large backfills run in batches of 5,000 rows by id range.
- New indexes on big unpartitioned tables: `CREATE INDEX CONCURRENTLY` in a dbmate migration marked `-- migrate:up transaction:false`.
- New indexes on partitioned tables (CONCURRENTLY is not supported on the parent):

```sql
CREATE INDEX encounters_doctor_idx ON ONLY encounters (doctor_user_id, id DESC);       -- parent index, initially invalid
CREATE INDEX CONCURRENTLY encounters_p202610_doctor_idx ON encounters_p202610 (doctor_user_id, id DESC);
ALTER INDEX encounters_doctor_idx ATTACH PARTITION encounters_p202610_doctor_idx;       -- repeat per partition; parent becomes valid
```

- Never use a new enum value in the same transaction that adds it.

### 14.6 Retention and archival

| Data | Kept in the database | Then |
|---|---|---|
| `opd_tokens` | 14 days | Deleted; token code and timings already copied to `encounters` |
| `intake_sessions` | 7 days | Deleted; result in `triage_assessments` |
| `emergency_prealerts` | 30 days | Deleted |
| Encounters and clinical children | Not auto-expired (`retention_months = NULL`) | Per legal policy (§20): older partitions can be archived to object storage with a tested restore procedure |
| `messages` | 12 months | Exported, then partition dropped |
| `notifications`, `llm_calls` | 6 months | Partition dropped |
| `queue_events` | 24 months | Exported, then dropped |
| `audit_events` | 24 months | Hourly WORM exports kept per policy (≥ 180 days in India) |
| Voice notes in object storage | 90 days after transcription | Deleted unless attached to a clinical record |

**Archival procedure** (`retention` job): `list_expired_partitions()` → stream the partition with `COPY ... TO STDOUT` into compressed files in object storage with a manifest (row count, checksum) → verify → `ALTER TABLE <parent> DETACH PARTITION <p> CONCURRENTLY` (outside a transaction) → `DROP TABLE <p>`. Children are processed before parents (`detach_order`).

### 14.7 Runbooks (write before go-live)

Queue projection rebuild; Redis failover; Postgres failover; LLM outage (turn AI off per facility); WhatsApp outage; missing future partitions; security incident (CERT-In 6-hour reporting, DPDP notifications); data-principal request handling; restore drill.

**Feature flags** (per facility, in `facilities.opd_config`, cached and invalidated by pub/sub): `ai_intake_enabled`, `prebrief_ai_enabled`, `kb_llm_enabled`, `remote_booking_enabled`, `offline_blocks_enabled`. Turning AI off never requires a deploy.

---

## 15. Observability

**Logs:** pino JSON with `request_id`, `trace_id`, `route`, `status`, `latency_ms`, `facility_id`, `actor_kind`. 🔒 Redaction paths cover names, phone numbers, message bodies, free text, authorization headers and cookies. No PHI in logs, metric labels, error messages or Redis keys. Logs retained 180 days in India.

**Traces:** OpenTelemetry auto-instrumentation for Fastify, `pg`, `ioredis` and outbound HTTP. BullMQ jobs carry the producer's trace context in their data so a WhatsApp message can be followed from webhook to reply. Sample 10% of traces plus all errors.

**Metrics** (Prometheus):

| Area | Metrics |
|---|---|
| HTTP | `http_request_duration_seconds{route,method,status}` |
| Queue | `queue_checkins_total{facility,department}`, `queue_call_next_duration_seconds`, `queue_waiting_tokens{facility,department,lane}`, `queue_wait_seconds` (histogram, at call), `queue_projection_rebuilds_total` |
| Intake & triage | `intake_sessions_total{channel,mode,outcome}`, `intake_step_duration_seconds{step}`, `triage_level_total{level,routing_method}`, `triage_overrides_total{direction}` |
| AI | `llm_call_duration_seconds{purpose,model,outcome}`, `llm_tokens_total{purpose,model,kind}`, `llm_fallbacks_total{purpose,reason}`, `kb_answers_total{path=faq\|rag\|not_found\|medical_redirect}`, `kb_eval_recall_at_5{facility,language}` |
| WhatsApp | `wa_webhook_duration_seconds`, `wa_inbound_total`, `wa_outbound_total{status}`, `wa_template_fallback_total` |
| Jobs & data | `bullmq_waiting{queue}`, `bullmq_job_duration_seconds{queue}`, `bullmq_failed_total{queue}`, `outbox_lag_seconds`, `pg_pool_wait_seconds`, `partitions_future_count{table}` |
| Compliance | `audit_write_failures_total`, `breakglass_total` |

**Alerts** (examples): SLO burn rate on check-in and position reads; `outbox_lag_seconds > 10` for 2 minutes; `partitions_future_count < 2`; webhook p99 > 500 ms; LLM fallback rate > 20% for 10 minutes; more than 5 projection rebuilds per hour; any `audit_write_failures_total`; `redis-core` memory > 70%; replication lag > 10 s; KB recall drop.

**Dashboards:** queue operations per facility; WhatsApp funnel (inbound → intake complete → booked → checked in → seen); AI health (latency, fallbacks, cost per facility); database health.

---

## 16. Testing strategy

| Level | What | Tooling |
|---|---|---|
| Unit | Rules engine (table-driven, 100% branch coverage), lane selection, ETA maths, `deidentify` (fuzzed with Indian phone/ABHA/PIN patterns), intake state transitions | Vitest |
| Integration | Migrations up/down; Q1–Q16 on seeded data with `EXPLAIN` assertions; RLS (fail-closed, cross-facility read and write); constraints and triggers (triage safety invariant, four-eyes, append-only); outbox replay idempotency; partition maintenance | Vitest + Testcontainers (`pgvector/pgvector:pg18`, `redis:8`) |
| Concurrency | 50 parallel check-ins on one session → unique, gapless token numbers; 10 doctors calling on 100 tokens → no double calls; Redis flush + rebuild → identical positions | Same |
| Contract | WhatsApp webhook fixtures (text, interactive reply, audio, image, status), signature verification; OpenAPI snapshot | Same |
| 🔒 Clinical safety | Every published rule set's `test_cases` plus a fixed multilingual regression suite of red-flag scenarios that must end in `emergency`, run on every change to rules, prompts or models | Vitest, CI-blocking |
| LLM evals | §10.7 | `evals/` runner, CI-blocking for prompt/model changes |
| Load | Morning surge: ramp to 85 check-ins/s + 5,000 position reads/s + 1,000 webhook messages/s for 30 minutes; call-next contention; KB burst. Pass = §3.3 SLOs | k6 |
| Chaos (staging) | Kill `redis-core` primary, kill Postgres primary, LLM 100% errors, WhatsApp 429 storm → verify §14.2 | Scripts + k6 |
| Security | Dependency audit, SAST, secret scanning in CI; DAST baseline on staging; third-party penetration test by a CERT-In-empanelled auditor before go-live | CI tooling |

---

## 17. Project structure and coding conventions

```
sahayak-backend/
├── db/
│   ├── migrations/            # dbmate SQL migrations, exactly as in §6.4
│   └── seeds/                 # demo facility, departments, rooms, schedules, symptom catalog, questions, templates, KB docs
├── evals/                     # LLM eval sets (§10.7)
├── load/                      # k6 scenarios
├── src/
│   ├── apps/                  # api.ts, realtime.ts, webhook.ts, worker.ts, scheduler.ts
│   ├── config/                # env.ts (Zod-validated), flags.ts
│   ├── infra/                 # db.ts (primary/replica pools, withScope), redis.ts (core/cache), queues.ts, storage.ts,
│   │                          # crypto.ts (envelope encryption, blind index), cache.ts, llm/, embeddings/, asr/, otel.ts, logger.ts
│   ├── shared/                # ids.ts (newId = UUIDv7, uuid7Boundary), time.ts (IST helpers), errors.ts (problem+json),
│   │                          # rbac.ts, access.ts (care relationship, break-glass), audit.ts, outbox.ts,
│   │                          # idempotency.ts, pagination.ts, i18n.ts
│   ├── modules/               # auth, facilities, patients, intake, triage, queue, prebrief, kb, patientdocs,
│   │   └── <module>/          # whatsapp, notifications, followups, analytics, audit, admin, devices, realtime
│   │       ├── routes.ts  service.ts  repo.ts  schemas.ts  events.ts  jobs.ts
│   │       ├── prompts/       # versioned prompt files (LLM modules only)
│   │       └── __tests__/
│   └── lua/                   # apply_token_state.lua, token_position.lua, release_lock.lua
├── test/                      # integration setup (Testcontainers), fixtures (WhatsApp payloads), factories
├── docker-compose.yml
├── Dockerfile                 # one image; the process role is the command
└── package.json
```

Conventions:

1. TypeScript `strict`, ESM, no `any`. Node 24 LTS.
2. **IDs:** `newId()` from `shared/ids.ts` (UUIDv7). Never `crypto.randomUUID()` (that is v4) for database ids.
3. **Business dates:** always `istDate()` from `shared/time.ts`; never derive dates from the server's local time zone.
4. **Database access only in `repo.ts`.** Every repo method takes a Kysely transaction whose scope was set by `withScope()`. Services never touch the pool directly.
5. **Side effects through the outbox:** any state change that must trigger Redis, realtime, notifications or jobs writes an `outbox_events` row in the same transaction (`shared/outbox.ts`).
6. 🔒 **PHI reads are audited:** repo methods that read clinical data call `audit.record()`. A custom ESLint rule forbids queries on PHI tables outside `repo.ts` files.
7. 🔒 **Patient-facing text only through `i18n.render(templateCode, language, vars)`**, which reads `message_templates`.
8. Errors are thrown as `AppError(code, httpStatus, detail)` and mapped to problem+json in one place.
9. New hot-path queries ship with their `EXPLAIN (ANALYZE, BUFFERS)` output on seeded data in the PR; prompt changes ship with eval results.

---

## 18. Build plan

Build in this order. Each milestone ends with its acceptance criteria passing in CI.

| # | Milestone | Scope | Acceptance criteria |
|---|---|---|---|
| M0 | Foundation | Repo scaffold, Docker Compose, config, logger, OpenTelemetry, health checks, migrations 0001–0011, CI with Testcontainers | `docker compose up` gives healthy services; migrations up and down pass; Q1–Q16 integration tests pass |
| M1 | Organisation & auth | Facilities, departments, service points, staff, devices; staff login + MFA + refresh rotation; RBAC; `withScope` + RLS; audit hook | Cross-facility read and write fail closed; refresh-token reuse revokes the family; audit rows written before responses |
| M2 | Patients & consent | Contact points, envelope encryption, blind indexes, households, Q1–Q3 search, duplicate check, consent ledger, clinical summary rebuild | Phone lookup returns the household; a database dump contains no plaintext phone/ABHA/address; summary rebuilds on events |
| M3 | Queue engine | Session creation job, check-in (Q4, idempotent), lanes, call-next (Q5 + lane selection), recall/skip/requeue, Redis projection + Lua + reconcile, realtime displays and doctor dashboard, ETA, offline blocks | 50 parallel check-ins → gapless unique numbers; 10 doctors × 100 tokens → no double calls; Redis flush + rebuild restores identical positions; position read p99 < 50 ms under load |
| M4 | Intake & triage (no AI yet) | State machine with web and kiosk adapters in structured mode; rules engine + test runner + four-eyes publish; emergency pre-screen; all outcomes incl. casualty pre-alerts | A full intake reaches a token without any LLM; clinical safety suite passes; four-eyes enforced |
| M5 | WhatsApp | Webhook, signature, dedupe, per-conversation ordering, outbound with 24-hour window and templates, media, SMS fallback interface, threshold alerts | Replaying a webhook 3× produces one reply; out-of-order messages handled; each alert sent once |
| M6 | AI layer | LLM gateway, `deidentify`, extraction, question selection, routing, fallbacks, evals in CI, budgets, circuit breaker | Eval thresholds met; with the provider failing 100%, intake still completes in structured mode; no raw identifiers in LLM requests (test) |
| M7 | Pre-brief | Assembly, generation, validation, fallback, delivery with call-next, feedback | Ready p95 < 10 s after check-in under load; a fabricated allergy in model output is dropped by the validator (test) |
| M8 | Knowledge bot | Ingestion, chunking, hybrid retrieval, FAQ fast path, confidence gate, medical redirect, eval job | recall@5 ≥ 0.90 on the seed eval set; a medical question returns the redirect |
| M9 | Operations features | Follow-ups, notifications, analytics rollups, retention and archival, partition maintenance, audit digests, DPO tools | An expired partition is archived and detached in staging; rollups match raw counts |
| M10 | Hardening | Load and chaos tests, security scans, runbooks, dashboards, alerts | §3.3 SLOs met in the surge test; every row of §14.2 verified by a chaos test |

**For the assignment demo:** M0–M4, then M6 (fast model only), M7 and M8 for one facility gives the complete story: a patient describes symptoms, gets triaged and routed, checks in, watches the queue, and the doctor sees a pre-brief. If WhatsApp business verification isn't ready in time, demo the same engine through the web adapter; M5 can follow.

---

## 19. Local development

`docker-compose.yml` (outline; Claude Code writes the full file):

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg18
    environment: { POSTGRES_DB: sahayak, POSTGRES_USER: sahayak_maint, POSTGRES_PASSWORD: dev }
    ports: ["5432:5432"]
    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements", "-c", "log_min_duration_statement=200"]
  pgbouncer:
    image: edoburu/pgbouncer
    environment:
      DATABASE_URL: postgres://sahayak_api:dev@postgres:5432/sahayak
      POOL_MODE: transaction
      MAX_PREPARED_STATEMENTS: "200"
    depends_on: [postgres]
  redis-core:
    image: redis:8
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]
  redis-cache:
    image: redis:8
    command: ["redis-server", "--save", "", "--maxmemory", "512mb", "--maxmemory-policy", "allkeys-lru"]
  objectstore:
    image: minio/minio            # any S3-compatible store works; swap if this image is unavailable
    command: ["server", "/data"]
  api:        { build: ., command: ["node", "dist/apps/api.js"],       depends_on: [pgbouncer, redis-core, redis-cache] }
  realtime:   { build: ., command: ["node", "dist/apps/realtime.js"],  depends_on: [redis-core] }
  webhook:    { build: ., command: ["node", "dist/apps/webhook.js"],   depends_on: [redis-core] }
  worker:     { build: ., command: ["node", "dist/apps/worker.js"],    depends_on: [pgbouncer, redis-core] }
  scheduler:  { build: ., command: ["node", "dist/apps/scheduler.js"], depends_on: [postgres, redis-core] }
```

Environment variables (validated by `config/env.ts`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | App role through PgBouncer |
| `DATABASE_URL_MAINT` | Owner role, direct to Postgres (migrations, partition maintenance, retention) |
| `DATABASE_REPLICA_URL` | Read replica (analytics, public pages) |
| `REDIS_CORE_URL`, `REDIS_CACHE_URL` | The two Redis deployments |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Object storage |
| `KMS_KEY_ID` (prod) / `DEV_MASTER_KEY` (dev only) | Key-encryption key |
| `BLIND_INDEX_KEY` | HMAC key for blind indexes |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | EdDSA keys for access tokens |
| `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID` | WhatsApp Cloud API |
| `ANTHROPIC_API_KEY`, `LLM_MODEL_FAST`, `LLM_MODEL_SMART` | LLM gateway |
| `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIM=1024` | Embeddings |
| `ASR_PROVIDER`, `SMS_PROVIDER` (optional) | Speech-to-text; SMS fallback |
| `APP_TIMEZONE=Asia/Kolkata` | Business-date computations |

**Seeds** (`db/seeds/`): one "Demo District Hospital" with 6 departments, rooms and 8 doctors' schedules; a symptom catalog of ~150 common symptoms with English/Hindi/Gujarati labels and Hinglish synonyms; ~60 vetted questions; a demo rule set clearly marked **DEMO — not for clinical use**; message templates in en/hi/gu; sample KB documents (OPD timings, PMJAY documents, wayfinding) with eval cases.

---

## 20. Open decisions

Claude Code MUST NOT guess these; ask the user.

1. **LLM data residency:** may de-identified clinical context be processed by an endpoint outside India? If not, pre-brief and extraction need an in-country endpoint, or those features stay in structured mode.
2. **Embedding provider:** hosted multilingual API vs self-hosted model (e.g. BGE-M3 on a small CPU inference service).
3. **WhatsApp setup:** direct Cloud API vs a Business Solution Provider; one state-wide number vs per-facility numbers; Meta business verification timeline for a government entity.
4. **Hosting:** State Data Centre vs MeitY-empanelled cloud; Kubernetes vs VMs.
5. **Retention periods** for clinical records, messages and audit logs (legal sign-off).
6. **Clinical governance:** who authors and approves triage rules, self-care leaflets, questions and medical templates.
7. **ABDM integration scope** and timeline.
8. **SMS provider** and DLT registration (sender id, templates).
9. **Lane policy:** protected-lane eligibility, ratio and maximum-wait aging per facility.
10. **Children's data** under the DPDP Rules (guardian consent flow).
11. **Speech-to-text provider** and the languages for v1 (proposal: English, Hindi, Gujarati).
12. **Product name.**

---

## Appendix A — Glossary

| Term | Meaning |
|---|---|
| ABDM | Ayushman Bharat Digital Mission, India's national digital health framework |
| ABHA | Ayushman Bharat Health Account: a patient's 14-digit health id (and `name@abdm` address) |
| HFR / HPR | ABDM registries of health facilities and healthcare professionals |
| ASHA | Accredited Social Health Activist, a village-level community health worker |
| CHC / PHC | Community / Primary Health Centre |
| PMJAY | Pradhan Mantri Jan Arogya Yojana, the government health insurance scheme |
| OPD | Outpatient department |
| MRN / UHID | Hospital medical record number / unique health id |
| LWBS | Left without being seen |
| RRF | Reciprocal Rank Fusion: merges ranked lists by summing `1 / (k + rank)` |
| HNSW | Hierarchical Navigable Small World graph, the approximate vector index used by pgvector |
| RLS | Row-level security in PostgreSQL |
| PITR | Point-in-time recovery |
| DLT | TRAI's Distributed Ledger Technology registration required for commercial SMS in India |
| DPDP | Digital Personal Data Protection Act 2023 and Rules 2025 |
| CERT-In | Indian Computer Emergency Response Team |

## Appendix B — Validation record

All SQL in sections 6, 7 and 9.11 was executed on **PostgreSQL 18.3 with pgvector 0.8.1 and pg_trgm**: the 11 migrations up and down; the 16 hot queries with seeded data and real parameters; the triage safety constraint, four-eyes rule, rule-set immutability and append-only triggers; row-level security (own facility visible, other facility hidden, unset scope returns nothing, direct partition access denied, cross-facility writes rejected); partition creation, co-location of child rows, and expired-partition listing; and vector-index plan selection at 3,000 chunks. Re-run these checks in CI (M0) against the production Postgres version.
