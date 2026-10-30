/**
 * Scheduled queue jobs (§12.2): queue-sessions-create (daily 20:00 IST) and queue-reconcile (every 60 s, 07:00–20:00).
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import { addDays, istDate, istDateTime } from '../../shared/time.js';
import { facilitiesRepo } from '../facilities/repo.js';
import { getFacilityConfig } from '../facilities/service.js';
import { queueRepo } from './repo.js';
import { reconcileSession, refreshActiveServers } from './projection.js';
import { queueService } from './service.js';

/** Next day's sessions from doctor_schedules and overrides (§9.5.1). */
export async function createNextDaySessions(date = addDays(istDate(), 1)) {
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return withScope(STATE_SCOPE, async (trx) => {
    const [schedules, overrides] = await Promise.all([
      facilitiesRepo.allSchedulesForDate(trx, date, weekday),
      facilitiesRepo.allOverridesForDate(trx, date),
    ]);
    const onLeave = new Set(overrides.filter((o) => o.kind === 'leave').map((o) => o.user_id));
    const groups = new Map();
    for (const s of schedules) {
      if (onLeave.has(s.user_id)) continue;
      const k = `${s.department_id}|${s.shift}`;
      groups.set(k, [...(groups.get(k) ?? []), s]);
    }
    let created = 0;
    for (const [, group] of groups) {
      const first = group[0];
      const starts = group.map((g) => g.starts_at).sort()[0];
      const ends = group
        .map((g) => g.ends_at)
        .sort()
        .at(-1);
      const cfg = await getFacilityConfig(first.facility_id).catch(() => null);
      const row = await queueRepo.insertSession(trx, {
        facility_id: first.facility_id,
        department_id: first.department_id,
        session_date: date,
        shift: first.shift,
        token_prefix: first.token_prefix,
        lane_ratio: cfg?.opd.lane_ratio ?? [1, 2],
        starts_at: istDateTime(date, starts),
        ends_at: istDateTime(date, ends),
        capacity: null,
      });
      if (row) created++;
    }
    logger.info({ date, created }, 'queue sessions created');
    return created;
  });
}

/** Reconcile every open session's Redis read model with Postgres (§8.4). */
export async function reconcileOpenSessions() {
  const sessions = await withScope(STATE_SCOPE, (trx) => queueRepo.openSessions(trx));
  let rebuilt = 0;
  for (const s of sessions) {
    try {
      if (await reconcileSession(s.id, s.facility_id, s.department_id)) rebuilt++;
      const doctors = await withScope(STATE_SCOPE, (trx) =>
        trx.selectFrom('doctor_schedules').select('user_id').where('department_id', '=', s.department_id).execute(),
      );
      await refreshActiveServers(
        s.id,
        doctors.map((d) => d.user_id),
      );
    } catch (err) {
      logger.warn({ err, qs: s.id }, 'reconcile failed');
    }
  }
  return rebuilt;
}

/** Close sessions whose end time passed (safety net; staff normally close explicitly). */
export async function autoCloseExpiredSessions() {
  const sessions = await withScope(STATE_SCOPE, (trx) => queueRepo.sessionsEndingBefore(trx, new Date(Date.now() - 2 * 3600_000)));
  let n = 0;
  for (const s of sessions) {
    await withScope(STATE_SCOPE, (trx) => queueService.closeSession(trx, s.id, {}));
    n++;
  }
  return n;
}
