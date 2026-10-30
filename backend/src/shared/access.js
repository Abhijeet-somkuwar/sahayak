/**
 * 🔒 Care relationship and break-glass (§9.1 layer 3).
 * A clinician may read a patient's clinical history only if the patient has an encounter today in the
 * clinician's queue, or had one at the clinician's facility in the last 30 days. Otherwise break-glass.
 */
import { sql } from 'kysely';

import { redisCore, keys } from '../infra/redis.js';
import { breakglass as breakglassMetric } from '../infra/metrics.js';
import { AppError } from './errors.js';
import { boundaryDaysAgo } from './ids.js';
import { istDate } from './time.js';

export async function hasBreakGlass(userId, patientId) {
  return (await redisCore.exists(keys.breakglass(userId, patientId))) === 1;
}

/** Returns the purpose under which access is granted, or throws care_relationship_required. */
export async function assertClinicalAccess(trx, staff, patientId, audit) {
  if (staff.stateScope) return 'treatment'; // state-level roles reach here only via audit.read routes, which do not call this
  if (await hasBreakGlass(staff.userId, patientId)) {
    audit?.record({ action: 'patient.clinical.read', resourceType: 'patient', resourceId: patientId, patientId, purpose: 'breakglass' });
    return 'breakglass';
  }
  const departmentIds = staff.memberships.map((m) => m.d).filter((d) => !!d);
  const today = istDate();
  // Today's encounter in the clinician's queue (their department(s), or assigned to them).
  const todayHit = await trx
    .selectFrom('encounters')
    .select('id')
    .where('patient_id', '=', patientId)
    .where('session_date', '=', today)
    .where((eb) =>
      eb.or([
        eb('doctor_user_id', '=', staff.userId),
        ...(departmentIds.length ? [eb('department_id', 'in', departmentIds)] : []),
        ...(departmentIds.length === 0 ? [eb('facility_id', 'in', staff.facilityIds)] : []),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  if (todayHit) return 'treatment';
  // Encounter at one of the clinician's facilities in the last 30 days (RLS already limits facilities; bound prunes partitions).
  const recent = await trx
    .selectFrom('encounters')
    .select('id')
    .where('patient_id', '=', patientId)
    .where('id', '>=', boundaryDaysAgo(30))
    .where('facility_id', 'in', staff.facilityIds.length ? staff.facilityIds : [sql.lit('00000000-0000-0000-0000-000000000000')])
    .limit(1)
    .executeTakeFirst();
  if (recent) return 'treatment';
  throw new AppError('care_relationship_required', 'no care relationship with this patient; use break-glass with a reason');
}

/** Opens a 4-hour break-glass grant. The caller records the audit row with purpose 'breakglass'. */
export async function openBreakGlass(userId, patientId, reason) {
  if (reason.trim().length < 10) throw AppError.validation('break-glass reason must be at least 10 characters');
  const ttl = 4 * 3600;
  await redisCore.set(keys.breakglass(userId, patientId), JSON.stringify({ reason, at: new Date().toISOString() }), 'EX', ttl);
  breakglassMetric.inc();
  return { expiresAt: new Date(Date.now() + ttl * 1000) };
}
