/** worker role (§4.2, §12.1): BullMQ consumers plus the outbox relay. */
process.env['SAHAYAK_ROLE'] = 'worker';
import { startTelemetry } from '../infra/otel.js';
await startTelemetry('worker');
const { Worker } = await import('bullmq');
const { bullConnection, closeRedis } = await import('../infra/redis.js');
const { QUEUE_CONFIG, closeQueues } = await import('../infra/queues.js');
const { bullmqFailed, bullmqJobDuration, bullmqWaiting } = await import('../infra/metrics.js');
const { logger } = await import('../infra/logger.js');
const { registerShutdown } = await import('../server.js');
const { closeDatabase } = await import('../infra/db.js');
const { ensureBucket } = await import('../infra/storage.js');
const { startOutboxRelay } = await import('./outbox.js');
const { runWaInbound, runWaStatus } = await import('../modules/whatsapp/jobs.js');
const { runWaOutbound, runSmsOutbound, runNotifyThresholds } = await import('../modules/notifications/jobs.js');
const { runPrebriefGenerate } = await import('../modules/prebrief/jobs.js');
const { runSummaryRebuild } = await import('../modules/patients/jobs.js');
const { runFollowupDispatch } = await import('../modules/followups/jobs.js');
const { runKbIngest } = await import('../modules/kb/jobs.js');
const { runPatientDocExtract } = await import('../modules/patientdocs/jobs.js');
const { getQueue } = await import('../infra/queues.js');

await ensureBucket();

const processors = {
  'wa-inbound': (job, token) => runWaInbound(job, token),
  'wa-status': (job) => runWaStatus(job.data),
  'wa-outbound': (job) => runWaOutbound(job.data),
  'sms-outbound': (job) => runSmsOutbound(job.data),
  'intake-step': async () => undefined, // reserved: deferred intake continuations (voice-note transcription)
  prebrief: (job) => runPrebriefGenerate(job.data),
  'summary-rebuild': (job) => runSummaryRebuild(job.data),
  'notify-thresholds': (job) => runNotifyThresholds(job.data),
  'followup-dispatch': (job) => runFollowupDispatch(job.data),
  'kb-ingest': (job) => runKbIngest(job.data),
  'patient-doc-extract': (job) => runPatientDocExtract(job.data),
};

const workers = Object.keys(processors).map((name) => {
  const w = new Worker(
    name,
    async (job, token) => {
      const end = bullmqJobDuration.startTimer({ queue: name });
      try {
        return await processors[name](job, token);
      } finally {
        end();
      }
    },
    {
      connection: bullConnection(),
      concurrency: QUEUE_CONFIG[name].concurrency,
      ...(name === 'wa-outbound' ? { limiter: { max: Number(process.env['WA_RATE_PER_SECOND'] ?? 80), duration: 1000 } } : {}), // per sending number tier
      settings: { backoffStrategy: (attempts) => Math.round(2 ** attempts * 1000 * (0.5 + Math.random())) }, // exponential + jitter
    },
  );
  w.on('failed', (job, err) => {
    if (err?.name !== 'DelayedError') {
      bullmqFailed.inc({ queue: name });
      logger.warn({ queue: name, jobId: job?.id, err: err.message }, 'job failed');
    }
  });
  w.on('error', (err) => logger.warn({ queue: name, err }, 'worker error'));
  return w;
});

const gauge = setInterval(async () => {
  for (const name of Object.keys(processors)) {
    try {
      bullmqWaiting.set({ queue: name }, await getQueue(name).getWaitingCount());
    } catch {
      /* ignore */
    }
  }
}, 15_000);

const relay = startOutboxRelay();
logger.info({ queues: Object.keys(processors) }, 'worker started');
registerShutdown(async () => {
  clearInterval(gauge);
  relay.stop();
  await Promise.allSettled(workers.map((w) => w.close()));
  await closeQueues();
  await closeRedis();
  await closeDatabase();
});
