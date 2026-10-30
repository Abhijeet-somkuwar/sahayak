# Missing future partitions

Alert `partitions_future_count{table} < 2`. There is deliberately no DEFAULT partition: an insert into a missing month fails loudly.
1. Run as the owner role: `SELECT ensure_partitions(1, 3);` (idempotent) — or restart the scheduler, which runs it at start-up and daily at 02:10 IST.
2. Check the scheduler leader lock: `GET lock:leader:scheduler` in redis-core. If no instance holds it, the scheduler is down.
3. Verify with `SELECT * FROM list_expired_partitions();` and `\d+ encounters`.
