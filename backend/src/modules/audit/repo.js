import { sql } from 'kysely';
import { gzipSync } from 'node:zlib';

export const auditRepo = {
  /** Q14 — "who accessed my record" (bounded to 12 months). */
  accessLog: (trx, patientId, bound) =>
    sql`
      -- query: Q14
      SELECT occurred_at, actor_kind, actor_id, facility_id, action, purpose
      FROM audit_events
      WHERE patient_id = ${patientId} AND id >= ${bound}
      ORDER BY id DESC
      LIMIT 100`
      .execute(trx)
      .then((r) => r.rows),
  breakglassEvents: (trx, bound, reviewed) =>
    sql`
      SELECT b.id, b.occurred_at, b.actor_id, b.facility_id, b.patient_id, b.details
      FROM audit_events b
      WHERE b.action = 'breakglass.open' AND b.id >= ${bound}
        AND ${reviewed} = EXISTS (SELECT 1 FROM audit_events r WHERE r.action = 'breakglass.review' AND r.resource_id = b.id AND r.id >= ${bound})
      ORDER BY b.id DESC LIMIT 200`
      .execute(trx)
      .then((r) => r.rows),
  eventById: (trx, id) => trx.selectFrom('audit_events').selectAll().where('id', '=', id).executeTakeFirst(),
  consentLedger: (trx, contactPointId) =>
    trx
      .selectFrom('consents')
      .selectAll()
      .where('contact_point_id', '=', contactPointId)
      .orderBy('created_at', 'desc')
      .limit(500)
      .execute(),

  contactLinkedToPatient: async (trx, contactPointId, patientId) =>
    !!(await trx
      .selectFrom('patient_contacts')
      .select('patient_id')
      .where('contact_point_id', '=', contactPointId)
      .where('patient_id', '=', patientId)
      .executeTakeFirst()),
  contactPointExists: async (trx, id) => !!(await trx.selectFrom('contact_points').select('id').where('id', '=', id).executeTakeFirst()),
  conversationsForContact: (trx, contactPointId) =>
    trx.selectFrom('conversations').select('id').where('contact_point_id', '=', contactPointId).execute(),
  eraseMessages: async (trx, conversationId) =>
    Number(
      (
        await trx
          .updateTable('messages')
          .set({ body_enc: null, body_redacted: '[erased]' })
          .where('conversation_id', '=', conversationId)
          .executeTakeFirst()
      ).numUpdatedRows,
    ),
  detachConversation: (trx, conversationId) =>
    trx
      .updateTable('conversations')
      .set({ state: 'idle', state_data: '{}', external_ref_hash: null, contact_point_id: null, active_encounter_id: null })
      .where('id', '=', conversationId)
      .execute(),
  tombstoneContactPoint: (trx, id, tomb) =>
    trx
      .updateTable('contact_points')
      .set({ value_hash: tomb, value_enc: Buffer.alloc(0), whatsapp_capable: false })
      .where('id', '=', id)
      .execute(),

  // ---- hourly digest chain (§9.12) ----
  lastDigest: (trx) => trx.selectFrom('audit_digests').selectAll().orderBy('period_start', 'desc').executeTakeFirst(),
  rowsForPeriod: (trx, start, end) =>
    trx.selectFrom('audit_events').selectAll().where('occurred_at', '>=', start).where('occurred_at', '<', end).orderBy('id').execute(),
  insertDigest: (trx, row) =>
    trx
      .insertInto('audit_digests')
      .values(row)
      .onConflict((oc) => oc.column('period_start').doNothing())
      .execute(),
  gzipJsonl: (rows) => gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n'))),
};
