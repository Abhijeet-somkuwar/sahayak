/**
 * Queue repo: Q4 (token allocation), Q5 (call next), Q15 (snapshot) exactly as in §7.2, token transitions with
 * optimistic locking, queue_events, token blocks, emergency pre-alerts, and the encounter lifecycle.
 */
import { sql } from 'kysely';

import { toJson } from '../../infra/db.types.js';
import { newId } from '../../shared/ids.js';

export const queueRepo = {
  // ---- sessions ----
  sessionById: (trx, id) => trx.selectFrom('queue_sessions').selectAll().where('id', '=', id).executeTakeFirst(),
  sessionFor: (trx, departmentId, date, shift) =>
    trx
      .selectFrom('queue_sessions')
      .selectAll()
      .where('department_id', '=', departmentId)
      .where('session_date', '=', date)
      .where('shift', '=', shift)
      .executeTakeFirst(),
  sessionsForDay: (trx, facilityId, date) =>
    trx
      .selectFrom('queue_sessions')
      .selectAll()
      .where('facility_id', '=', facilityId)
      .where('session_date', '=', date)
      .orderBy('starts_at')
      .execute(),
  openSessions: (trx) =>
    trx
      .selectFrom('queue_sessions')
      .select(['id', 'facility_id', 'department_id', 'status', 'starts_at', 'ends_at'])
      .where('status', 'in', ['open', 'paused'])
      .execute(),
  sessionsEndingBefore: (trx, at) =>
    trx
      .selectFrom('queue_sessions')
      .select(['id', 'facility_id'])
      .where('status', 'in', ['open', 'paused', 'scheduled'])
      .where('ends_at', '<', at)
      .execute(),
  insertSession: (trx, row) =>
    trx
      .insertInto('queue_sessions')
      .values({ ...row, id: newId() })
      .onConflict((oc) => oc.columns(['department_id', 'session_date', 'shift']).doNothing())
      .returningAll()
      .executeTakeFirst(),
  setSessionStatus: (trx, id, status, patch = {}) =>
    trx
      .updateTable('queue_sessions')
      .set({ status, ...patch })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst(),

  /** Q4 — allocate the next token number under the session row lock (D6). Zero rows → closed or full. */
  allocateTokenNo: (trx, sessionId) =>
    sql`
      -- query: Q4
      UPDATE queue_sessions
      SET last_token_no = last_token_no + 1
      WHERE id = ${sessionId}
        AND status IN ('scheduled', 'open')
        AND (capacity IS NULL OR last_token_no < capacity)
      RETURNING last_token_no AS token_no, token_prefix`
      .execute(trx)
      .then((r) => r.rows[0]),

  /** Q4 variant for offline blocks (§9.5.8): reserve a range of `size` numbers. */
  allocateBlock: (trx, sessionId, size) =>
    sql`
      UPDATE queue_sessions
      SET last_token_no = last_token_no + ${size}
      WHERE id = ${sessionId}
        AND status IN ('scheduled', 'open')
        AND (capacity IS NULL OR last_token_no + ${size} <= capacity)
      RETURNING last_token_no AS last_no, token_prefix`
      .execute(trx)
      .then((r) => r.rows[0]),

  insertTokenBlock: (trx, row) =>
    trx
      .insertInto('token_blocks')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  blocksForDevice: (trx, deviceId, sessionId) =>
    trx
      .selectFrom('token_blocks')
      .selectAll()
      .where('device_id', '=', deviceId)
      .where('queue_session_id', '=', sessionId)
      .where('released_at', 'is', null)
      .execute(),

  // ---- tokens ----
  insertToken: (trx, row) => trx.insertInto('opd_tokens').values(row).returningAll().executeTakeFirstOrThrow(),
  tokenById: (trx, id) => trx.selectFrom('opd_tokens').selectAll().where('id', '=', id).executeTakeFirst(),
  liveTokenForEncounter: (trx, encounterId) =>
    trx
      .selectFrom('opd_tokens')
      .selectAll()
      .where('encounter_id', '=', encounterId)
      .where('status', 'not in', ['transferred', 'cancelled'])
      .executeTakeFirst(),

  /** Q5 — call the next waiting token of a lane. SKIP LOCKED: two doctors never double-call. */
  callNext: (trx, sessionId, lane, doctorId, servicePointId) =>
    sql`
      -- query: Q5
      WITH next AS (
        SELECT id
        FROM opd_tokens
        WHERE queue_session_id = ${sessionId}
          AND status = 'waiting'
          AND lane = ${lane}
          AND (preferred_doctor_id IS NULL OR preferred_doctor_id = ${doctorId})
        ORDER BY queue_entry_at, token_no
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE opd_tokens t
      SET status = 'called',
          called_at = now(),
          call_count = t.call_count + 1,
          served_by = ${doctorId},
          service_point_id = ${servicePointId},
          version = t.version + 1
      FROM next
      WHERE t.id = next.id
      RETURNING t.id, t.encounter_id, t.display_code, t.lane, t.version`
      .execute(trx)
      .then((r) => r.rows[0]),

  /** Optimistic-lock transition: UPDATE ... WHERE id = $1 AND version = $2, version = version + 1. */
  transition: (trx, id, version, patch) =>
    trx
      .updateTable('opd_tokens')
      .set({ ...patch, version: version + 1 })
      .where('id', '=', id)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst(),

  /** Q15 — snapshot for rebuilding the Redis read model. */
  snapshot: (trx, sessionId) =>
    sql`
      -- query: Q15
      SELECT id, lane, queue_entry_at, token_no, status, display_code, served_by, service_point_id, version
      FROM opd_tokens
      WHERE queue_session_id = ${sessionId}
        AND status IN ('waiting', 'called', 'in_consult')`
      .execute(trx)
      .then((r) => r.rows),

  /** Index-only on opd_tokens_waiting_idx (§8.4 reconcile). */
  waitingCounts: (trx, sessionId) =>
    trx
      .selectFrom('opd_tokens')
      .select(['lane', (eb) => eb.fn.countAll().as('n')])
      .where('queue_session_id', '=', sessionId)
      .where('status', '=', 'waiting')
      .groupBy('lane')
      .execute(),

  /** Head of each lane (fallback when Redis is unavailable). */
  laneHeads: (trx, sessionId) =>
    sql`
      SELECT DISTINCT ON (lane) lane, id, queue_entry_at
      FROM opd_tokens WHERE queue_session_id = ${sessionId} AND status = 'waiting'
      ORDER BY lane, queue_entry_at, token_no`
      .execute(trx)
      .then((r) => r.rows),

  /** Position from Postgres (Redis unavailable): people in the same lane ahead of this token. */
  sqlPosition: (trx, token) =>
    sql`
      SELECT (SELECT count(*) FROM opd_tokens WHERE queue_session_id = ${token.queue_session_id} AND status = 'waiting' AND lane = ${token.lane}
                AND (queue_entry_at, token_no) < (${token.queue_entry_at}, ${token.token_no}))::int AS rank,
             (SELECT count(*) FROM opd_tokens WHERE queue_session_id = ${token.queue_session_id} AND status = 'waiting' AND lane = 0)::int AS urgent,
             (SELECT count(*) FROM opd_tokens WHERE queue_session_id = ${token.queue_session_id} AND status = 'waiting' AND lane = 1)::int AS protected_,
             (SELECT count(*) FROM opd_tokens WHERE queue_session_id = ${token.queue_session_id} AND status = 'waiting' AND lane = 2)::int AS general`
      .execute(trx)
      .then((r) => r.rows[0]),

  tokensByStatus: (trx, sessionId, statuses) =>
    trx.selectFrom('opd_tokens').selectAll().where('queue_session_id', '=', sessionId).where('status', 'in', statuses).execute(),
  activeTokensForDoctor: (trx, sessionId, doctorId) =>
    trx
      .selectFrom('opd_tokens')
      .selectAll()
      .where('queue_session_id', '=', sessionId)
      .where('served_by', '=', doctorId)
      .where('status', 'in', ['called', 'in_consult'])
      .execute(),
  nextWaitingCodes: (trx, sessionId, lane, limit) =>
    trx
      .selectFrom('opd_tokens')
      .select(['id', 'display_code', 'lane'])
      .where('queue_session_id', '=', sessionId)
      .where('status', '=', 'waiting')
      .where('lane', '=', lane)
      .orderBy('queue_entry_at')
      .orderBy('token_no')
      .limit(limit)
      .execute(),

  insertEvent: (trx, row) =>
    trx
      .insertInto('queue_events')
      .values({
        id: newId(),
        ...row,
        token_id: row.token_id ?? null,
        encounter_id: row.encounter_id ?? null,
        actor_user_id: row.actor_user_id ?? null,
        device_id: row.device_id ?? null,
        token_version: row.token_version ?? null,
        payload: toJson(row.payload ?? {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow(),

  // ---- emergency pre-alerts ----
  insertPrealert: (trx, row) =>
    trx
      .insertInto('emergency_prealerts')
      .values({ id: newId(), ...row, summary: toJson(row.summary) })
      .returningAll()
      .executeTakeFirstOrThrow(),
  openPrealerts: (trx, facilityId) =>
    trx
      .selectFrom('emergency_prealerts')
      .selectAll()
      .where('facility_id', '=', facilityId)
      .where('status', 'in', ['open', 'acknowledged'])
      .orderBy('created_at')
      .execute(),
  ackPrealert: (trx, id, userId) =>
    trx
      .updateTable('emergency_prealerts')
      .set({ status: 'acknowledged', acknowledged_by: userId, acknowledged_at: new Date() })
      .where('id', '=', id)
      .where('status', '=', 'open')
      .returningAll()
      .executeTakeFirst(),
  deleteOldPrealerts: (trx, before) => trx.deleteFrom('emergency_prealerts').where('created_at', '<', before).executeTakeFirst(),

  // ---- encounters ----
  insertEncounter: (trx, row) => trx.insertInto('encounters').values(row).returningAll().executeTakeFirstOrThrow(),
  encounterById: (trx, id) => trx.selectFrom('encounters').selectAll().where('id', '=', id).executeTakeFirst(),
  updateEncounter: (trx, id, version, patch) =>
    trx
      .updateTable('encounters')
      .set({ ...patch, version: version + 1 })
      .where('id', '=', id)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst(),
  /** Status-only update without a version check (system transitions such as session close). */
  setEncounterStatus: (trx, id, status, patch = {}) =>
    trx
      .updateTable('encounters')
      .set((eb) => ({ status, ...patch, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst(),
  /** Reporting window and other booking facts live in the hot intake_sessions row (7 days). */
  intakeFactsForEncounter: async (trx, encounterId) => {
    const r = await trx.selectFrom('intake_sessions').select('facts').where('encounter_id', '=', encounterId).executeTakeFirst();
    return r?.facts ?? {};
  },
  patientBasics: (trx, patientId) =>
    trx
      .selectFrom('patients')
      .select(['id', 'display_name', 'sex', 'birth_date', 'birth_year', 'preferred_language'])
      .where('id', '=', patientId)
      .executeTakeFirst(),
  activeConditionTexts: (trx, patientId) =>
    trx
      .selectFrom('conditions')
      .select(['display_text', 'code'])
      .where('patient_id', '=', patientId)
      .where('clinical_status', '=', 'active')
      .execute(),

  // ---- clinical children of an encounter (co-partitioned) ----
  insertObservation: (trx, row) =>
    trx
      .insertInto('observations')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  observations: (trx, encounterId) =>
    trx.selectFrom('observations').selectAll().where('encounter_id', '=', encounterId).orderBy('observed_at').execute(),
  insertDiagnosis: (trx, row) =>
    trx
      .insertInto('encounter_diagnoses')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  diagnoses: (trx, encounterId) => trx.selectFrom('encounter_diagnoses').selectAll().where('encounter_id', '=', encounterId).execute(),
  insertPrescription: (trx, row) =>
    trx
      .insertInto('prescription_items')
      .values({ ...row, id: newId(), instructions_i18n: toJson(row.instructions_i18n) })
      .returningAll()
      .executeTakeFirstOrThrow(),
  prescriptions: (trx, encounterId) => trx.selectFrom('prescription_items').selectAll().where('encounter_id', '=', encounterId).execute(),

  // ---- retention ----
  deleteOldTokens: (trx, beforeDate) =>
    sql`
      WITH del AS (
        DELETE FROM opd_tokens t
        USING encounters e
        WHERE t.session_date < ${beforeDate} AND e.id = t.encounter_id AND e.token_display IS NOT NULL
        RETURNING t.id)
      SELECT count(*)::int AS n FROM del`
      .execute(trx)
      .then((r) => r.rows[0]?.n ?? 0),
};
