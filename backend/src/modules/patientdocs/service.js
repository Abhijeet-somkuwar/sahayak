/**
 * Patient documents (phase 2, §9.8). 🔒 Content is always labelled "patient-provided, unverified" and never updates
 * allergies, conditions or medications automatically.
 */
import { z } from 'zod';
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { sha256 } from '../../infra/crypto.js';
import { embeddings, embedOne } from '../../infra/embeddings/index.js';
import { toVector } from '../../infra/db.types.js';
import { deidentify, llm } from '../../infra/llm/index.js';
import { enqueue } from '../../infra/queues.js';
import { getObject, putObject, storageKeys } from '../../infra/storage.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { chunkText, extractText, normaliseText } from '../kb/ingest.js';
import { patientDocsRepo } from './repo.js';
import { docExtractPromptV1 } from './prompts/doc_extract.v1.js';

export const UNVERIFIED_LABEL = 'patient-provided, unverified';

const qaSchema = z.object({ answer: z.string().max(800), cited_chunks: z.array(z.number().int()).max(6), can_answer: z.boolean() });
const doctorQaPrompt = {
  id: 'patientdocs.doctor_qa',
  version: 1,
  toolName: 'answer_doctor',
  toolDescription: 'Answer the clinician strictly from the patient-provided document chunks.',
  schema: qaSchema,
  system:
    "You answer a clinician's question about documents a patient uploaded (old prescriptions, reports). Use only the chunks; cite chunk idx values. If the chunks do not contain the answer set can_answer=false. These documents are patient-provided and unverified; say so when relevant. No diagnosis or treatment advice.",
  build: (i) => `CHUNKS:\n${i.chunks.map((c) => `[${c.idx}] ${c.content}`).join('\n\n')}\n\n<question>${i.question}</question>`,
};

export const patientDocsService = {
  async upload(trx, input) {
    const sha = sha256(input.buf);
    const dup = await patientDocsRepo.bySha(trx, input.patientId, sha);
    if (dup) return dup;
    const ext =
      input.mimeType === 'application/pdf' ? 'pdf' : input.mimeType.startsWith('image/') ? (input.mimeType.split('/')[1] ?? 'bin') : 'bin';
    const id = newId();
    const key = storageKeys.patientDocument(input.patientId, id, ext);
    await putObject(key, input.buf, input.mimeType); // server-side encryption; never on local disk
    const row = await patientDocsRepo.insert(trx, {
      patient_id: input.patientId,
      encounter_id: input.encounterId,
      kind: input.kind,
      storage_key: key,
      mime_type: input.mimeType,
      sha256: sha,
      uploaded_via: input.via,
      uploaded_by_user_id: input.uploadedBy,
    });
    if (!row) throw AppError.conflict('duplicate document');
    await enqueue('patient-doc-extract', 'extract', { documentId: row.id }, { jobId: row.id });
    return row;
  },

  /** patient-doc-extract job: text (PDF/text) or vision (images via the smart model) → chunks → embeddings. */
  async extract(documentId) {
    const doc = await withScope(STATE_SCOPE, (trx) => patientDocsRepo.byId(trx, documentId));
    if (!doc) return;
    try {
      const buf = await getObject(doc.storage_key);
      let text = '';
      if (doc.mime_type === 'application/pdf' || doc.mime_type.startsWith('text/'))
        text = normaliseText(await extractText(buf, doc.mime_type));
      if (!text) {
        await withScope(STATE_SCOPE, (trx) =>
          patientDocsRepo.setExtraction(trx, documentId, doc.mime_type.startsWith('image/') ? 'failed' : 'skipped'),
        );
        return;
      } // image OCR/vision: phase 2 provider
      const res = await llm.call({
        purpose: 'patient_doc_extract',
        prompt: docExtractPromptV1,
        input: deidentify({ kind: doc.kind, text: text.slice(0, 12_000) }),
      });
      const chunks = chunkText(text, `${doc.kind} (${UNVERIFIED_LABEL})`);
      if (res.ok)
        chunks.unshift({ headingPath: 'summary', content: `[${UNVERIFIED_LABEL}] ${res.data.summary}`, tokenCount: 100, language: 'en' });
      const provider = embeddings();
      const vectors = await provider.embed(chunks.map((c) => c.content));
      await withScope(STATE_SCOPE, async (trx) => {
        await patientDocsRepo.replaceChunks(
          trx,
          documentId,
          doc.patient_id,
          chunks.map((c, i) => ({ chunk_index: i, content: c.content, embedding: toVector(vectors[i]), embedding_model: provider.model })),
        );
        await patientDocsRepo.setExtraction(
          trx,
          documentId,
          'done',
          res.ok ? { document_date: res.data.document_date, source_facility_name: res.data.source_facility_name } : {},
        );
      });
    } catch (err) {
      await withScope(STATE_SCOPE, (trx) => patientDocsRepo.setExtraction(trx, documentId, 'failed'));
      throw err;
    }
  },

  /** Doctor Q&A over one patient's documents (Q10, exact search). */
  async ask(trx, patientId, question) {
    const emb = await embedOne(question);
    const chunks = await patientDocsRepo.search(trx, patientId, toVector(emb));
    if (chunks.length === 0)
      return { answer: 'No patient-provided documents are available for this patient.', label: UNVERIFIED_LABEL, citations: [] };
    const res = await llm.call({
      purpose: 'doctor_qa',
      prompt: doctorQaPrompt,
      input: deidentify({ question, chunks: chunks.map((c, idx) => ({ idx, content: c.content })) }),
    });
    if (!res.ok || !res.data.can_answer)
      return {
        answer: 'Could not answer from the uploaded documents; please open the documents directly.',
        label: UNVERIFIED_LABEL,
        citations: chunks.slice(0, 3).map((c) => ({ document_id: c.document_id, chunk_index: c.chunk_index })),
      };
    const cited = res.data.cited_chunks
      .filter((i) => i >= 0 && i < chunks.length)
      .map((i) => ({ document_id: chunks[i].document_id, chunk_index: chunks[i].chunk_index }));
    return { answer: `[${UNVERIFIED_LABEL}] ${res.data.answer}`, label: UNVERIFIED_LABEL, citations: cited };
  },
};
