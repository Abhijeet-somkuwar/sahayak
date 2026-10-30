import { sql } from 'kysely';

import { newId } from '../../shared/ids.js';

export const patientDocsRepo = {
  insert: (trx, row) =>
    trx
      .insertInto('patient_documents')
      .values({ ...row, id: newId() })
      .onConflict((oc) => oc.columns(['patient_id', 'sha256']).doNothing())
      .returningAll()
      .executeTakeFirst(),
  bySha: (trx, patientId, sha) =>
    trx.selectFrom('patient_documents').selectAll().where('patient_id', '=', patientId).where('sha256', '=', sha).executeTakeFirst(),
  byId: (trx, id) => trx.selectFrom('patient_documents').selectAll().where('id', '=', id).executeTakeFirst(),
  forPatient: (trx, patientId) =>
    trx.selectFrom('patient_documents').selectAll().where('patient_id', '=', patientId).orderBy('created_at', 'desc').execute(),
  setExtraction: (trx, id, status, patch = {}) =>
    trx
      .updateTable('patient_documents')
      .set({ extraction_status: status, ...patch })
      .where('id', '=', id)
      .execute(),
  replaceChunks: async (trx, documentId, patientId, rows) => {
    await trx.deleteFrom('patient_doc_chunks').where('document_id', '=', documentId).execute();
    if (rows.length)
      await trx
        .insertInto('patient_doc_chunks')
        .values(rows.map((r) => ({ id: newId(), patient_id: patientId, document_id: documentId, ...r })))
        .execute();
  },
  /** Q10 — exact nearest-neighbour over one patient's chunks only (D9). */
  search: (trx, patientId, embedding) =>
    sql`
      -- query: Q10
      SELECT c.document_id, c.chunk_index, c.content, 1 - (c.embedding <=> ${embedding}::halfvec(1024)) AS similarity
      FROM patient_doc_chunks c
      WHERE c.patient_id = ${patientId}
      ORDER BY c.embedding <=> ${embedding}::halfvec(1024)
      LIMIT 8`
      .execute(trx)
      .then((r) => r.rows),
};
