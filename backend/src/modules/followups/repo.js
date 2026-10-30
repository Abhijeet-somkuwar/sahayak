import { sql } from 'kysely';

import { toJson } from '../../infra/db.types.js';
import { newId } from '../../shared/ids.js';

export const followupsRepo = {
  insert: (trx, row) =>
    trx
      .insertInto('followups')
      .values({ ...row, id: newId(), payload: toJson(row.payload) })
      .returningAll()
      .executeTakeFirstOrThrow(),
  byId: (trx, encounterId, id) =>
    trx.selectFrom('followups').selectAll().where('encounter_id', '=', encounterId).where('id', '=', id).executeTakeFirst(),
  forEncounter: (trx, encounterId) =>
    trx.selectFrom('followups').selectAll().where('encounter_id', '=', encounterId).orderBy('due_at').execute(),
  setStatus: (trx, encounterId, id, status, patch = {}) =>
    trx
      .updateTable('followups')
      .set({
        status,
        sent_at: patch.sent_at,
        responded_at: patch.responded_at,
        response: patch.response ? toJson(patch.response) : undefined,
        escalation_encounter_id: patch.escalation_encounter_id,
      })
      .where('encounter_id', '=', encounterId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst(),
  /** Q12 — due follow-ups sweep (safety net behind BullMQ delayed jobs). */
  dueSweep: (trx, bound) =>
    sql`
      -- query: Q12
      SELECT encounter_id, id, contact_point_id, kind, template_code, payload
      FROM followups
      WHERE status = 'scheduled'
        AND due_at <= now()
        AND encounter_id >= ${bound}
      ORDER BY due_at
      LIMIT 500
      FOR UPDATE SKIP LOCKED`
      .execute(trx)
      .then((r) => r.rows),
  primaryContactForPatient: async (trx, patientId) => {
    const c = await trx
      .selectFrom('patient_contacts')
      .select('contact_point_id')
      .where('patient_id', '=', patientId)
      .orderBy('is_primary', 'desc')
      .executeTakeFirst();
    return c?.contact_point_id ?? null;
  },
  cancelForEncounter: (trx, encounterId) =>
    trx
      .updateTable('followups')
      .set({ status: 'cancelled' })
      .where('encounter_id', '=', encounterId)
      .where('status', '=', 'scheduled')
      .execute(),
};
