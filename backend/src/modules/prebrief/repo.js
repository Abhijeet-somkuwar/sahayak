import { toJson } from '../../infra/db.types.js';
import { newId } from '../../shared/ids.js';

export const prebriefRepo = {
  insert: (trx, row) =>
    trx
      .insertInto('prebriefs')
      .values({ ...row, id: newId(), content: toJson(row.content) })
      .returningAll()
      .executeTakeFirstOrThrow(),
  latest: (trx, encounterId) =>
    trx.selectFrom('prebriefs').selectAll().where('encounter_id', '=', encounterId).orderBy('id', 'desc').executeTakeFirst(),
  markViewed: (trx, encounterId, id, userId) =>
    trx
      .updateTable('prebriefs')
      .set({ viewed_at: new Date(), viewed_by: userId })
      .where('encounter_id', '=', encounterId)
      .where('id', '=', id)
      .where('viewed_at', 'is', null)
      .execute(),
  feedback: (trx, encounterId, id, feedback, note) =>
    trx
      .updateTable('prebriefs')
      .set({ feedback, feedback_note: note })
      .where('encounter_id', '=', encounterId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst(),
  /** Weekly down-vote report for clinical reviewers (§9.6 rule 6). */
  downvotesSince: (trx, bound) =>
    trx
      .selectFrom('prebriefs')
      .select(['encounter_id', 'id', 'facility_id', 'prompt_version', 'model', 'feedback_note', 'generated_at'])
      .where('id', '>=', bound)
      .where('feedback', '=', -1)
      .execute(),
  encounterContext: (trx, encounterId) =>
    trx
      .selectFrom('encounters as e')
      .leftJoin('patients as p', 'p.id', 'e.patient_id')
      .select([
        'e.id',
        'e.facility_id',
        'e.patient_id',
        'e.department_id',
        'e.doctor_user_id',
        'e.triage_level',
        'e.status',
        'p.display_name',
        'p.sex',
        'p.birth_date',
        'p.birth_year',
        'p.preferred_language',
      ])
      .where('e.id', '=', encounterId)
      .executeTakeFirst(),
  triage: (trx, encounterId) => trx.selectFrom('triage_assessments').selectAll().where('encounter_id', '=', encounterId).executeTakeFirst(),
  observations: (trx, encounterId) =>
    trx
      .selectFrom('observations')
      .select(['code', 'value_num', 'value_text', 'unit'])
      .where('encounter_id', '=', encounterId)
      .orderBy('observed_at')
      .execute(),
  householdNames: (trx, patientId) =>
    trx
      .selectFrom('patient_contacts as pc1')
      .innerJoin('patient_contacts as pc2', 'pc2.contact_point_id', 'pc1.contact_point_id')
      .innerJoin('patients as p', 'p.id', 'pc2.patient_id')
      .select('p.display_name')
      .where('pc1.patient_id', '=', patientId)
      .execute(),
  facilitiesByIds: (trx, ids) =>
    ids.length
      ? trx.selectFrom('facilities').select(['id', 'name', 'kind', 'district_code']).where('id', 'in', ids).execute()
      : Promise.resolve([]),
  departmentsByIds: (trx, ids) =>
    ids.length ? trx.selectFrom('departments').select(['id', 'name']).where('id', 'in', ids).execute() : Promise.resolve([]),
  symptomLabels: (trx, codes) =>
    codes.length ? trx.selectFrom('symptom_catalog').select(['code', 'labels']).where('code', 'in', codes).execute() : Promise.resolve([]),
};
