# Outbox lag

`outbox_lag_seconds > 10` for 2 minutes means the relay in the worker role is not keeping up or is down.
1. `SELECT count(*), min(created_at) FROM outbox_events WHERE published_at IS NULL;`
2. Worker logs: `outbox dispatch failed` lines name the failing consumer (Redis projection, notification, BullMQ enqueue). Failed events keep `attempts` incrementing and are retried on the next loop; fix the consumer, do not delete rows.
3. Scale workers (two relay instances are safe thanks to `SKIP LOCKED`).
