/** scheduler role (§4.2, §12.2): repeatable jobs in IST; single active instance via a Redis leader lock. */
process.env['SAHAYAK_ROLE'] = 'scheduler';
import { startTelemetry } from '../infra/otel.js';
await startTelemetry('scheduler');
const { Cron } = await import('croner');
const { redisCore, keys, closeRedis } = await import('../infra/redis.js');
const { randomToken } = await import('../infra/crypto.js');
const { logger } = await import('../infra/logger.js');
const { registerShutdown } = await import('../server.js');
const { closeDatabase } = await import('../infra/db.js');
const { closeQueues } = await import('../infra/queues.js');
const { ensurePartitions, runRetention } = await import('../infra/partitions.js');
const { createNextDaySessions, reconcileOpenSessions, autoCloseExpiredSessions } = await import('../modules/queue/jobs.js');
const { runStatsRollup } = await import('../modules/analytics/jobs.js');
const { runFollowupSweep } = await import('../modules/followups/jobs.js');
const { runIntakeExpiry } = await import('../modules/intake/jobs.js');
const { runAuditDigest } = await import('../modules/audit/jobs.js');
const { runKbEval } = await import('../modules/kb/jobs.js');
const { runTemplateSync } = await import('../modules/whatsapp/jobs.js');
const { istHour } = await import('../shared/time.js');

const owner = randomToken(16);
let leader = false;
async function renewLeadership() {
  const got = await redisCore.set(keys.lockLeader, owner, 'EX', 30, 'NX');
  if (got === 'OK') {
    if (!leader) logger.info('scheduler became leader');
    leader = true;
    return;
  }
  const cur = await redisCore.get(keys.lockLeader);
  if (cur === owner) {
    await redisCore.expire(keys.lockLeader, 30);
    leader = true;
  } else {
    if (leader) logger.warn('scheduler lost leadership');
    leader = false;
  }
}
await renewLeadership();
const renew = setInterval(() => void renewLeadership().catch((err) => logger.warn({ err }, 'leader renew failed')), 10_000);

const TZ = 'Asia/Kolkata';
const job = (name, pattern, fn, opts = {}) =>
  new Cron(pattern, { timezone: TZ, protect: true }, async () => {
    if (!leader) return;
    if (opts.onlyBetweenHours) {
      const h = istHour();
      if (h < opts.onlyBetweenHours[0] || h >= opts.onlyBetweenHours[1]) return;
    }
    const started = Date.now();
    try {
      const r = await fn();
      logger.info({ job: name, ms: Date.now() - started, result: r }, 'scheduled job done');
    } catch (err) {
      logger.error({ job: name, err }, 'scheduled job failed');
    }
  });

const jobs = [
  job('partition-maintenance', '10 2 * * *', () => ensurePartitions(1, 3)),
  job('retention', '10 3 * * *', () => runRetention()),
  job('queue-sessions-create', '0 20 * * *', () => createNextDaySessions()),
  job('queue-reconcile', '* * * * *', () => reconcileOpenSessions(), { onlyBetweenHours: [7, 20] }),
  job('queue-autoclose', '15 * * * *', () => autoCloseExpiredSessions()),
  job('stats-rollup', '*/15 * * * *', () => runStatsRollup({ final: false })),
  job('stats-rollup-final', '0 1 * * *', () => runStatsRollup({ final: true })),
  job('followup-sweep', '*/5 * * * *', () => runFollowupSweep()),
  job('intake-expiry', '*/5 * * * *', () => runIntakeExpiry()),
  job('audit-digest', '5 * * * *', () => runAuditDigest()),
  job('kb-eval', '0 4 * * *', () => runKbEval()),
  job('template-sync', '0 */6 * * *', () => runTemplateSync()),
];

// Partitions are also ensured at start-up so a fresh deployment never lacks future months.
if (leader) await ensurePartitions(1, 3).catch((err) => logger.warn({ err }, 'startup partition check failed'));
logger.info({ jobs: jobs.length }, 'scheduler started');
registerShutdown(async () => {
  clearInterval(renew);
  for (const j of jobs) j.stop();
  if (leader) await redisCore.releaseLock(keys.lockLeader, owner).catch(() => {});
  await closeQueues();
  await closeRedis();
  await closeDatabase();
});
