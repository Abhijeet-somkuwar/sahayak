# Connecting the frontend

The web frontend lives in `../frontend/` and follows this backend's contract exactly (nothing on the backend had to change for auth or realtime).

## Processes and ports

| Process | Port | Path |
|---|---|---|
| api (REST, OpenAPI) | 3000 | `/api/v1/*`, docs at `/api/v1/docs`, spec at `/api/v1/openapi.json` |
| realtime (Socket.IO) | 3001 | `/socket.io/*`, namespaces `/staff`, `/display`, `/patient` |
| webhook (WhatsApp) | 3002 | `/api/v1/webhooks/whatsapp` |
| **dev gateway** | **8000** | one origin: `/api/*` → 3000, `/socket.io/*` → 3001 (WebSocket upgrade supported) |

Start: `docker compose up -d postgres pgbouncer redis-core redis-cache objectstore`, `npm run db:migrate:node`, `npm run db:seed` (once), then `npm run dev:all` (api, realtime, worker and the gateway together).

## Frontend `.env`

```
VITE_API_URL=http://localhost:8000
VITE_DEFAULT_FACILITY=GJ-DEMO-DH
```

For another machine on the LAN, use that machine's address, e.g. `VITE_API_URL=http://192.168.1.6:8000`. Development CORS reflects any origin with credentials; production uses the `CORS_ORIGINS` allow-list.

## Auth, as the frontend does it

| Topic | Contract |
|---|---|
| Staff login | `POST /auth/staff/login { identifier, password }` → tokens, or `{ mfa_required, mfa_token, enrol_required }` for doctors, admins, reviewers and the DPO |
| MFA | `POST /auth/staff/mfa/enrol { mfa_token }` → `otpauth_url` (QR and manual key shown) → `POST /auth/staff/mfa/verify { mfa_token, code }` |
| Tokens | access token in memory (`Authorization: Bearer`), refresh token in `sessionStorage`, rotated through `POST /auth/refresh { refresh_token }` |
| Patients | `POST /auth/patient/otp { phone, language }` (dev returns `dev_code`) → `POST /auth/patient/otp/verify` → patient token |
| Devices | `X-Device-Key` header; keys come from the seed or `POST /facilities/:id/devices` |

## Realtime, as the frontend does it

- `/staff` with `auth: { token }`; `/display` with `auth: { deviceKey }`; `/patient` with `auth: { publicRef }`.
- `socket.emit('subscribe', { kind, id })` for `queue`, `facility`, `ed`.
- Events used: `queue.snapshot`, `queue.updated`, `token.called`, `token.status`, `prebrief.ready`, `ed.prealert`.

## Request conventions the frontend follows

- `Idempotency-Key` on `POST /encounters`, `/queues/{id}/checkins` and intake answers.
- `If-Match: "<version>"` on `/tokens/{id}/start|complete|skip|recall|requeue|cancel`; 412 `version_conflict` makes the screen reload the token.
- Errors are RFC 9457 `application/problem+json` with a stable `code`.

## Added for the web screens

- `GET /queues/:sessionId/next` (staff, `queue.read`): next waiting token codes per lane.
- `GET /bookings/:encounterId` (device or staff): resolve a booking QR to today's queue session.
