import { sql } from 'kysely';

export const analyticsRepo = {
  /** Q16 — wait-time statistics per department and day. */
  rollupTokens: (trx, statDate, isFinal) =>
    sql`
    -- query: Q16
    INSERT INTO facility_daily_stats AS s
      (facility_id, department_id, stat_date, checked_in, seen, no_shows,
       wait_p50_seconds, wait_p90_seconds, consult_p50_seconds, computed_at, is_final)
    SELECT qs.facility_id, qs.department_id, qs.session_date,
           count(*),
           count(*) FILTER (WHERE t.status = 'completed'),
           count(*) FILTER (WHERE t.status = 'no_show'),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.called_at - t.queue_entry_at))::int,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM t.called_at - t.queue_entry_at))::int,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.consult_ended_at - t.consult_started_at))::int,
           now(), ${isFinal}
    FROM opd_tokens t
    JOIN queue_sessions qs ON qs.id = t.queue_session_id
    WHERE t.session_date = ${statDate}
    GROUP BY qs.facility_id, qs.department_id, qs.session_date
    ON CONFLICT (facility_id, department_id, stat_date) DO UPDATE
    SET checked_in = EXCLUDED.checked_in,
        seen = EXCLUDED.seen,
        no_shows = EXCLUDED.no_shows,
        wait_p50_seconds = EXCLUDED.wait_p50_seconds,
        wait_p90_seconds = EXCLUDED.wait_p90_seconds,
        consult_p50_seconds = EXCLUDED.consult_p50_seconds,
        computed_at = now(),
        is_final = EXCLUDED.is_final
    WHERE NOT s.is_final`.execute(trx),

  /** Second statement: registrations, LWBS, triage mix, overrides, AI fallbacks from encounters / triage_assessments / intake_sessions. */
  rollupEncounters: (trx, statDate, isFinal) =>
    sql`
    INSERT INTO facility_daily_stats AS s
      (facility_id, department_id, stat_date, registrations, left_without_being_seen,
       triage_emergency, triage_priority, triage_routine, triage_self_care, triage_overrides, ai_fallback_count, computed_at, is_final)
    SELECT e.facility_id, e.department_id, e.session_date,
           count(*),
           count(*) FILTER (WHERE e.status = 'left_without_being_seen'),
           count(*) FILTER (WHERE ta.final_level = 'emergency'),
           count(*) FILTER (WHERE ta.final_level = 'priority'),
           count(*) FILTER (WHERE ta.final_level = 'routine'),
           count(*) FILTER (WHERE ta.final_level = 'self_care'),
           count(*) FILTER (WHERE ta.overridden_by IS NOT NULL),
           count(*) FILTER (WHERE i.mode = 'structured_fallback' OR ta.mode = 'structured_fallback'),
           now(), ${isFinal}
    FROM encounters e
    LEFT JOIN triage_assessments ta ON ta.encounter_id = e.id
    LEFT JOIN intake_sessions i ON i.encounter_id = e.id
    WHERE e.session_date = ${statDate} AND e.department_id IS NOT NULL
    GROUP BY e.facility_id, e.department_id, e.session_date
    ON CONFLICT (facility_id, department_id, stat_date) DO UPDATE
    SET registrations = EXCLUDED.registrations,
        left_without_being_seen = EXCLUDED.left_without_being_seen,
        triage_emergency = EXCLUDED.triage_emergency, triage_priority = EXCLUDED.triage_priority,
        triage_routine = EXCLUDED.triage_routine, triage_self_care = EXCLUDED.triage_self_care,
        triage_overrides = EXCLUDED.triage_overrides, ai_fallback_count = EXCLUDED.ai_fallback_count,
        computed_at = now(), is_final = EXCLUDED.is_final
    WHERE NOT s.is_final`.execute(trx),

  /** Hourly arrival curve (IST hour) from opd_tokens.queue_entry_at. */
  rollupHourly: (trx, statDate) =>
    sql`
    INSERT INTO facility_hourly_arrivals (facility_id, department_id, stat_date, hour, arrivals)
    SELECT qs.facility_id, qs.department_id, t.session_date, extract(hour FROM t.queue_entry_at AT TIME ZONE 'Asia/Kolkata')::smallint, count(*)
    FROM opd_tokens t JOIN queue_sessions qs ON qs.id = t.queue_session_id
    WHERE t.session_date = ${statDate}
    GROUP BY 1, 2, 3, 4
    ON CONFLICT (facility_id, department_id, stat_date, hour) DO UPDATE SET arrivals = EXCLUDED.arrivals`.execute(trx),

  daily: (trx, facilityId, from, to) =>
    trx
      .selectFrom('facility_daily_stats')
      .selectAll()
      .where('facility_id', '=', facilityId)
      .where('stat_date', '>=', from)
      .where('stat_date', '<=', to)
      .orderBy('stat_date')
      .orderBy('department_id')
      .execute(),
  hourly: (trx, facilityId, from, to) =>
    trx
      .selectFrom('facility_hourly_arrivals')
      .selectAll()
      .where('facility_id', '=', facilityId)
      .where('stat_date', '>=', from)
      .where('stat_date', '<=', to)
      .orderBy('stat_date')
      .orderBy('hour')
      .execute(),
  stateDaily: (trx, from, to) =>
    trx
      .selectFrom('facility_daily_stats as s')
      .innerJoin('facilities as f', 'f.id', 's.facility_id')
      .select([
        's.facility_id',
        'f.name as facility_name',
        'f.district_code',
        's.stat_date',
        (eb) => eb.fn.sum('s.registrations').as('registrations'),
        (eb) => eb.fn.sum('s.checked_in').as('checked_in'),
        (eb) => eb.fn.sum('s.seen').as('seen'),
        (eb) => eb.fn.sum('s.no_shows').as('no_shows'),
        (eb) => eb.fn.sum('s.left_without_being_seen').as('lwbs'),
        (eb) => eb.fn.sum('s.triage_emergency').as('triage_emergency'),
        (eb) => eb.fn.sum('s.ai_fallback_count').as('ai_fallback_count'),
        (eb) => eb.fn.avg('s.wait_p50_seconds').as('wait_p50_seconds'),
      ])
      .where('s.stat_date', '>=', from)
      .where('s.stat_date', '<=', to)
      .groupBy(['s.facility_id', 'f.name', 'f.district_code', 's.stat_date'])
      .orderBy('s.stat_date')
      .execute(),
  /** Expected arrivals for a slot: average of the same weekday and hour over the last 4 weeks. */
  expectedArrivals: (trx, facilityId, departmentId, weekday, hour) =>
    sql`
      SELECT coalesce(avg(arrivals), 0)::float AS expected FROM facility_hourly_arrivals
      WHERE facility_id = ${facilityId} AND department_id = ${departmentId} AND hour = ${hour}
        AND extract(isodow FROM stat_date) = ${weekday} AND stat_date >= current_date - 28`
      .execute(trx)
      .then((r) => r.rows[0]?.expected ?? 0),
};
