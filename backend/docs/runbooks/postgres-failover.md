# PostgreSQL failover

Synchronous standby + Patroni/managed failover: ~30 s of write errors. The API maps connection errors to `503 database_unavailable` with `Retry-After: 5`; kiosks and counters continue with offline token blocks (§9.5.8) and sync later.
1. Watch PgBouncer reconnect (`SHOW SERVERS`), then `pg_pool_wait_seconds` fall.
2. Verify replication lag < 10 s on the new standby before resuming analytics reads.
3. Run `SELECT ensure_partitions(1,3)` once the new primary is up (idempotent).
4. Check `outbox_events WHERE published_at IS NULL` drains; the relay replays side effects for commits that happened before the failover.
