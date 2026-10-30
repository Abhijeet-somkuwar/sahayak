# Runbooks (§14.7)

| Runbook | When |
|---|---|
| [queue-projection-rebuild.md](queue-projection-rebuild.md) | Positions on displays / status pages disagree with the counter; reconcile alerts |
| [redis-failover.md](redis-failover.md) | redis-core primary lost; Sentinel failover; cache cold |
| [postgres-failover.md](postgres-failover.md) | Primary failover; ~30 s of write errors |
| [llm-outage.md](llm-outage.md) | Provider errors, circuit open, budget exhausted; turning AI off per facility |
| [whatsapp-outage.md](whatsapp-outage.md) | Cloud API 5xx/429 storm; template rejections |
| [missing-partitions.md](missing-partitions.md) | `partitions_future_count < 2` |
| [outbox-lag.md](outbox-lag.md) | `outbox_lag_seconds > 10` |
| [security-incident.md](security-incident.md) | CERT-In 6-hour reporting, DPDP notifications |
| [data-principal-requests.md](data-principal-requests.md) | Access / correction / erasure requests, break-glass review |
| [restore-drill.md](restore-drill.md) | Monthly PITR restore into staging |
