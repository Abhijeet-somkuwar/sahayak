/**
 * Hospital knowledge bot (§9.7, D10): ingestion, hybrid retrieval with RRF, curated FAQ fast path,
 * confidence gate, grounded answer with citation validation and medical redirect.
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { cacheGet, cacheSet } from '../../infra/cache.js';
import { redisCore, keys } from '../../infra/redis.js';
import { embeddings, embedOne } from '../../infra/embeddings/index.js';
import { toVector } from '../../infra/db.types.js';
import { sha1Hex, sha256 } from '../../infra/crypto.js';
import { deidentify, llm } from '../../infra/llm/index.js';
import { kbAnswers, kbEvalRecall } from '../../infra/metrics.js';
import { logger } from '../../infra/logger.js';
import { AppError } from '../../shared/errors.js';
import { render, pick, detectLanguage } from '../../shared/i18n.js';
import { enqueue } from '../../infra/queues.js';
import { getObject, putObject, storageKeys } from '../../infra/storage.js';
import { writeOutbox } from '../../shared/outbox.js';
import { getFacilityConfig } from '../facilities/service.js';
import { kbRepo } from './repo.js';
import { chunkText, extractText, normaliseText } from './ingest.js';
import { kbAnswerPromptV1 } from './prompts/kb_answer.v1.js';

export const FAQ_THRESHOLD = 0.88; // calibrate on kb_eval_cases
export const CONFIDENCE_FLOOR = 0.35;

function normaliseQuestion(q) {
  return q
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function kbVersion(facilityId) {
  const [f, s] = await Promise.all([
    facilityId ? redisCore.get(keys.kbver(facilityId)) : Promise.resolve('0'),
    redisCore.get(keys.kbver(null)),
  ]).catch(() => ['0', '0']);
  return `${f ?? 0}.${s ?? 0}`;
}

async function questionEmbedding(norm) {
  const key = keys.kbEmb(sha1Hex(norm));
  try {
    const hit = await redisCore.get(key);
    if (hit) return JSON.parse(hit);
    const v = await embedOne(norm);
    await redisCore.set(key, JSON.stringify(v), 'EX', 24 * 3600);
    return v;
  } catch (err) {
    logger.warn({ err }, 'question embedding unavailable');
    return null;
  }
}

export const kbService = {
  async ask(input) {
    const lang = input.language.split('-')[0] ?? 'en';
    const norm = normaliseQuestion(input.question);
    const ver = await kbVersion(input.facilityId);
    const cacheKey = keys.kbAns(input.facilityId, lang, ver, sha1Hex(norm));
    const cached = await cacheGet(cacheKey);
    if (cached) {
      kbAnswers.inc({ path: 'cache' });
      return { ...cached, path: 'cache' };
    }
    const cfg = input.facilityId ? await getFacilityConfig(input.facilityId).catch(() => null) : null;
    const helpDesk = cfg?.opd.help_desk_phone ?? '';
    const notFound = async () => {
      const t = await render('kb.not_found', lang, { help_desk: helpDesk });
      kbAnswers.inc({ path: 'not_found' });
      return { answer: t.text, path: 'not_found', citations: [], templateCode: 'kb.not_found' };
    };

    const emb = await questionEmbedding(norm);
    const languages = [...new Set([lang, detectLanguage(input.question) ?? lang, 'en'])];
    const result = await withScope(STATE_SCOPE, async (trx) => {
      if (emb) {
        const faq = await kbRepo.faqFastPath(trx, toVector(emb), input.facilityId, lang);
        if (faq[0] && faq[0].similarity >= FAQ_THRESHOLD) return { kind: 'faq', faq: faq[0] };
        const chunks = await kbRepo.hybrid(trx, toVector(emb), input.question, input.facilityId, languages, 6);
        return { kind: 'chunks', chunks, ftsOnly: false };
      }
      const chunks = await kbRepo.fullTextOnly(trx, input.question, input.facilityId, languages, 6);
      return { kind: 'chunks', chunks: chunks.map((c) => ({ ...c, rrf: c.rank, cosine_similarity: 1 })), ftsOnly: true };
    });
    if (result.kind === 'faq') {
      const answer = { answer: pick(result.faq.answer_i18n, lang), path: 'faq', citations: [`faq:${result.faq.faq_id}`] };
      await cacheSet(cacheKey, answer, { ttlSeconds: 6 * 3600 });
      kbAnswers.inc({ path: 'faq' });
      return answer;
    }
    const chunks = result.chunks;
    const best = Math.max(0, ...chunks.map((c) => c.cosine_similarity));
    const hasFts = result.ftsOnly ? chunks.length > 0 : chunks.some((c) => c.rrf > 0 && c.cosine_similarity < 0.999); // rrf from fts branch contributes
    if (chunks.length === 0 || (best < CONFIDENCE_FLOOR && !hasFts)) return notFound();
    if (!cfg?.opd.kb_llm_enabled && input.facilityId) {
      // LLM disabled for this facility: return the best chunk verbatim (reviewed document text), no generation.
      const c = chunks[0];
      const answer = { answer: `${c.heading_path}\n${c.content}`.slice(0, 1200), path: 'rag', citations: [c.id] };
      kbAnswers.inc({ path: 'rag' });
      return answer;
    }
    const res = await llm.call({
      purpose: 'kb_answer',
      prompt: kbAnswerPromptV1,
      input: deidentify({
        question: input.question,
        language: lang,
        chunks: chunks.map((c) => ({ id: c.id, heading: c.heading_path, content: c.content })),
      }),
      facilityId: input.facilityId,
    });
    if (!res.ok) {
      const c = chunks[0];
      const answer = { answer: `${c.heading_path}\n${c.content}`.slice(0, 1200), path: 'rag', citations: [c.id] }; // deterministic fallback: best reviewed chunk
      kbAnswers.inc({ path: 'rag' });
      return answer;
    }
    if (res.data.is_medical_question) {
      const t = await render('kb.medical_redirect', lang, {});
      kbAnswers.inc({ path: 'medical_redirect' });
      return { answer: t.text, path: 'medical_redirect', citations: [], templateCode: 'kb.medical_redirect' };
    }
    const provided = new Set(chunks.map((c) => c.id));
    const cited = res.data.cited_chunk_ids.filter((id) => provided.has(id));
    if (cited.length === 0) return notFound();
    const answer = { answer: res.data.answer, path: 'rag', citations: cited };
    await cacheSet(cacheKey, answer, { ttlSeconds: 6 * 3600 });
    kbAnswers.inc({ path: 'rag' });
    return answer;
  },

  /** Self-care leaflet by symptom overlap: sent as written, never summarised. */
  async leafletFor(facilityId, symptomCodes, language) {
    if (symptomCodes.length === 0) return null;
    const rows = await withScope(STATE_SCOPE, (trx) => kbRepo.leafletChunks(trx, facilityId, symptomCodes, language));
    if (rows.length === 0) return null;
    const doc = rows[0].document_id;
    const text = rows
      .filter((r) => r.document_id === doc)
      .map((r) => r.content)
      .join('\n\n')
      .slice(0, 1500);
    return { documentId: doc, text };
  },

  // ---- documents ----
  async upload(trx, input) {
    const checksum = sha256(input.buf);
    const dup = await kbRepo.documentByChecksum(trx, input.facilityId, checksum);
    if (dup) return { document: dup, duplicate: true };
    const ext =
      input.mimeType === 'application/pdf'
        ? 'pdf'
        : input.mimeType.includes('wordprocessingml')
          ? 'docx'
          : input.mimeType === 'text/html'
            ? 'html'
            : input.mimeType === 'text/markdown'
              ? 'md'
              : 'txt';
    const docId = (await import('../../shared/ids.js')).newId();
    const key = storageKeys.kbDocument(input.facilityId, docId, ext);
    await putObject(key, input.buf, input.mimeType);
    const document = await kbRepo.insertDocument(trx, {
      facility_id: input.facilityId,
      doc_type: input.docType,
      title: input.title,
      language: input.language,
      storage_key: key,
      checksum,
      symptom_codes: input.symptomCodes,
      created_by: input.createdBy,
    });
    await enqueue(
      'kb-ingest',
      'ingest',
      { documentId: document.id, version: document.version, mimeType: input.mimeType },
      { jobId: `${document.id}:${document.version}` },
    );
    return { document, duplicate: false };
  },

  /** kb-ingest job: extract → normalise → chunk → contextual header → embed (batches of 64) → insert inactive chunks. */
  async ingest(documentId, mimeType) {
    const doc = await withScope(STATE_SCOPE, (trx) => kbRepo.documentById(trx, documentId));
    if (!doc) return;
    await withScope(STATE_SCOPE, (trx) => kbRepo.setDocumentStatus(trx, documentId, 'processing'));
    try {
      const buf = await getObject(doc.storage_key);
      const text = normaliseText(await extractText(buf, mimeType));
      const chunks = chunkText(text, doc.title);
      if (chunks.length === 0) throw new Error('no text extracted');
      const provider = embeddings();
      const vectors = await provider.embed(chunks.map((c) => `${c.headingPath}\n${c.content}`));
      await withScope(STATE_SCOPE, async (trx) => {
        await kbRepo.deleteChunks(trx, documentId);
        await kbRepo.insertChunks(
          trx,
          chunks.map((c, i) => ({
            document_id: documentId,
            facility_id: doc.facility_id,
            doc_type: doc.doc_type,
            language: c.language === 'en' && doc.language !== 'en' && !/[A-Za-z]{3,}/.test(c.content) ? doc.language : c.language,
            is_active: false,
            chunk_index: i,
            heading_path: c.headingPath,
            content: c.content,
            token_count: c.tokenCount,
            embedding: toVector(vectors[i]),
            embedding_model: provider.model,
          })),
        );
        await kbRepo.setDocumentStatus(trx, documentId, 'draft');
      });
    } catch (err) {
      await withScope(STATE_SCOPE, (trx) => kbRepo.setDocumentStatus(trx, documentId, 'failed', err.message.slice(0, 500)));
      throw err;
    }
  },

  /** Publish in one transaction: previous version archived (chunks inactive), new chunks active; then INCR kbver. */
  async publish(trx, documentId, approvedBy) {
    const doc = await kbRepo.documentById(trx, documentId);
    if (!doc) throw AppError.notFound('document');
    if (doc.status === 'processing' || doc.status === 'failed') throw new AppError('invalid_state', `document is ${doc.status}`);
    if ((await kbRepo.chunkCount(trx, documentId)) === 0)
      throw new AppError('invalid_state', 'document has no chunks yet (ingestion pending)');
    if (doc.doc_type === 'self_care_leaflet' && !doc.clinically_reviewed_by)
      throw new AppError('invalid_state', '🔒 self-care leaflets must be clinically reviewed before activation');
    for (const prev of await kbRepo.previousActiveVersions(trx, doc)) {
      await kbRepo.setChunksActive(trx, prev.id, false);
      await kbRepo.setDocumentStatus(trx, prev.id, 'archived');
    }
    await kbRepo.setChunksActive(trx, documentId, true);
    await trx.updateTable('kb_documents').set({ status: 'active', approved_by: approvedBy }).where('id', '=', documentId).execute();
    await writeOutbox(trx, {
      aggregateType: 'kb_document',
      aggregateId: documentId,
      eventType: 'kb.published',
      payload: { documentId, facilityId: doc.facility_id },
    });
    return { ...doc, status: 'active' };
  },
  async afterPublish(facilityId) {
    await redisCore.incr(keys.kbver(facilityId));
  },

  async archive(trx, documentId) {
    const doc = await kbRepo.documentById(trx, documentId);
    if (!doc) throw AppError.notFound('document');
    await kbRepo.setChunksActive(trx, documentId, false);
    await kbRepo.setDocumentStatus(trx, documentId, 'archived');
    await writeOutbox(trx, {
      aggregateType: 'kb_document',
      aggregateId: documentId,
      eventType: 'kb.published',
      payload: { documentId, facilityId: doc.facility_id, archived: true },
    });
  },

  // ---- FAQ ----
  async upsertFaq(trx, input) {
    const entry = input.id
      ? await kbRepo.updateFaq(trx, input.id, { topic: input.topic, answer_i18n: input.answer_i18n })
      : await kbRepo.insertFaq(trx, {
          facility_id: input.facilityId,
          topic: input.topic,
          answer_i18n: input.answer_i18n,
          source_document_id: null,
          approved_by: input.approvedBy,
        });
    if (!entry) throw AppError.notFound('faq');
    const provider = embeddings();
    const vectors = await provider.embed(input.variants.map((v) => normaliseQuestion(v.question)));
    await kbRepo.deleteFaqVariants(trx, entry.id);
    await kbRepo.insertFaqVariants(
      trx,
      input.variants.map((v, i) => ({
        faq_id: entry.id,
        facility_id: entry.facility_id,
        language: v.language,
        question: v.question,
        embedding: toVector(vectors[i]),
        embedding_model: provider.model,
      })),
    );
    return entry;
  },

  /** Nightly kb-eval: recall@5 and MRR of steps 3–4 (FAQ + hybrid) over kb_eval_cases. */
  async runEval() {
    const cases = await withScope(STATE_SCOPE, (trx) => kbRepo.allEvalCases(trx));
    if (cases.length === 0) return null;
    let hits = 0,
      rr = 0;
    const perFacility = new Map();
    for (const c of cases) {
      const emb = await questionEmbedding(normaliseQuestion(c.question));
      if (!emb) continue;
      const rows = await withScope(STATE_SCOPE, (trx) =>
        kbRepo.hybrid(trx, toVector(emb), c.question, c.facility_id, [c.language, 'en'], 5),
      );
      const idx = c.expected_document_id
        ? rows.findIndex((r) => r.document_id === c.expected_document_id)
        : rows.findIndex((r) => c.expected_answer_contains.some((s) => r.content.toLowerCase().includes(s.toLowerCase())));
      const k = `${c.facility_id ?? 'state'}|${c.language}`;
      const pf = perFacility.get(k) ?? { hits: 0, n: 0 };
      pf.n++;
      if (idx >= 0) {
        hits++;
        rr += 1 / (idx + 1);
        pf.hits++;
      }
      perFacility.set(k, pf);
    }
    const recall = hits / cases.length,
      mrr = rr / cases.length;
    for (const [k, v] of perFacility) {
      const [f, l] = k.split('|');
      kbEvalRecall.set({ facility: f, language: l }, v.hits / v.n);
    }
    const prev = await withScope(STATE_SCOPE, (trx) => kbRepo.lastEvalRun(trx));
    await withScope(STATE_SCOPE, (trx) =>
      kbRepo.insertEvalRun(trx, {
        embedding_model: embeddings().model,
        cases: cases.length,
        recall_at_5: recall,
        mrr,
        details: { per_slice: Object.fromEntries(perFacility) },
      }),
    );
    if (recall < 0.9 || (prev && Number(prev.recall_at_5) - recall > 0.05))
      logger.warn({ recall, prev: prev?.recall_at_5 }, 'ALERT kb recall@5 below threshold or dropped > 5 points');
    return { cases: cases.length, recall_at_5: recall, mrr };
  },
};
