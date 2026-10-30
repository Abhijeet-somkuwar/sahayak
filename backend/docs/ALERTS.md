# Alerts and dashboards (§15)

All metrics are exposed at `GET /api/v1/metrics` (Prometheus text format) by every process role.

| Alert | Expression (PromQL sketch) | Severity | Runbook |
|---|---|---|---|
| Check-in SLO burn | `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{route="/api/v1/queues/:sessionId/checkins"}[5m])) > 0.3` | page | queue-projection-rebuild.md |
| Position read SLO burn | p99 of `route="/api/v1/t/:publicRef"` > 50 ms for 5 m | page | redis-failover.md |
| Outbox lag | `outbox_lag_seconds > 10` for 2 m | page | outbox-lag.md |
| Missing partitions | `partitions_future_count < 2` | page | missing-partitions.md |
| Webhook latency | p99 `wa_webhook_duration_seconds` > 0.5 s | warn | whatsapp-outage.md |
| LLM fallback rate | `sum(rate(llm_fallbacks_total[10m])) / sum(rate(llm_call_duration_seconds_count[10m])) > 0.2` | warn | llm-outage.md |
| Projection rebuilds | `increase(queue_projection_rebuilds_total[1h]) > 5` | warn | queue-projection-rebuild.md |
| Audit write failures | `increase(audit_write_failures_total[5m]) > 0` | page | security-incident.md |
| redis-core memory | > 70% of maxmemory | page | redis-failover.md |
| Replication lag | > 10 s | page | postgres-failover.md |
| KB recall drop | `kb_eval_recall_at_5 < 0.9` or −5 points vs previous run (logged as `ALERT kb recall@5`) | warn | — (re-run `POST /kb/eval/run`, review documents) |
| Break-glass | `increase(breakglass_total[1d]) > 0` → DPO review queue | info | data-principal-requests.md |

Dashboards: queue operations per facility (`queue_*`), WhatsApp funnel (`wa_inbound_total` → `intake_sessions_total` → `queue_checkins_total`),
AI health (`llm_*`, `kb_answers_total`), database health (`pg_pool_wait_seconds`, `partitions_future_count`, `bullmq_*`).
