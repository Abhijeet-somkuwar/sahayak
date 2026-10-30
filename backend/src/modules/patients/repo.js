/**
 * Patients repo: Q1, Q2, Q3, Q6 exactly as written in §7.2, plus household, consent and clinical-fact access.
 */
import { sql } from 'kysely';

import { toJson } from '../../infra/db.types.js';
import { newId } from '../../shared/ids.js';

export const patientsRepo = {
  // ---- contact points ----
  contactPointByHash: (trx, hash) =>
    trx.selectFrom('contact_points').selectAll().where('kind', '=', 'phone').where('value_hash', '=', hash).executeTakeFirst(),
  contactPointById: (trx, id) => trx.selectFrom('contact_points').selectAll().where('id', '=', id).executeTakeFirst(),
  async insertContactPoint(trx, row) {
    // Concurrent first-contact: INSERT ... ON CONFLICT DO NOTHING, then select (§9.9).
    const inserted = await trx
      .insertInto('contact_points')
      .values({ id: newId(), kind: 'phone', ...row })
      .onConflict((oc) => oc.columns(['kind', 'value_hash']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted;
    const existing = await patientsRepo.contactPointByHash(trx, row.value_hash);
    if (!existing) throw new Error('contact point insert race');
    return existing;
  },
  markVerified: (trx, id) =>
    trx.updateTable('contact_points').set({ verified_at: new Date() }).where('id', '=', id).where('verified_at', 'is', null).execute(),
  setWhatsappCapable: (trx, id, capable) =>
    trx.updateTable('contact_points').set({ whatsapp_capable: capable }).where('id', '=', id).execute(),

  /** Q1 — household lookup by phone blind index. */
  household: (trx, phoneHash) =>
    sql`
      -- query: Q1
      SELECT p.id, p.display_name, p.sex, p.birth_date, p.birth_year, pc.relationship, pc.is_primary
      FROM contact_points cp
      JOIN patient_contacts pc ON pc.contact_point_id = cp.id
      JOIN patients p ON p.id = pc.patient_id AND p.status = 'active' AND p.merged_into_id IS NULL
      WHERE cp.kind = 'phone' AND cp.value_hash = ${phoneHash}
      ORDER BY pc.is_primary DESC, p.display_name
      LIMIT 20`
      .execute(trx)
      .then((r) => r.rows),

  householdByContactPointId: (trx, contactPointId) =>
    trx
      .selectFrom('patient_contacts as pc')
      .innerJoin('patients as p', 'p.id', 'pc.patient_id')
      .select([
        'p.id',
        'p.display_name',
        'p.sex',
        'p.birth_date',
        'p.birth_year',
        'p.preferred_language',
        'pc.relationship',
        'pc.is_primary',
      ])
      .where('pc.contact_point_id', '=', contactPointId)
      .where('p.status', '=', 'active')
      .where('p.merged_into_id', 'is', null)
      .orderBy('pc.is_primary', 'desc')
      .orderBy('p.display_name')
      .limit(20)
      .execute(),

  /** Q2 — patient by ABHA number (exact). For a facility MRN pass kind 'facility_mrn' and the facility id. */
  byIdentifier: (trx, kind, valueHash, facilityId) =>
    sql`
      -- query: Q2
      SELECT p.id, p.display_name, p.sex, p.birth_date, p.birth_year
      FROM patient_identifiers pi
      JOIN patients p ON p.id = pi.patient_id
      WHERE pi.kind = ${kind} AND pi.facility_id ${facilityId ? sql`= ${facilityId}` : sql`IS NULL`} AND pi.value_hash = ${valueHash}`
      .execute(trx)
      .then((r) => r.rows),

  /** Q3 — fuzzy name search. Sets the trigram threshold for this transaction first. */
  async fuzzySearch(trx, nameSearch, district, birthYear) {
    await sql`SET LOCAL pg_trgm.similarity_threshold = 0.35`.execute(trx);
    return sql`
      -- query: Q3
      SELECT id, display_name, sex, birth_year, similarity(name_search, ${nameSearch}) AS score
      FROM patients
      WHERE name_search % ${nameSearch}
        AND district_code = ${district}
        AND birth_year BETWEEN ${birthYear} - 3 AND ${birthYear} + 3
        AND status = 'active'
        AND merged_into_id IS NULL
      ORDER BY score DESC
      LIMIT 20`
      .execute(trx)
      .then((r) => r.rows);
  },

  byId: (trx, id) => trx.selectFrom('patients').selectAll().where('id', '=', id).executeTakeFirst(),
  insertPatient: (trx, row) =>
    trx
      .insertInto('patients')
      .values({ ...row, id: row.id ?? newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  updatePatient: (trx, id, version, patch) =>
    trx
      .updateTable('patients')
      .set({ ...patch, version: version + 1 })
      .where('id', '=', id)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst(),
  linkContact: (trx, contactPointId, patientId, relationship, isPrimary) =>
    trx
      .insertInto('patient_contacts')
      .values({ contact_point_id: contactPointId, patient_id: patientId, relationship, is_primary: isPrimary })
      .onConflict((oc) => oc.columns(['contact_point_id', 'patient_id']).doUpdateSet({ relationship, is_primary: isPrimary }))
      .execute(),
  contactsOfPatient: (trx, patientId) =>
    trx
      .selectFrom('patient_contacts as pc')
      .innerJoin('contact_points as cp', 'cp.id', 'pc.contact_point_id')
      .select(['cp.id', 'cp.value_enc', 'cp.whatsapp_capable', 'pc.relationship', 'pc.is_primary'])
      .where('pc.patient_id', '=', patientId)
      .execute(),
  insertIdentifier: (trx, row) =>
    trx
      .insertInto('patient_identifiers')
      .values({ ...row, id: newId() })
      .onConflict((oc) => oc.doNothing())
      .execute(),
  identifiersOf: (trx, patientId) => trx.selectFrom('patient_identifiers').selectAll().where('patient_id', '=', patientId).execute(),

  // ---- consent ledger (append-only; latest row per (contact, patient, purpose) is current) ----
  insertConsent: (trx, row) =>
    trx
      .insertInto('consents')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  currentConsents: (trx, contactPointId, patientId) =>
    sql`
      SELECT DISTINCT ON (purpose) purpose, granted, created_at, notice_version
      FROM consents
      WHERE contact_point_id = ${contactPointId} AND patient_id IS NOT DISTINCT FROM ${patientId}
      ORDER BY purpose, created_at DESC`
      .execute(trx)
      .then((r) => r.rows),
  consentLedger: (trx, contactPointId) =>
    trx
      .selectFrom('consents')
      .selectAll()
      .where('contact_point_id', '=', contactPointId)
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute(),

  // ---- clinical facts ----
  activeAllergies: (trx, patientId) =>
    trx
      .selectFrom('allergies')
      .selectAll()
      .where('patient_id', '=', patientId)
      .where('status', '=', 'active')
      .orderBy('recorded_at', 'desc')
      .execute(),
  insertAllergy: (trx, row) =>
    trx
      .insertInto('allergies')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  setAllergyStatus: (trx, id, patientId, status) =>
    trx.updateTable('allergies').set({ status }).where('id', '=', id).where('patient_id', '=', patientId).executeTakeFirst(),
  activeConditions: (trx, patientId) =>
    trx
      .selectFrom('conditions')
      .selectAll()
      .where('patient_id', '=', patientId)
      .where('clinical_status', '=', 'active')
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>=', sql`current_date`)]))
      .orderBy('recorded_at', 'desc')
      .execute(),
  insertCondition: (trx, row) =>
    trx
      .insertInto('conditions')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  setConditionStatus: (trx, id, patientId, status) =>
    trx
      .updateTable('conditions')
      .set({ clinical_status: status })
      .where('id', '=', id)
      .where('patient_id', '=', patientId)
      .executeTakeFirst(),

  /** Q6 — recent completed visits with diagnoses and prescriptions (bounded to 24 months). */
  recentVisits: (trx, patientId, bound, limit = 5) =>
    sql`
      -- query: Q6
      SELECT e.id, e.session_date, e.facility_id, e.department_id, e.triage_level, e.status,
             (SELECT t.symptoms FROM triage_assessments t WHERE t.encounter_id = e.id ORDER BY t.created_at DESC LIMIT 1) AS symptoms,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('code', d.code, 'text', d.display_text)
                                        ORDER BY d.is_primary DESC), '[]'::jsonb)
                FROM encounter_diagnoses d WHERE d.encounter_id = e.id) AS diagnoses,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('drug', p.drug_name, 'dose', p.dose,
                                                           'frequency', p.frequency, 'days', p.duration_days)), '[]'::jsonb)
                FROM prescription_items p WHERE p.encounter_id = e.id) AS prescriptions
      FROM encounters e
      WHERE e.patient_id = ${patientId}
        AND e.id >= ${bound}
        AND e.status IN ('completed', 'referred')
      ORDER BY e.id DESC
      LIMIT ${limit}`
      .execute(trx)
      .then((r) => r.rows),

  /** Active medications = prescriptions whose duration has not ended (bounded to 12 months). */
  activeMedications: (trx, patientId, bound) =>
    sql`
      SELECT drug_name, strength, dose, frequency, duration_days, created_at, encounter_id
      FROM prescription_items
      WHERE patient_id = ${patientId} AND encounter_id >= ${bound}
        AND (duration_days IS NULL OR created_at + make_interval(days => duration_days) >= now())
      ORDER BY encounter_id DESC
      LIMIT 20`
      .execute(trx)
      .then((r) => r.rows),

  summary: (trx, patientId) =>
    trx.selectFrom('patient_clinical_summaries').selectAll().where('patient_id', '=', patientId).executeTakeFirst(),
  upsertSummary: (trx, patientId, data) =>
    sql`
      INSERT INTO patient_clinical_summaries (patient_id, allergies, active_conditions, active_medications, recent_encounters, risk_flags, last_encounter_at, source_version, rebuilt_at)
      VALUES (${patientId}, ${toJson(data.allergies)}::jsonb, ${toJson(data.active_conditions)}::jsonb, ${toJson(data.active_medications)}::jsonb,
              ${toJson(data.recent_encounters)}::jsonb, ${data.risk_flags}::text[], ${data.last_encounter_at}, 1, now())
      ON CONFLICT (patient_id) DO UPDATE SET
        allergies = EXCLUDED.allergies, active_conditions = EXCLUDED.active_conditions, active_medications = EXCLUDED.active_medications,
        recent_encounters = EXCLUDED.recent_encounters, risk_flags = EXCLUDED.risk_flags, last_encounter_at = EXCLUDED.last_encounter_at,
        source_version = patient_clinical_summaries.source_version + 1, rebuilt_at = now()
      RETURNING source_version`
      .execute(trx)
      .then((r) => Number(r.rows[0].source_version)),

  /**
   * Visit details for history screens (doctor) and the patient's own visits: department, doctor, complaint codes,
   * the doctor's diagnoses and prescriptions. `withAi` adds the AI pre-brief headline of that visit (staff only).
   */
  visitDetails: (trx, encounterIds, withAi = false) =>
    encounterIds.length === 0
      ? Promise.resolve([])
      : sql`
      SELECT e.id, e.patient_id, e.session_date, e.status, e.kind, e.token_display, e.triage_level,
             e.checked_in_at, e.consult_ended_at, e.created_at,
             d.name AS department, d.name_i18n AS department_i18n, f.name AS facility, u.display_name AS doctor,
             (SELECT t.symptoms FROM triage_assessments t WHERE t.encounter_id = e.id ORDER BY t.created_at DESC LIMIT 1) AS symptoms,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('text', x.display_text, 'primary', x.is_primary)
                                        ORDER BY x.is_primary DESC, x.created_at), '[]'::jsonb)
                FROM encounter_diagnoses x WHERE x.encounter_id = e.id) AS diagnoses,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('drug', p.drug_name, 'strength', p.strength, 'form', p.dosage_form,
                                                           'dose', p.dose, 'frequency', p.frequency, 'days', p.duration_days,
                                                           'route', p.route, 'instructions', p.instructions_i18n)
                                        ORDER BY p.created_at), '[]'::jsonb)
                FROM prescription_items p WHERE p.encounter_id = e.id) AS prescriptions,
             ${withAi ? sql`(SELECT pb.content -> 'narrative' ->> 'headline' FROM prebriefs pb
                              WHERE pb.encounter_id = e.id AND pb.status = 'ready' ORDER BY pb.id DESC LIMIT 1)` : sql`NULL`} AS ai_headline
      FROM encounters e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN facilities f ON f.id = e.facility_id
      LEFT JOIN users u ON u.id = e.doctor_user_id
      WHERE e.id = ANY(${encounterIds}::uuid[])
      ORDER BY e.id DESC`
          .execute(trx)
          .then((r) => r.rows),

  encounterIdForToken: (trx, tokenId) => trx.selectFrom('opd_tokens').select(['encounter_id']).where('id', '=', tokenId).executeTakeFirst(),
  symptomLabels: (trx, codes) =>
    codes.length ? trx.selectFrom('symptom_catalog').select(['code', 'labels']).where('code', 'in', codes).execute() : Promise.resolve([]),

  /** Own household's visits (patient portal), keyset-paginated. */
  encountersForHousehold: (trx, patientIds, bound, limit, cursor) => {
    let q = trx
      .selectFrom('encounters')
      .select(['id', 'patient_id', 'facility_id', 'department_id', 'session_date', 'status', 'triage_level', 'token_display', 'kind'])
      .where('patient_id', 'in', patientIds)
      .where('id', '>=', bound);
    if (cursor) q = q.where('id', '<', cursor);
    return q
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
  },
  encountersForPatient: (trx, patientId, bound, limit, cursor) => {
    let q = trx.selectFrom('encounters').selectAll().where('patient_id', '=', patientId).where('id', '>=', bound);
    if (cursor) q = q.where('id', '<', cursor);
    return q
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
  },
  mergePatient: (trx, fromId, intoId) =>
    trx.updateTable('patients').set({ merged_into_id: intoId, status: 'inactive' }).where('id', '=', fromId).executeTakeFirst(),
};
