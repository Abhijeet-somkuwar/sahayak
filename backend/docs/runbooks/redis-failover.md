# Redis failover

**redis-core** (noeviction + AOF): Sentinel promotes a replica within ~30 s. Expect: BullMQ workers reconnect, the scheduler leader lock expires (30 s) and a standby takes over, queue read models may be slightly stale → the reconcile job rebuilds them (see queue-projection-rebuild.md).
- Webhook returns 503 while redis-core is down so Meta retries delivery; nothing is lost.
- Position pages fall back to Postgres (`statusByRef` SQL path) — slower, rate-limited.
- After failover check `bullmq_waiting{queue}` drains and `outbox_lag_seconds` returns to 0.

**redis-cache** (LRU, no persistence): losing it only costs latency; pre-briefs are re-read from `prebriefs`, summaries from `patient_clinical_summaries`, facility config from Postgres.
