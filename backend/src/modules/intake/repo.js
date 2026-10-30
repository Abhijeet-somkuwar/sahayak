import { sql } from 'kysely';

import { toJson } from '../../infra/db.types.js';
import { newId } from '../../shared/ids.js';

export const intakeRepo = {
  // ---- conversations ----
  conversationById: (trx, id) => trx.selectFrom('conversations').selectAll().where('id', '=', id).executeTakeFirst(),
  conversationByRef: (trx, channel, refHash) =>
    trx.selectFrom('conversations').selectAll().where('channel', '=', channel).where('external_ref_hash', '=', refHash).executeTakeFirst(),
  async findOrCreateConversation(trx, row) {
    if (row.external_ref_hash) {
      await trx
        .insertInto('conversations')
        .values({ id: newId(), ...row })
        .onConflict((oc) => oc.doNothing())
        .execute();
      const c = await intakeRepo.conversationByRef(trx, row.channel, row.external_ref_hash);
      if (c) return c;
    }
    return trx
      .insertInto('conversations')
      .values({ id: newId(), ...row })
      .returningAll()
      .executeTakeFirstOrThrow();
  },
  updateConversation: (trx, id, version, patch) =>
    trx
      .updateTable('conversations')
      .set({ ...patch, state_data: patch.state_data ? toJson(patch.state_data) : undefined, version: version + 1 })
      .where('id', '=', id)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst(),
  touchInbound: (trx, id) => trx.updateTable('conversations').set({ last_inbound_at: new Date() }).where('id', '=', id).execute(),

  // ---- intake sessions (HOT, 7 days) ----
  insertSession: (trx, row) =>
    trx
      .insertInto('intake_sessions')
      .values({ id: newId(), ...row, facts: toJson(row.facts) })
      .returningAll()
      .executeTakeFirstOrThrow(),
  latestSessionForConversation: (trx, conversationId) =>
    trx.selectFrom('intake_sessions').selectAll().where('conversation_id', '=', conversationId).orderBy('started_at', 'desc').limit(1).executeTakeFirst(),
  latestAssessment: (trx, encounterId) =>
    trx
      .selectFrom('triage_assessments')
      .select(['final_level', 'routing_method', 'routed_department_id', 'red_flags'])
      .where('encounter_id', '=', encounterId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst(),
  departmentName: (trx, id) => trx.selectFrom('departments').select(['name', 'name_i18n']).where('id', '=', id).executeTakeFirst(),
  sessionByEncounter: (trx, encounterId) =>
    trx.selectFrom('intake_sessions').selectAll().where('encounter_id', '=', encounterId).executeTakeFirst(),
  updateSession: (trx, id, version, patch) =>
    trx
      .updateTable('intake_sessions')
      .set({ ...patch, facts: patch.facts ? toJson(patch.facts) : undefined, version: version + 1 })
      .where('id', '=', id)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst(),
  expiredSessions: (trx) =>
    trx
      .selectFrom('intake_sessions')
      .select(['id', 'version', 'encounter_id', 'conversation_id'])
      .where('status', '=', 'in_progress')
      .where('expires_at', '<', new Date())
      .limit(500)
      .execute(),
  idleSessions: (trx, idleBefore) =>
    trx
      .selectFrom('intake_sessions')
      .select(['id', 'version', 'encounter_id', 'conversation_id', 'facts'])
      .where('status', '=', 'in_progress')
      .where('updated_at', '<', idleBefore)
      .limit(500)
      .execute(),
  deleteOldSessions: (trx, before) =>
    trx.deleteFrom('intake_sessions').where('started_at', '<', before).where('status', '<>', 'in_progress').executeTakeFirst(),

  // ---- messages ----
  insertMessage: (trx, row) =>
    trx
      .insertInto('messages')
      .values({ ...row, id: newId() })
      .returning('id')
      .executeTakeFirstOrThrow(),
  /** Q13 — WhatsApp delivery status update; enum order prevents a late 'delivered' from overwriting 'read'. */
  updateMessageStatus: (trx, providerMessageId, status, bound) =>
    sql`
      -- query: Q13
      UPDATE messages
      SET status = ${status}::message_status, status_updated_at = now()
      WHERE provider_message_id = ${providerMessageId}
        AND direction = 'outbound'
        AND id >= ${bound}
        AND status < ${status}::message_status`
      .execute(trx)
      .then((r) => Number(r.numAffectedRows ?? 0)),

  setMessageError: (trx, providerMessageId, errorCode, bound) =>
    trx
      .updateTable('messages')
      .set({ error_code: errorCode })
      .where('provider_message_id', '=', providerMessageId)
      .where('id', '>=', bound)
      .execute(),

  // ---- reference data ----
  /** Q9 — symptom normalisation candidates: exact synonym hits, then 5 nearest by embedding. */
  symptomCandidates: (trx, phrase, embedding) =>
    sql`
      -- query: Q9
      SELECT code, labels, default_specialty_code, is_red_flag, max(similarity) AS similarity
      FROM (
        SELECT code, labels, default_specialty_code, is_red_flag, 1.0::float8 AS similarity
        FROM symptom_catalog
        WHERE status = 'active' AND synonyms @> ARRAY[${phrase}]::text[]
        UNION ALL
        (SELECT code, labels, default_specialty_code, is_red_flag, 1 - (embedding <=> ${embedding}::halfvec(1024))
         FROM symptom_catalog
         WHERE status = 'active' AND embedding IS NOT NULL
         ORDER BY embedding <=> ${embedding}::halfvec(1024)
         LIMIT 5)
      ) candidates
      GROUP BY code, labels, default_specialty_code, is_red_flag
      ORDER BY similarity DESC`
      .execute(trx)
      .then((r) => r.rows),
  /** Exact synonym hits for every word n-gram of the complaint (deterministic path). */
  symptomsBySynonyms: (trx, phrases) =>
    phrases.length
      ? trx
          .selectFrom('symptom_catalog')
          .select(['code', 'labels', 'default_specialty_code', 'is_red_flag', 'synonyms'])
          .where('status', '=', 'active')
          .where(sql`synonyms && ${phrases}::text[]`)
          .execute()
      : Promise.resolve([]),
  symptomsByCodes: (trx, codes) =>
    codes.length ? trx.selectFrom('symptom_catalog').selectAll().where('code', 'in', codes).execute() : Promise.resolve([]),
  bodySystems: (trx) =>
    trx.selectFrom('symptom_catalog').select('body_system').distinct().where('status', '=', 'active').orderBy('body_system').execute(),
  symptomsForSystem: (trx, system) =>
    trx
      .selectFrom('symptom_catalog')
      .select(['code', 'labels', 'is_red_flag'])
      .where('status', '=', 'active')
      .where('body_system', '=', system)
      .orderBy('code')
      .limit(10)
      .execute(),
  activeQuestions: (trx) => trx.selectFrom('intake_questions').selectAll().where('status', '=', 'active').orderBy('priority').execute(),
  facilityByCode: (trx, code) =>
    trx
      .selectFrom('facilities')
      .select(['id', 'code', 'name', 'name_i18n', 'district_code'])
      .where('code', '=', code.toUpperCase())
      .where('status', '=', 'active')
      .executeTakeFirst(),
  facilitiesByName: (trx, text) =>
    trx
      .selectFrom('facilities')
      .select(['id', 'code', 'name', 'name_i18n', 'district_code'])
      .where('status', '=', 'active')
      .where(sql`lower(name) LIKE ${'%' + text.toLowerCase() + '%'}`)
      .limit(5)
      .execute(),
  recentFacilityForContact: async (trx, contactPointId) => {
    const r = await trx
      .selectFrom('encounters')
      .select('facility_id')
      .where('contact_point_id', '=', contactPointId)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return r?.facility_id ?? null;
  },
  updateEncounterStatus: (trx, encounterId, patch) =>
    trx
      .updateTable('encounters')
      .set((eb) => ({ ...patch, version: eb('version', '+', 1) }))
      .where('id', '=', encounterId)
      .execute(),
  cancelIntakeEncounter: (trx, encounterId) =>
    trx
      .updateTable('encounters')
      .set({ status: 'cancelled', closed_at: new Date() })
      .where('id', '=', encounterId)
      .where('status', '=', 'intake')
      .execute(),
  resetConversationAfterAbandon: (trx, conversationId, encounterId) =>
    trx
      .updateTable('conversations')
      .set({ state: 'idle', active_encounter_id: null })
      .where('id', '=', conversationId)
      .where('active_encounter_id', '=', encounterId)
      .execute(),
  encounterFacts: (trx, encounterId) =>
    trx
      .selectFrom('encounters')
      .select(['id', 'facility_id', 'patient_id', 'contact_point_id', 'status', 'version', 'department_id', 'kind'])
      .where('id', '=', encounterId)
      .executeTakeFirst(),
};
