# Monthly restore drill

1. Restore the latest base backup + WAL to a point in time into staging (pgBackRest or the managed equivalent).
2. Verification queries: row counts per partition (`SELECT tableoid::regclass, count(*) FROM encounters GROUP BY 1`), latest `audit_digests` chain verifies (`sha256(prev_digest || rows_hash)` recomputed by the digest job over a sample hour), `SELECT * FROM list_expired_partitions()` matches production.
3. Run the integration suite against the restored database (`TEST_DATABASE_URL=... npm run test:integration`).
4. Record RPO/RTO achieved (targets: RPO ≈ 0 / ≤ 1 min, RTO ≤ 30 min).
