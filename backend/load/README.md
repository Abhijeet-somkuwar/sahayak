# Load tests (k6)

| Script | Scenario | Pass criteria (§3.3) |
|---|---|---|
| `morning-surge.js` | ramp to 85 check-ins/s + 5,000 position reads/s + 1,000 webhook messages/s for 30 min | check-in p99 < 300 ms, position p99 < 50 ms, webhook p99 < 100 ms, failures < 0.1% |
| `call-next-contention.js` | 10 doctors hammering call-next on one queue | p99 < 300 ms, no double calls (verify with `SELECT count(*), count(DISTINCT id)` on called tokens) |
| `kb-burst.js` | 50 req/s mixed FAQ / retrieval questions | FAQ p99 < 150 ms, retrieval+LLM p95 < 4 s |

Seed first (`npm run db:seed`), log a clerk and ten doctors in to get JWTs, open a queue session, then pass the ids via `-e`.
Chaos scenarios for §14.2 (kill redis-core, kill Postgres primary, LLM 100% errors, WhatsApp 429 storm) are described in
`docs/runbooks/` and are run against staging with these same scripts active.
