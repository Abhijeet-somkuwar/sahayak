# Sahayak: developer guide

AI-assisted OPD intake, triage, queue and doctor pre-brief for Indian government hospitals. Plain JavaScript on both sides.

```
hospital_project/
├── frontend/   React 18 + Vite (JSX), React Router, Context, Axios, Socket.IO client, Ant Design, plain CSS
├── backend/    Node 22+ (ES modules), Fastify 5, PostgreSQL + pgvector, Redis, BullMQ, Socket.IO
├── e2e/        Playwright browser tests (JavaScript)
└── docs/       screenshots, design notes
```

**Want to try it?** Run it (below), open **http://localhost:5173/demo** and follow the 15-minute guided demo: its buttons open every screen already signed in, and the purple **Demo** button on every screen lists all logins and device keys (development only). A copy for reading is in [DEMO_GUIDE.md](DEMO_GUIDE.md).

**To understand it, read [HOW_IT_WORKS.md](HOW_IT_WORKS.md)**: a plain-language walkthrough of every screen, the patient journey, the queue rules, what the AI does and does not do, a five-minute demo script and a glossary. Backend design document: [`backend/BACKEND_DESIGN.md`](../backend/BACKEND_DESIGN.md).

## Environment files (one each)

| File | What it holds |
|---|---|
| `frontend/.env` | `VITE_API_URL` (backend origin; default `http://localhost:8000`, the dev gateway) and `VITE_DEFAULT_FACILITY` |
| `backend/.env` | ports, database and Redis URLs, object store, encryption keys, JWT keys, WhatsApp, LLM, embeddings, `POSTGRES_HOST_PORT` |

Both have a `.env.example`. The backend `.env` already contains working development keys; `npm --prefix backend run keys:gen` makes fresh ones.

## Run it (first time)

Needs Node 22+, npm and Docker Desktop.

```bash
npm run install:all          # root tooling, frontend and backend dependencies
npm run backend:infra        # Postgres (host port 5435), PgBouncer, two Redis, object store
npm run backend:migrate      # 11 SQL migrations
npm run backend:seed         # demo facility, departments, staff, devices, symptoms, rules, templates
npm run dev                  # backend (api :3000, realtime :3001, worker, gateway :8000) + frontend :5173
```

The seed prints the staff password (`Demo@12345678`), the facility code and three **device API keys** (shown once). Keep the keys: the kiosk and the waiting-hall display ask for one on first use. Lost keys can be rotated through the admin API (`POST /facilities/:id/devices/:id/rotate-key`), or re-seed a fresh database.

`npm run backend:smoke` runs the backend's own end-to-end story (login → registration → token → call-next → intake → knowledge base → audit).

## Screens

| Screen | URL | Who |
|---|---|---|
| Patient: facility page | http://localhost:5173/f/`<facility code>` | anyone |
| Patient: start a visit | "Start a visit" → OTP sign-in (the code is shown on screen in development) → conversational intake → booking slip with QR | patient |
| Slip status | http://localhost:5173/t/`<ref>` (given at check-in; printed by the kiosk or counter) | patient |
| Kiosk | http://localhost:5173/kiosk (device key "Gate Kiosk") | hospital gate |
| Waiting-hall display | http://localhost:5173/display (device key "Main Hall Display") | TV |
| Staff sign-in | http://localhost:5173/login | `clerk@demo.sahayak.health` / `Demo@12345678` |
| Counter | http://localhost:5173/counter | clerk |
| Doctor console | http://localhost:5173/doctor | `dr.mehta@demo.sahayak.health` + authenticator code. In development the sign-in screen shows the current code itself (Copy / Sign in with this code); `npm run totp` prints it too. An account that has never signed in also shows a QR code to scan with Google Authenticator / Authy. `npm run totp -- --reset <email>` starts an account's enrolment over. |
| Casualty board | http://localhost:5173/ed | doctors, nurses, admins |

Demo order: the counter registers and checks in a patient and prints the status link → the doctor presses `N` → the display and the patient's slip update within a second. From a phone: start a visit, answer the questions, show the booking QR at the kiosk.

## The AI parts (LLM)

The backend uses an LLM for four things, all behind one gateway (`backend/src/infra/llm/`): understanding a free-text complaint during intake, suggesting the department, writing the short narrative of the doctor pre-brief, and answering knowledge-base questions. Everything else (triage rules, lanes, ETAs, the clinical facts in the pre-brief) is deterministic and works with no LLM at all; when the LLM is unavailable the app falls back to that path, which is why the smoke test passes without any key.

Provider and models are configuration in `backend/.env`:

| Variable | Now | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `anthropic` (Claude) or `openai` (any OpenAI-compatible API) |
| `OPENAI_BASE_URL` | `https://api.groq.com/openai/v1` | Groq. OpenAI or Gemini work the same way with their base URL |
| `OPENAI_API_KEY` | the Groq key | |
| `LLM_MODEL_FAST` / `LLM_MODEL_SMART` | `openai/gpt-oss-20b` / `openai/gpt-oss-120b` | fast tier for intake and routing, smart tier for the pre-brief |
| `LLM_ALLOW_OFFSHORE_PATIENT_CONTEXT` | `true` | Groq is hosted abroad; patient context is de-identified before it is sent |

Patient text is scrubbed of phone numbers, ids, names and addresses before any LLM call (`deidentify.js`), every call is logged in `llm_calls`, there is a daily token budget per facility and a circuit breaker. Check a provider works with `npm --prefix backend run eval -- department_route`.

## Commands

| Command | What |
|---|---|
| `npm run dev` | everything for development |
| `npm run build` | production build of the frontend (`frontend/dist`) |
| `npm test` | frontend unit tests (validation, version guard) and backend unit tests (76: rules engine, clinical safety, queue maths, de-identification) |
| `npm run e2e` | Playwright end-to-end tests against the running stack |
| `npm run totp` | current authenticator codes for the demo accounts enrolled by the smoke/e2e tests; `-- --reset <email>` clears an enrolment |
| `npm run video:overview` | records the narrated product-overview video (`docs/video/sahayak-overview.mp4`) by playing the demo story across every screen; needs the running stack and ffmpeg on PATH. `-- --fast` is a quick silent check, `-- --no-voice` skips the narration |
| `npm --prefix backend run lint` | ESLint with the backend's PHI and SQL safety rules |
| `npm --prefix backend run test:integration` | backend integration tests (Testcontainers; needs Docker) |

## How the frontend talks to the backend

- REST under `/api/v1` (OpenAPI UI at http://localhost:3000/api/v1/docs). Errors are RFC 9457 problem+json with a stable `code`, mapped to messages in `frontend/src/utils/errors.js`.
- Staff: `Authorization: Bearer <access token>` (15 min, in memory) plus a refresh token in `sessionStorage`, rotated on `/auth/refresh`. Doctors, admins, reviewers and the DPO sign in with password + TOTP.
- Patients: OTP → patient token. The slip page needs no sign-in (random public reference only).
- Devices (kiosk, display): `X-Device-Key`.
- Realtime: Socket.IO namespaces `/staff`, `/display`, `/patient`; rooms `queue:<sessionId>`, `facility:<id>`, `ed:<id>`, `token:<id>`; events `queue.snapshot`, `queue.updated`, `token.called`, `token.status`, `prebrief.ready`, `doctor.status`, `ed.prealert`.
- Token transitions send `If-Match: "<version>"`; a stale version gets 412 and the screen reloads the token.
- Check-ins and intake answers carry an `Idempotency-Key`.

Two small routes were added to the backend for the web screens: `GET /queues/:sessionId/next` (next waiting token codes per lane, for the doctor rail) and `GET /bookings/:encounterId` (resolves a booking QR to today's queue session, for the kiosk and counter). Neither returns patient data. Development-only routes (never registered when `NODE_ENV=production`): `GET /dev/demo` (demo logins, device keys and sample phones for the Demo panel), `POST /dev/demo/reset` ("Start a fresh demo": cancels today's leftover tokens through the normal queue transitions and closes casualty alerts), and `POST /auth/staff/mfa/dev-code`: given the short-lived token from a correct password, it returns the account's current authenticator code so the sign-in screen can show it, the same convenience as `dev_code` on the patient OTP.

## About the conversion

The backend was written in TypeScript. It is now plain JavaScript: types were stripped with sucrase (comments and structure kept), `tsconfig` and the build step are gone, `npm run dev:api` runs `src/apps/api.js` directly, tests run with Vitest on the `.js` files, and ESLint keeps the custom safety rules. Verified: 76 unit tests and the full smoke story pass on the JavaScript code. The original TypeScript tree is not part of this repository.

The frontend was rebuilt from the earlier TypeScript, Tailwind and TanStack version into React + JavaScript with React Router, Context, Axios and Ant Design themed with the Parchi tokens (`frontend/src/styles/tokens.css`). Component CSS sits next to each component.
