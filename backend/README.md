# Sahayak backend

> Plain JavaScript (ES modules). Converted from the TypeScript original: types stripped, same files, structure and behaviour, no build step. `npm run dev:api` runs `src/apps/api.js` directly.

AI-assisted OPD intake, triage, queue and doctor pre-brief platform for Indian government hospitals. This repository implements
[`../BACKEND_DESIGN.md`](../BACKEND_DESIGN.md) (v1.0): Node.js 22+ plain JavaScript (ES modules), Fastify 5, PostgreSQL 18 + pgvector,
Redis 8, BullMQ, Socket.IO, Claude API behind an internal LLM gateway.

> ⚠️ All seeded clinical content (rule set, questions, leaflets, medical templates) is **DEMO — not for clinical use**.
> Real content must be authored and approved by clinicians (four-eyes is enforced in the database and the API).

## Quick start (docker compose, whole cell on one machine)

```bash
cp .env.example .env
npm run keys:gen            # paste JWT_PRIVATE_KEY / JWT_PUBLIC_KEY (and fresh DEV_MASTER_KEY / BLIND_INDEX_KEY) into .env
docker compose up -d        # postgres (host port 5434), pgbouncer (6432), redis-core (6379), redis-cache (6380), object store (9000), migrate, api, realtime, webhook, worker, scheduler
npm install && npm run db:seed
open http://localhost:3000/api/v1/docs        # OpenAPI 3.1 UI (dev only); JSON at /api/v1/openapi.json
npm run smoke                      # end-to-end story: login → registration → token → call-next → intake → KB → audit
```

Local processes instead of containers: `docker compose up -d postgres pgbouncer redis-core redis-cache objectstore`, then
`npm run db:migrate:node && npm run db:seed`, then `npm run dev:api` / `dev:worker` / `dev:scheduler` / `dev:realtime` / `dev:webhook`.

Demo logins (password printed by the seed, default `Demo@12345678`): `clerk@`, `nurse@`, `admin@`, `dr.mehta@` … `@demo.sahayak.health`.
Doctors, admins, reviewers and the DPO must enrol TOTP on first login (`POST /auth/staff/mfa/enrol` → authenticator app → `/mfa/verify`).

## Layout (§17)

```
db/migrations/      11 dbmate migrations — byte-for-byte the SQL of §6.4
db/seeds/           demo facility, 159 symptoms (en/hi/gu + Hinglish), 60 questions, DEMO rule set, 98 template codes × 3 languages, KB docs, FAQ, eval cases
db/init/            login roles per process (sahayak_api, sahayak_worker, sahayak_analytics) + per-role timeouts
src/apps/           api, realtime, webhook, worker (+ outbox relay), scheduler, migrate
src/config/         env.js (Zod-validated, refuses to start without secrets), flags.js (per-facility feature flags)
src/infra/          db (withScope → RLS), redis (two deployments + Lua), queues (BullMQ), crypto (envelope + blind index), cache (PHI-encrypted), llm/, embeddings/, asr/, sms/, storage, partitions, metrics, otel, logger
src/shared/         ids (UUIDv7), time (IST), errors (problem+json), rbac, access (care relationship + break-glass), audit (onSend hook), outbox, idempotency, etag, i18n, phone
src/modules/        auth, facilities, patients, intake, triage, queue, prebrief, kb, patientdocs, whatsapp, notifications, followups, analytics, audit, admin, devices, realtime
src/lua/            apply_token_state.lua, token_position.lua, release_lock.lua
test/unit           rules engine, 🔒 clinical safety suite, lane/ETA maths, deidentify (fuzzed), helpers, pre-brief validator
test/integration    Testcontainers: migrations up/down, Q1–Q16, constraints, RLS fail-closed, partitions; API: auth/MFA/refresh reuse, audit, idempotency, 50 parallel check-ins, 10 doctors × 100 tokens, Redis flush + rebuild; intake to booking without LLM, emergency/self-harm, WhatsApp webhook 3× replay, KB FAQ/not_found
evals/              LLM eval runner + starter sets (§10.7)
load/               k6: morning surge, call-next contention, KB burst (§16)
docs/               DECISIONS.md (§20 handling + deviations), ALERTS.md, runbooks/
```

## Commands

| Command | What |
|---|---|
| `npm run lint` | ESLint incl. custom rules: no PHI queries outside `repo.js`, no string-built SQL, no `randomUUID()` for ids |
| `npm run db:migrate` / `db:rollback` | dbmate binary (uses `DATABASE_URL_MAINT`) |
| `npm run db:migrate:node` / `db:rollback:node` | same migrations through the built-in dbmate-compatible runner |
| `npm run db:seed` | idempotent demo seed |
| `npm test` / `test:unit` / `test:integration` / `test:safety` | Vitest (integration needs Docker, or `TEST_DATABASE_URL`/`TEST_REDIS_URL`) |
| `npm run eval -- <purpose>` | LLM evals (needs `ANTHROPIC_API_KEY`) |
| `k6 run load/*.js` | load scenarios |

## How the spec maps to code

| Spec | Code |
|---|---|
| D6 token numbers in Postgres (Q4) | `queue/repo.js allocateTokenNo`, `queue/service.js checkIn` |
| D7 rules decide, LLM only escalates (CHECK + code) | `triage/engine.js combineLevels`, migration 0004 `final_not_less_urgent_than_rules`, `intake/engine.js triage()` |
| D8 vetted questions / content only | `intake/engine.js clarifyNext`, `kb/service.js leafletFor`, `shared/i18n.js render` |
| D9 exact per-patient search, summary row | `patients/service.js rebuildSummary`, `patientdocs/repo.js search` (Q10) |
| D10 hybrid retrieval + RRF + FAQ fast path | `kb/repo.js hybrid` (Q7), `faqFastPath` (Q8), `kb/service.js ask` |
| D14 envelope encryption + blind indexes | `infra/crypto.js`, `patients/service.js` |
| D15 household model | `patients/repo.js household` (Q1), intake `who_for` |
| D17 offline token blocks | `queue/service.js allocateBlock / uploadOfflineTokens` |
| D18 transactional outbox | `shared/outbox.js`, `apps/outbox.js` (Q11 relay) |
| §8 Redis read model | `queue/projection.js` + `src/lua/*` |
| §9.1 auth, RBAC, care relationship, break-glass | `modules/auth`, `shared/rbac.js`, `shared/access.js` |
| §9.12 audit before response, digests, DPO tools | `shared/audit.js`, `modules/audit` |
| §10 LLM gateway, deidentify, breaker, budgets | `infra/llm/*` |
| §12 jobs | `apps/worker.js`, `apps/scheduler.js`, `*/jobs.js` |
| §13.3 per-role DB settings | `db/init/01-roles.sql` |
| §14.6 retention / archival | `infra/partitions.js` |

See [docs/DECISIONS.md](docs/DECISIONS.md) for how each §20 open decision is handled and the few environment-forced deviations.

## Routes added for the web frontend

| Route | Who | Returns |
|---|---|---|
| `GET /api/v1/queues/:sessionId/next?limit=10` | staff with `queue.read` | next waiting token codes per lane, for the doctor's queue rail (no patient data) |
| `GET /api/v1/bookings/:encounterId` | kiosk device or staff | the booking's status, department and today's queue session id, so a scanned booking QR (`sahayak:enc:<id>`) can be checked in |
| `GET /api/v1/me/visits?lang=` | patient (OTP) | visits booked from this phone (24 months) with department, doctor, complaint labels, the doctor's diagnoses and prescriptions; no AI content |
| `GET /api/v1/me/visits/by-ref/:ref` | patient (OTP), only the phone that owns the visit | the same for one slip, shown under a completed slip |
| `GET /api/v1/patients/:id/visits` | staff with `patient.clinical.read` (audited as `patient.history.read`) | the doctor's visit history, plus the AI pre-brief headline written at each visit |
| `POST /api/v1/encounters/:id/prebrief/regenerate` | staff with clinical access | queues a fresh pre-brief ("Try again"); `prebrief.ready` follows |
| `GET /api/v1/dev/demo` | anyone, development only | demo staff accounts and password, working kiosk/display device keys (rotated and saved to `.demo-device-keys.json` if the file no longer matches), sample patient phones; not registered when `NODE_ENV=production` |
| `POST /api/v1/dev/demo/reset` | anyone, development only | "Start a fresh demo": cancels today's waiting/called/skipped tokens and completes in-consult ones through the normal transitions, resets lane fairness counters, closes casualty pre-alerts |
| `POST /api/v1/auth/staff/mfa/dev-code` | anyone holding an MFA-pending token (a correct password), development only | the current authenticator code for that account, so the sign-in screen can show it; not registered when `NODE_ENV=production` |

The frontend keeps the refresh token in `sessionStorage` and sends it in the body of `POST /auth/refresh`, as this backend expects. Postgres runs on host port `POSTGRES_HOST_PORT` (5435 here; 5434 is used by another project on this machine).

## LLM providers

`LLM_PROVIDER=anthropic` uses Claude through the Anthropic SDK; `LLM_PROVIDER=openai` uses any OpenAI-compatible chat-completions API (`OPENAI_BASE_URL` + `OPENAI_API_KEY`): Groq, OpenAI, Gemini's OpenAI endpoint, vLLM, Ollama. Both go through the same gateway (`src/infra/llm/gateway.js` + `providers.js`): de-identified input, one forced tool call validated against the prompt's Zod schema, `llm_calls` logging, per-facility token budget, circuit breaker, and a bounded wait on 429 `retry-after`. Models must support tool calling. This checkout is configured for Groq (`openai/gpt-oss-20b` fast, `openai/gpt-oss-120b` smart).

Evals on a rate-limited tier: `EVAL_LIMIT=12 EVAL_DELAY_MS=6000 npm run eval -- intake_extract`.
