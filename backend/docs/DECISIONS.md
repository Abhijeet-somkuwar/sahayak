# Implementation decisions and assumptions

This file records (a) how every §20 open decision was handled in code without guessing the *policy*, and (b) the small
deviations from BACKEND_DESIGN.md that the build environment forced, each with its reason (§0 rule 2 requires a written reason).

## §20 open decisions — made configurable, defaults documented, nothing invented

| # | Decision | What the code does | Default |
|---|---|---|---|
| 1 | LLM data residency | `providerAllowed(purpose)` in `src/infra/llm/routing.ts`: purposes that carry patient context are only sent when `LLM_ALLOW_OFFSHORE_PATIENT_CONTEXT=true` **or** an in-country `ANTHROPIC_BASE_URL` is configured; otherwise they return `blocked_by_guardrail` and the deterministic fallback runs. `kb_answer` carries no patient data and is always allowed. | blocked until the hospital decides |
| 2 | Embedding provider | Provider interface with `mock` (dev/tests only, refused in production by `env.ts`), `http` (OpenAI-compatible `/embeddings`, works for self-hosted BGE-M3 behind TEI/vLLM) and `voyage`. Dimension mismatches throw (never mix models in one index). | `mock` locally |
| 3 | WhatsApp setup | Direct Cloud API client (`src/modules/whatsapp/client.ts`) with simulation mode when no token is configured. One number per deployment (`WA_PHONE_NUMBER_ID`); per-facility numbers would add a `phone_number_id` column to `facilities`. | simulated |
| 4 | Hosting | Docker Compose for the demo; one image, five process roles. Kubernetes vs VMs is deployment-only. `KmsKeyProvider` is the hook for the in-country KMS; the demo uses `LocalKeyProvider` (HKDF from `DEV_MASTER_KEY`). | compose |
| 5 | Retention periods | Exactly the spec defaults in `partition_registry` and the retention job; legal sign-off changes numbers only. | spec defaults |
| 6 | Clinical governance | Four-eyes is enforced in the DB and the API; the seeded rule set, questions, leaflets and medical templates are **DEMO — not for clinical use** and are marked as reviewed by the demo reviewer users only so the demo can run. | demo content |
| 7 | ABDM scope | Identifiers (ABHA, HFR, HPR) are stored; no ABDM API calls (phase 3). | — |
| 8 | SMS provider / DLT | Provider interface: `log` (dev) and `http` (generic JSON API with a DLT template id). | `log` |
| 9 | Lane policy | Per facility in `facilities.opd_config`: `lane_ratio`, `max_wait_minutes`, `protected_lane_min_age`, `requeue_penalty_minutes`. | 1:2, 120 min, 60 y, 15 min |
| 10 | Children's data | Age is captured; a guardian-consent step is a template + one extra state in the intake engine once the DPDP rule is decided. Not implemented without the rule. | — |
| 11 | Speech-to-text | ASR provider interface; `none` (menu fallback) and a Bhashini adapter skeleton. Languages seeded: en, hi, gu. | `none` |
| 12 | Product name | "Sahayak" everywhere; config `SERVICE_NAME`. | Sahayak |

## Deviations forced by the environment (with reasons)

| Topic | Spec | Here | Why |
|---|---|---|---|
| Node version | Node 24 LTS | Builds and runs on Node ≥ 22 (`engines`), Docker image uses `node:24-alpine` | The build machine has Node 22; nothing in the code needs 24-only APIs. |
| Object store image | `minio/minio` | `rustfs/rustfs` (MinIO-compatible S3 API) | MinIO's public images are no longer anonymously pullable from Docker Hub or quay.io in this environment; the spec allows any S3-compatible store. |
| Postgres host port | 5432 | 5434 on the host (`POSTGRES_HOST_PORT`) | A local Postgres already owns 5432 (and 5433) on the dev machine. Inside the compose network it is still 5432. |
| Kysely `Generated<>` | — | Local nesting-aware `Generated<S>` in `db.types.ts` | Kysely 0.29 made `Generated` non-conditional, which double-wraps `ColumnType` aliases. |
| dbmate | dbmate binary | dbmate npm package **and** a dbmate-compatible Node runner (`src/infra/migrate.ts`) | Tests and the `migrate` compose service need a programmatic runner; the file format and `schema_migrations` table are identical, so the binary still works. |
| Eval set sizes | ≥ 300 / 200 / 50 cases | Starter sets (40 / 20 / 10 / 2) + runner | Labelled clinical data is a governance task (open decision 6); the runner enforces the §10.7 thresholds once the sets exist. |
| `intake-step` queue | Deferred intake steps | Registered but currently a no-op | Web and WhatsApp steps run inline (the WhatsApp job already holds the per-conversation lock); the queue is kept for voice-note continuation work. |

## Notable implementation choices (within the spec)

- **Writes of one intake step are committed together** after reads and LLM calls (`IntakeEngine.handle`), so no transaction is held open across a 4–15 s LLM call (PgBouncer + `idle_in_transaction_session_timeout = 10s`).
- **Reporting window** of a remote booking is stored in `intake_sessions.facts.reporting_window_start` (hot table, 7 days), which is exactly the lifetime the check-in needs.
- **Patient / anonymous callers** run repos with `app.scope = 'state'` and filter strictly by household or public ref; staff and devices always run with facility scope so RLS applies.
- **Break-glass grants** live in Redis (`bg:<userId>:<patientId>`, 4 h); the audit row with `purpose = 'breakglass'` is the durable record and feeds the DPO review queue.
