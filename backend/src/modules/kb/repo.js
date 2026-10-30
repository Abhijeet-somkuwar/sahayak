import { sql } from 'kysely';

import { toJson } from '../../infra/db.types.js';
import { newId } from '../../shared/ids.js';

export const kbRepo = {
  documents: (trx, facilityId) => {
    let q = trx.selectFrom('kb_documents').selectAll();
    q = facilityId
      ? q.where((eb) => eb.or([eb('facility_id', '=', facilityId), eb('facility_id', 'is', null)]))
      : q.where('facility_id', 'is', null);
    return q.orderBy('created_at', 'desc').limit(200).execute();
  },
  documentById: (trx, id) => trx.selectFrom('kb_documents').selectAll().where('id', '=', id).executeTakeFirst(),
  documentByChecksum: (trx, facilityId, checksum) =>
    trx
      .selectFrom('kb_documents')
      .selectAll()
      .where('checksum', '=', checksum)
      .where(facilityId ? (eb) => eb('facility_id', '=', facilityId) : (eb) => eb('facility_id', 'is', null))
      .executeTakeFirst(),
  insertDocument: (trx, row) =>
    trx
      .insertInto('kb_documents')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  setDocumentStatus: (trx, id, status, error = null) =>
    trx.updateTable('kb_documents').set({ status, error }).where('id', '=', id).returningAll().executeTakeFirst(),
  setReviewed: (trx, id, userId) =>
    trx.updateTable('kb_documents').set({ clinically_reviewed_by: userId }).where('id', '=', id).returningAll().executeTakeFirst(),
  previousActiveVersions: (trx, doc) =>
    trx
      .selectFrom('kb_documents')
      .select('id')
      .where('id', '<>', doc.id)
      .where('status', '=', 'active')
      .where('title', '=', doc.title)
      .where('doc_type', '=', doc.doc_type)
      .where('language', '=', doc.language)
      .where(doc.facility_id ? (eb) => eb('facility_id', '=', doc.facility_id) : (eb) => eb('facility_id', 'is', null))
      .execute(),
  deleteChunks: (trx, documentId) => trx.deleteFrom('kb_chunks').where('document_id', '=', documentId).execute(),
  insertChunks: (trx, rows) =>
    rows.length
      ? trx
          .insertInto('kb_chunks')
          .values(rows.map((r) => ({ ...r, id: newId() })))
          .execute()
      : Promise.resolve(),
  setChunksActive: (trx, documentId, active) =>
    trx.updateTable('kb_chunks').set({ is_active: active }).where('document_id', '=', documentId).execute(),
  chunkCount: async (trx, documentId) =>
    Number(
      (
        await trx
          .selectFrom('kb_chunks')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('document_id', '=', documentId)
          .executeTakeFirst()
      )?.n ?? 0,
    ),
  leafletChunks: (trx, facilityId, symptomCodes, language) =>
    sql`
      SELECT c.document_id, c.content, c.chunk_index, c.language
      FROM kb_documents d JOIN kb_chunks c ON c.document_id = d.id AND c.is_active
      WHERE d.doc_type = 'self_care_leaflet' AND d.status = 'active' AND d.symptom_codes && ${symptomCodes}::text[]
        AND (d.facility_id = ${facilityId} OR d.facility_id IS NULL)
      ORDER BY (d.language = ${language}) DESC, (d.facility_id IS NOT NULL) DESC, d.id DESC, c.chunk_index
      LIMIT 6`
      .execute(trx)
      .then((r) => r.rows),

  /** Q7 — hybrid retrieval (vector top-40 + full-text top-40, RRF k=60). Caller sets hnsw.* with SET LOCAL first. */
  async hybrid(trx, embedding, text, facilityId, languages, k) {
    await sql`SET LOCAL hnsw.ef_search = 100`.execute(trx);
    await sql`SET LOCAL hnsw.iterative_scan = relaxed_order`.execute(trx);
    return sql`
      -- query: Q7
      WITH vec AS (
        SELECT id, row_number() OVER (ORDER BY dist) AS rnk
        FROM (
          SELECT id, embedding <=> ${embedding}::halfvec(1024) AS dist
          FROM kb_chunks
          WHERE is_active
            AND (facility_id = ${facilityId} OR facility_id IS NULL)
            AND language = ANY (${languages})
          ORDER BY embedding <=> ${embedding}::halfvec(1024)
          LIMIT 40
        ) v
      ),
      fts AS (
        SELECT id, row_number() OVER (ORDER BY rank DESC) AS rnk
        FROM (
          SELECT c.id, ts_rank_cd(c.content_tsv, q) AS rank
          FROM kb_chunks c, websearch_to_tsquery('simple', ${text}) q
          WHERE c.is_active
            AND c.content_tsv @@ q
            AND (c.facility_id = ${facilityId} OR c.facility_id IS NULL)
            AND c.language = ANY (${languages})
          ORDER BY rank DESC
          LIMIT 40
        ) f
      ),
      fused AS (
        SELECT id, sum(1.0 / (60 + rnk)) AS rrf
        FROM (SELECT id, rnk FROM vec UNION ALL SELECT id, rnk FROM fts) u
        GROUP BY id
      )
      SELECT c.id, c.document_id, c.doc_type, c.heading_path, c.content, f.rrf,
             1 - (c.embedding <=> ${embedding}::halfvec(1024)) AS cosine_similarity
      FROM fused f
      JOIN kb_chunks c ON c.id = f.id
      ORDER BY f.rrf DESC
      LIMIT ${k}`
      .execute(trx)
      .then((r) => r.rows);
  },
  /** Full-text-only branch (embedding provider down, §14.2). */
  fullTextOnly: (trx, text, facilityId, languages, k) =>
    sql`
      SELECT c.id, c.document_id, c.doc_type, c.heading_path, c.content, ts_rank_cd(c.content_tsv, q) AS rank
      FROM kb_chunks c, websearch_to_tsquery('simple', ${text}) q
      WHERE c.is_active AND c.content_tsv @@ q AND (c.facility_id = ${facilityId} OR c.facility_id IS NULL) AND c.language = ANY (${languages})
      ORDER BY rank DESC LIMIT ${k}`
      .execute(trx)
      .then((r) => r.rows),

  /** Q8 — curated FAQ fast path. */
  faqFastPath: (trx, embedding, facilityId, language) =>
    sql`
      -- query: Q8
      SELECT v.faq_id, f.answer_i18n, v.question, 1 - (v.embedding <=> ${embedding}::halfvec(1024)) AS similarity
      FROM faq_variants v
      JOIN faq_entries f ON f.id = v.faq_id AND f.status = 'active'
      WHERE v.is_active
        AND (v.facility_id = ${facilityId} OR v.facility_id IS NULL)
        AND v.language = ${language}
      ORDER BY v.embedding <=> ${embedding}::halfvec(1024)
      LIMIT 3`
      .execute(trx)
      .then((r) => r.rows),

  // ---- FAQ CRUD ----
  faqs: (trx, facilityId) =>
    trx
      .selectFrom('faq_entries')
      .selectAll()
      .where(
        facilityId
          ? (eb) => eb.or([eb('facility_id', '=', facilityId), eb('facility_id', 'is', null)])
          : (eb) => eb('facility_id', 'is', null),
      )
      .orderBy('topic')
      .execute(),
  faqById: (trx, id) => trx.selectFrom('faq_entries').selectAll().where('id', '=', id).executeTakeFirst(),
  insertFaq: (trx, row) =>
    trx
      .insertInto('faq_entries')
      .values({ id: newId(), ...row, answer_i18n: toJson(row.answer_i18n) })
      .returningAll()
      .executeTakeFirstOrThrow(),
  updateFaq: (trx, id, patch) =>
    trx
      .updateTable('faq_entries')
      .set({ ...patch, answer_i18n: patch.answer_i18n ? toJson(patch.answer_i18n) : undefined })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst(),
  deleteFaqVariants: (trx, faqId) => trx.deleteFrom('faq_variants').where('faq_id', '=', faqId).execute(),
  insertFaqVariants: (trx, rows) =>
    rows.length
      ? trx
          .insertInto('faq_variants')
          .values(rows.map((r) => ({ ...r, id: newId() })))
          .execute()
      : Promise.resolve(),
  faqVariants: (trx, faqId) =>
    trx.selectFrom('faq_variants').select(['id', 'language', 'question', 'is_active']).where('faq_id', '=', faqId).execute(),

  // ---- eval ----
  evalCases: (trx, facilityId) =>
    trx
      .selectFrom('kb_eval_cases')
      .selectAll()
      .where(
        facilityId
          ? (eb) => eb.or([eb('facility_id', '=', facilityId), eb('facility_id', 'is', null)])
          : (eb) => eb('facility_id', 'is', null),
      )
      .execute(),
  allEvalCases: (trx) => trx.selectFrom('kb_eval_cases').selectAll().execute(),
  insertEvalCase: (trx, row) =>
    trx
      .insertInto('kb_eval_cases')
      .values({ ...row, id: newId() })
      .returningAll()
      .executeTakeFirstOrThrow(),
  insertEvalRun: (trx, row) =>
    trx
      .insertInto('kb_eval_runs')
      .values({ id: newId(), ...row, details: toJson(row.details) })
      .returningAll()
      .executeTakeFirstOrThrow(),
  lastEvalRun: (trx) => trx.selectFrom('kb_eval_runs').selectAll().orderBy('run_at', 'desc').executeTakeFirst(),
};
