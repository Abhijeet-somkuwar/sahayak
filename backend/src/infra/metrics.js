/**
 * Prometheus metrics (§15).
 */
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'sahayak_' });

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['route', 'method', 'status'],
  buckets,
  registers: [registry],
});

export const queueCheckins = new client.Counter({
  name: 'queue_checkins_total',
  help: 'Check-ins',
  labelNames: ['facility', 'department'],
  registers: [registry],
});
export const queueCallNextDuration = new client.Histogram({
  name: 'queue_call_next_duration_seconds',
  help: 'Call-next duration',
  buckets,
  registers: [registry],
});
export const queueWaitingTokens = new client.Gauge({
  name: 'queue_waiting_tokens',
  help: 'Waiting tokens',
  labelNames: ['facility', 'department', 'lane'],
  registers: [registry],
});
export const queueWaitSeconds = new client.Histogram({
  name: 'queue_wait_seconds',
  help: 'Wait time at call',
  buckets: [60, 300, 600, 900, 1800, 2700, 3600, 5400, 7200, 10800],
  registers: [registry],
});
export const queueProjectionRebuilds = new client.Counter({
  name: 'queue_projection_rebuilds_total',
  help: 'Redis queue read-model rebuilds',
  registers: [registry],
});

export const intakeSessions = new client.Counter({
  name: 'intake_sessions_total',
  help: 'Intake sessions',
  labelNames: ['channel', 'mode', 'outcome'],
  registers: [registry],
});
export const intakeStepDuration = new client.Histogram({
  name: 'intake_step_duration_seconds',
  help: 'Intake step duration',
  labelNames: ['step'],
  buckets,
  registers: [registry],
});
export const triageLevel = new client.Counter({
  name: 'triage_level_total',
  help: 'Triage outcomes',
  labelNames: ['level', 'routing_method'],
  registers: [registry],
});
export const triageOverrides = new client.Counter({
  name: 'triage_overrides_total',
  help: 'Triage overrides',
  labelNames: ['direction'],
  registers: [registry],
});

export const llmCallDuration = new client.Histogram({
  name: 'llm_call_duration_seconds',
  help: 'LLM call duration',
  labelNames: ['purpose', 'model', 'outcome'],
  buckets,
  registers: [registry],
});
export const llmTokens = new client.Counter({
  name: 'llm_tokens_total',
  help: 'LLM tokens',
  labelNames: ['purpose', 'model', 'kind'],
  registers: [registry],
});
export const llmFallbacks = new client.Counter({
  name: 'llm_fallbacks_total',
  help: 'LLM fallbacks',
  labelNames: ['purpose', 'reason'],
  registers: [registry],
});
export const kbAnswers = new client.Counter({
  name: 'kb_answers_total',
  help: 'KB answers by path',
  labelNames: ['path'],
  registers: [registry],
});
export const kbEvalRecall = new client.Gauge({
  name: 'kb_eval_recall_at_5',
  help: 'KB eval recall@5',
  labelNames: ['facility', 'language'],
  registers: [registry],
});

export const waWebhookDuration = new client.Histogram({
  name: 'wa_webhook_duration_seconds',
  help: 'WhatsApp webhook duration',
  buckets,
  registers: [registry],
});
export const waInbound = new client.Counter({ name: 'wa_inbound_total', help: 'WhatsApp inbound messages', registers: [registry] });
export const waOutbound = new client.Counter({
  name: 'wa_outbound_total',
  help: 'WhatsApp outbound messages',
  labelNames: ['status'],
  registers: [registry],
});
export const waTemplateFallback = new client.Counter({
  name: 'wa_template_fallback_total',
  help: 'Outside-window template fallbacks',
  registers: [registry],
});
export const waSignatureFailures = new client.Counter({
  name: 'wa_signature_failures_total',
  help: 'Webhook signature mismatches',
  registers: [registry],
});

export const bullmqWaiting = new client.Gauge({
  name: 'bullmq_waiting',
  help: 'Waiting jobs',
  labelNames: ['queue'],
  registers: [registry],
});
export const bullmqJobDuration = new client.Histogram({
  name: 'bullmq_job_duration_seconds',
  help: 'Job duration',
  labelNames: ['queue'],
  buckets,
  registers: [registry],
});
export const bullmqFailed = new client.Counter({
  name: 'bullmq_failed_total',
  help: 'Failed jobs',
  labelNames: ['queue'],
  registers: [registry],
});
export const outboxLag = new client.Gauge({
  name: 'outbox_lag_seconds',
  help: 'Age of the oldest unpublished outbox event',
  registers: [registry],
});
export const pgPoolWait = new client.Histogram({
  name: 'pg_pool_wait_seconds',
  help: 'Time waiting for a pg connection',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});
export const partitionsFuture = new client.Gauge({
  name: 'partitions_future_count',
  help: 'Future monthly partitions per table',
  labelNames: ['table'],
  registers: [registry],
});

export const auditWriteFailures = new client.Counter({
  name: 'audit_write_failures_total',
  help: 'Audit insert failures',
  registers: [registry],
});
export const breakglass = new client.Counter({ name: 'breakglass_total', help: 'Break-glass accesses', registers: [registry] });
export const auditRows = new client.Counter({
  name: 'audit_rows_total',
  help: 'Audit rows written',
  labelNames: ['action'],
  registers: [registry],
});

export async function renderMetrics() {
  return registry.metrics();
}
