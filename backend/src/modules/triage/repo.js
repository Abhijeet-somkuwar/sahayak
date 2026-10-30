import { toJson } from '../../infra/db.types.js';
import { newId } from '../../shared/ids.js';

export const triageRepo = {
  published: (trx) => trx.selectFrom('triage_rule_sets').selectAll().where('status', '=', 'published').executeTakeFirst(),
  byId: (trx, id) => trx.selectFrom('triage_rule_sets').selectAll().where('id', '=', id).executeTakeFirst(),
  list: (trx) =>
    trx
      .selectFrom('triage_rule_sets')
      .select(['id', 'version', 'status', 'authored_by', 'approved_by', 'published_at', 'retired_at', 'notes', 'created_at'])
      .orderBy('version', 'desc')
      .execute(),
  nextVersion: async (trx) => {
    const r = await trx
      .selectFrom('triage_rule_sets')
      .select((eb) => eb.fn.max('version').as('v'))
      .executeTakeFirst();
    return (Number(r?.v) || 0) + 1;
  },
  insert: (trx, row) =>
    trx
      .insertInto('triage_rule_sets')
      .values({
        id: newId(),
        version: row.version,
        rules: toJson(row.rules),
        test_cases: toJson(row.test_cases),
        checksum: row.checksum,
        authored_by: row.authored_by,
        notes: row.notes,
      })
      .returningAll()
      .executeTakeFirstOrThrow(),
  approve: (trx, id, approvedBy) =>
    trx
      .updateTable('triage_rule_sets')
      .set({ approved_by: approvedBy })
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst(),
  retireCurrent: (trx) =>
    trx.updateTable('triage_rule_sets').set({ status: 'retired', retired_at: new Date() }).where('status', '=', 'published').execute(),
  publish: (trx, id) =>
    trx
      .updateTable('triage_rule_sets')
      .set({ status: 'published', published_at: new Date() })
      .where('id', '=', id)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst(),

  insertAssessment: (trx, row) =>
    trx
      .insertInto('triage_assessments')
      .values({ ...row, symptoms: toJson(row.symptoms), facts: toJson(row.facts) })
      .returningAll()
      .executeTakeFirstOrThrow(),
  assessment: (trx, encounterId) =>
    trx.selectFrom('triage_assessments').selectAll().where('encounter_id', '=', encounterId).executeTakeFirst(),
  override: (trx, encounterId, finalLevel, userId, reason) =>
    trx
      .updateTable('triage_assessments')
      .set({ final_level: finalLevel, overridden_by: userId, override_reason: reason, overridden_at: new Date() })
      .where('encounter_id', '=', encounterId)
      .returningAll()
      .executeTakeFirst(),
};
