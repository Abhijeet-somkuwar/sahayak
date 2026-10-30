# Queue projection rebuild

**Symptom:** TV display or `/t/<ref>` positions differ from `SELECT lane, count(*) FROM opd_tokens WHERE queue_session_id = $1 AND status = 'waiting' GROUP BY lane`; alert `queue_projection_rebuilds_total` > 5/h.

1. Confirm Postgres is healthy (`/api/v1/readyz` on an api pod). Postgres is the system of record; Redis is only a read model.
2. The scheduler reconciles every open session every 60 s (07:00–20:00 IST) and rebuilds on mismatch automatically. To force it now:
   ```ts
   // from a worker shell
   import { rebuildSession } from './dist/modules/queue/projection.js'; await rebuildSession('<queueSessionId>');
   ```
   or restart the scheduler, which rebuilds on the next tick.
3. If rebuilds repeat for one session, look for a consumer writing to Redis with a stale version (check `queue_events.token_version` vs the `v` field in `q:{qs}:tok:<tokenId>`). The Lua script ignores stale versions, so repeated mismatches point at missing `token.*` outbox events: check `outbox_events WHERE published_at IS NULL`.
4. Token issuance never depends on Redis (D6); check-ins keep working during the incident.
