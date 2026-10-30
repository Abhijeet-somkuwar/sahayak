import { sql } from 'kysely';

import { toJson } from '../../infra/db.types.js';
import { newId } from '../../shared/ids.js';

export const facilitiesRepo = {
  byId: (trx, id) => trx.selectFrom('facilities').selectAll().where('id', '=', id).executeTakeFirst(),
  byCode: (trx, code) =>
    trx.selectFrom('facilities').selectAll().where('code', '=', code).where('status', '=', 'active').executeTakeFirst(),
  list: (trx) => trx.selectFrom('facilities').selectAll().where('status', '=', 'active').orderBy('name').execute(),
  async create(trx, row) {
    return trx
      .insertInto('facilities')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow();
  },
  async update(trx, id, patch) {
    return trx.updateTable('facilities').set(patch).where('id', '=', id).returningAll().executeTakeFirst();
  },
  /** Up to 5 nearest active facilities (haversine on stored coordinates). */
  nearby: (trx, lat, lng, limit = 5) =>
    sql`
      SELECT id, code, name, name_i18n, kind, district_code,
             (6371 * acos(least(1.0, cos(radians(${lat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${lng}))
                                 + sin(radians(${lat})) * sin(radians(latitude))))) AS distance_km
      FROM facilities
      WHERE status = 'active' AND latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY distance_km
      LIMIT ${limit}`
      .execute(trx)
      .then((r) => r.rows),

  departments: (trx, facilityId, includeInactive = false) => {
    let q = trx.selectFrom('departments').selectAll().where('facility_id', '=', facilityId);
    if (!includeInactive) q = q.where('status', '=', 'active');
    return q.orderBy('display_order').orderBy('name').execute();
  },
  departmentById: (trx, id) => trx.selectFrom('departments').selectAll().where('id', '=', id).executeTakeFirst(),
  /** Routing: the facility's active department with that specialty (uses departments_routing_idx). */
  departmentBySpecialty: (trx, facilityId, specialty) =>
    trx
      .selectFrom('departments')
      .selectAll()
      .where('facility_id', '=', facilityId)
      .where('specialty_code', '=', specialty)
      .where('status', '=', 'active')
      .where('accepts_routing', '=', true)
      .orderBy('display_order')
      .executeTakeFirst(),
  emergencyDepartment: (trx, facilityId) =>
    trx
      .selectFrom('departments')
      .selectAll()
      .where('facility_id', '=', facilityId)
      .where('is_emergency', '=', true)
      .where('status', '=', 'active')
      .executeTakeFirst(),
  createDepartment: (trx, row) =>
    trx
      .insertInto('departments')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  updateDepartment: (trx, id, facilityId, patch) =>
    trx.updateTable('departments').set(patch).where('id', '=', id).where('facility_id', '=', facilityId).returningAll().executeTakeFirst(),

  servicePoints: (trx, facilityId, includeInactive = false) => {
    let q = trx.selectFrom('service_points').selectAll().where('facility_id', '=', facilityId);
    if (!includeInactive) q = q.where('status', '=', 'active');
    return q.orderBy('label').execute();
  },
  servicePointById: (trx, id) => trx.selectFrom('service_points').selectAll().where('id', '=', id).executeTakeFirst(),
  createServicePoint: (trx, row) =>
    trx
      .insertInto('service_points')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  updateServicePoint: (trx, id, facilityId, patch) =>
    trx
      .updateTable('service_points')
      .set(patch)
      .where('id', '=', id)
      .where('facility_id', '=', facilityId)
      .returningAll()
      .executeTakeFirst(),

  schedules: (trx, facilityId) =>
    trx.selectFrom('doctor_schedules').selectAll().where('facility_id', '=', facilityId).orderBy('weekday').orderBy('starts_at').execute(),
  /** Schedules effective on a date for the facility, with overrides for that date. */
  schedulesForDate: (trx, facilityId, date, weekday) =>
    trx
      .selectFrom('doctor_schedules')
      .selectAll()
      .where('facility_id', '=', facilityId)
      .where('weekday', '=', weekday)
      .where('effective_from', '<=', date)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>=', date)]))
      .execute(),
  overridesForDate: (trx, facilityId, date) =>
    trx.selectFrom('doctor_schedule_overrides').selectAll().where('facility_id', '=', facilityId).where('on_date', '=', date).execute(),
  createSchedule: (trx, row) =>
    trx
      .insertInto('doctor_schedules')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  deleteSchedule: (trx, id, facilityId) =>
    trx.deleteFrom('doctor_schedules').where('id', '=', id).where('facility_id', '=', facilityId).executeTakeFirst(),
  createOverride: (trx, row) =>
    trx
      .insertInto('doctor_schedule_overrides')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  /** Schedules that run on a given date, across all facilities (for the nightly session job). */
  allSchedulesForDate: (trx, date, weekday) =>
    trx
      .selectFrom('doctor_schedules as s')
      .innerJoin('departments as d', 'd.id', 's.department_id')
      .select([
        's.id',
        's.facility_id',
        's.department_id',
        's.user_id',
        's.shift',
        's.starts_at',
        's.ends_at',
        'd.token_prefix',
        'd.default_consult_seconds',
      ])
      .where('s.weekday', '=', weekday)
      .where('s.effective_from', '<=', date)
      .where((eb) => eb.or([eb('s.effective_to', 'is', null), eb('s.effective_to', '>=', date)]))
      .where('d.status', '=', 'active')
      .execute(),
  allOverridesForDate: (trx, date) => trx.selectFrom('doctor_schedule_overrides').selectAll().where('on_date', '=', date).execute(),
};

export { toJson };
