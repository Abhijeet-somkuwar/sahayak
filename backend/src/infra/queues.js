/**
 * BullMQ queues on redis-core (§12.1). Producers use getQueue(name).add(...); workers live in src/apps/worker.ts.
 */
import { Queue } from 'bullmq';
import { bullConnection } from './redis.js';
import { currentTraceContext } from './otel.js';

export const QUEUE_NAMES = [
  'wa-inbound',
  'wa-status',
  'wa-outbound',
  'sms-outbound',
  'intake-step',
  'prebrief',
  'summary-rebuild',
  'notify-thresholds',
  'followup-dispatch',
  'kb-ingest',
  'patient-doc-extract',
];

/** Concurrency per process, attempts and backoff exactly as in §12.1. */
export const QUEUE_CONFIG = {
  'wa-inbound': { concurrency: 32, attempts: 5, backoff: { type: 'exponential', delay: 1_000 } },
  'wa-status': { concurrency: 32, attempts: 3, backoff: { type: 'exponential', delay: 1_000 } },
  'wa-outbound': { concurrency: 16, attempts: 8, backoff: { type: 'exponential', delay: 2_000 } }, // + jitter via BullMQ settings
  'sms-outbound': { concurrency: 8, attempts: 5, backoff: { type: 'exponential', delay: 5_000 } },
  'intake-step': { concurrency: 32, attempts: 2, backoff: { type: 'fixed', delay: 500 } },
  prebrief: { concurrency: 8, attempts: 2, backoff: { type: 'exponential', delay: 2_000 } },
  'summary-rebuild': { concurrency: 8, attempts: 5, backoff: { type: 'exponential', delay: 1_000 } },
  'notify-thresholds': { concurrency: 8, attempts: 3, backoff: { type: 'fixed', delay: 1_000 } },
  'followup-dispatch': { concurrency: 8, attempts: 5, backoff: { type: 'exponential', delay: 30_000 } },
  'kb-ingest': { concurrency: 2, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
  'patient-doc-extract': { concurrency: 4, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
};

const queues = new Map();

export function getQueue(name) {
  let q = queues.get(name);
  if (!q) {
    const cfg = QUEUE_CONFIG[name];
    q = new Queue(name, {
      connection: bullConnection(),
      defaultJobOptions: {
        attempts: cfg.attempts,
        backoff: cfg.backoff,
        removeOnComplete: { age: 3_600, count: 10_000 },
        removeOnFail: { age: 7 * 86_400 },
      },
    });
    queues.set(name, q);
  }
  return q;
}

/** BullMQ forbids ':' in custom job ids; the spec's `<a>:<b>` dedupe keys are written with '_' instead (same uniqueness). */
export function jobId(key) {
  return key.replace(/:/g, '_');
}

/** Add a job carrying the current trace context. `jobId` is the dedupe key (§12.1). */
export async function enqueue(name, jobName, data, opts) {
  await getQueue(name).add(jobName, { ...data, _trace: currentTraceContext() }, { ...opts, jobId: jobId(opts.jobId) });
}

export async function closeQueues() {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
}
