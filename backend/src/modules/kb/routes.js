import { z } from 'zod';

import multipart from '@fastify/multipart';
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { AppError } from '../../shared/errors.js';
import { assertFacilityAccess, requireStaff } from '../../shared/auth.js';
import { scopeOf } from '../../shared/http.js';
import { kbRepo } from './repo.js';
import { kbService } from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/plain',
  'text/markdown',
]);

/** Magic-byte type detection (§13.4): never trust the declared content type alone. */
export function sniffMime(buf, declared) {
  if (buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const head = buf.subarray(0, 512).toString('utf8').toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype html')) return 'text/html';
  if (declared === 'text/markdown' || declared === 'text/plain') return declared;
  return 'text/plain';
}

export async function kbRoutes(app) {
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024, files: 1 } });

  app.post(
    '/api/v1/kb/ask',
    {
      config: { public: true, rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['kb'],
        body: z
          .object({
            question: z.string().min(2).max(500),
            facility_id: z.string().uuid().nullable().optional(),
            facility_code: z.string().max(32).optional(),
            language: z.string().max(10).default('hi'),
          })
          .strict(),
      },
    },
    async (req) => {
      let facilityId = req.body.facility_id ?? null;
      if (!facilityId && req.body.facility_code) {
        const { intakeRepo } = await import('../intake/repo.js');
        facilityId = (await withScope(STATE_SCOPE, (trx) => intakeRepo.facilityByCode(trx, req.body.facility_code)))?.id ?? null;
      }
      const lang = req.principal.kind === 'patient' ? req.principal.language : req.body.language;
      return kbService.ask({ question: req.body.question, facilityId, language: lang, channel: 'web' });
    },
  );

  app.get(
    '/api/v1/kb/documents',
    { config: { permission: 'kb.manage' }, schema: { tags: ['kb'], querystring: z.object({ facility_id: z.string().uuid().optional() }) } },
    async (req) => {
      const staff = requireStaff(req);
      const facilityId = req.query.facility_id ?? staff.facilityIds[0] ?? null;
      if (facilityId) assertFacilityAccess(req, facilityId);
      return { items: await withScope(STATE_SCOPE, (trx) => kbRepo.documents(trx, facilityId)) };
    },
  );

  app.post('/api/v1/kb/documents', { config: { permission: 'kb.manage' }, schema: { tags: ['kb'], hide: true } }, async (req, reply) => {
    const staff = requireStaff(req);
    const file = await req.file();
    if (!file) throw AppError.validation('multipart file is required');
    const buf = await file.toBuffer();
    const fields = Object.fromEntries(Object.entries(file.fields).map(([k, v]) => [k, v?.value ?? '']));
    const meta = z
      .object({
        facility_id: z.string().uuid().optional(),
        doc_type: z.enum(['timings', 'department_info', 'scheme', 'wayfinding', 'faq', 'self_care_leaflet', 'sop', 'notice']),
        title: z.string().min(1).max(200),
        language: z.string().max(10).default('hi'),
        symptom_codes: z.string().optional(),
      })
      .parse(fields);
    const facilityId = meta.facility_id ?? (staff.stateScope ? null : (staff.facilityIds[0] ?? null));
    if (facilityId) assertFacilityAccess(req, facilityId);
    const mime = sniffMime(buf, file.mimetype);
    if (!ALLOWED_MIME.has(mime)) throw new AppError('unsupported_media_type', `unsupported file type ${mime}`);
    const result = await withScope(STATE_SCOPE, (trx) =>
      kbService.upload(trx, {
        facilityId,
        docType: meta.doc_type,
        title: meta.title,
        language: meta.language,
        symptomCodes: meta.symptom_codes
          ? meta.symptom_codes
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        buf,
        mimeType: mime,
        createdBy: staff.userId,
      }),
    );
    req.audit.record({
      action: 'kb.document.upload',
      resourceType: 'kb_document',
      resourceId: result.document.id,
      facilityId,
      purpose: 'administration',
      details: { duplicate: result.duplicate },
    });
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.post(
    '/api/v1/kb/documents/:id/review',
    { config: { permission: 'templates.review' }, schema: { tags: ['kb'], params: idParam } },
    async (req) => {
      const staff = requireStaff(req);
      const row = await withScope(STATE_SCOPE, (trx) => kbRepo.setReviewed(trx, req.params.id, staff.userId));
      if (!row) throw AppError.notFound('document');
      req.audit.record({ action: 'kb.document.review', resourceType: 'kb_document', resourceId: row.id, purpose: 'administration' });
      return row;
    },
  );

  app.post(
    '/api/v1/kb/documents/:id/publish',
    { config: { permission: 'kb.manage' }, schema: { tags: ['kb'], params: idParam } },
    async (req) => {
      const staff = requireStaff(req);
      const doc = await withScope(scopeOf(req.principal), (trx) => kbService.publish(trx, req.params.id, staff.userId));
      await kbService.afterPublish(doc.facility_id);
      req.audit.record({
        action: 'kb.document.publish',
        resourceType: 'kb_document',
        resourceId: doc.id,
        facilityId: doc.facility_id,
        purpose: 'administration',
      });
      return doc;
    },
  );

  app.post(
    '/api/v1/kb/documents/:id/archive',
    { config: { permission: 'kb.manage' }, schema: { tags: ['kb'], params: idParam } },
    async (req, reply) => {
      const doc = await withScope(STATE_SCOPE, async (trx) => {
        const d = await kbRepo.documentById(trx, req.params.id);
        await kbService.archive(trx, req.params.id);
        return d;
      });
      await kbService.afterPublish(doc?.facility_id ?? null);
      req.audit.record({
        action: 'kb.document.archive',
        resourceType: 'kb_document',
        resourceId: req.params.id,
        purpose: 'administration',
      });
      return reply.code(204).send();
    },
  );

  // ---- FAQ CRUD ----
  const faqBody = z
    .object({
      facility_id: z.string().uuid().nullable().optional(),
      topic: z.string().min(1).max(200),
      answer_i18n: z.record(z.string(), z.string().max(1500)),
      variants: z
        .array(z.object({ language: z.string().max(10), question: z.string().min(2).max(300) }))
        .min(1)
        .max(50),
    })
    .strict();
  app.get(
    '/api/v1/faq',
    { config: { permission: 'kb.manage' }, schema: { tags: ['kb'], querystring: z.object({ facility_id: z.string().uuid().optional() }) } },
    async (req) => {
      const staff = requireStaff(req);
      const items = await withScope(STATE_SCOPE, async (trx) => {
        const faqs = await kbRepo.faqs(trx, req.query.facility_id ?? staff.facilityIds[0] ?? null);
        return Promise.all(faqs.map(async (f) => ({ ...f, variants: await kbRepo.faqVariants(trx, f.id) })));
      });
      return { items };
    },
  );
  app.post('/api/v1/faq', { config: { permission: 'kb.manage' }, schema: { tags: ['kb'], body: faqBody } }, async (req, reply) => {
    const staff = requireStaff(req);
    const facilityId = req.body.facility_id ?? (staff.stateScope ? null : (staff.facilityIds[0] ?? null));
    const row = await withScope(STATE_SCOPE, (trx) =>
      kbService.upsertFaq(trx, {
        facilityId,
        topic: req.body.topic,
        answer_i18n: req.body.answer_i18n,
        variants: req.body.variants,
        approvedBy: staff.userId,
      }),
    );
    await kbService.afterPublish(facilityId);
    return reply.code(201).send(row);
  });
  app.put(
    '/api/v1/faq/:id',
    { config: { permission: 'kb.manage' }, schema: { tags: ['kb'], params: idParam, body: faqBody } },
    async (req) => {
      const staff = requireStaff(req);
      const row = await withScope(STATE_SCOPE, (trx) =>
        kbService.upsertFaq(trx, {
          id: req.params.id,
          facilityId: req.body.facility_id ?? null,
          topic: req.body.topic,
          answer_i18n: req.body.answer_i18n,
          variants: req.body.variants,
          approvedBy: staff.userId,
        }),
      );
      await kbService.afterPublish(row.facility_id);
      return row;
    },
  );
  app.delete('/api/v1/faq/:id', { config: { permission: 'kb.manage' }, schema: { tags: ['kb'], params: idParam } }, async (req, reply) => {
    const row = await withScope(STATE_SCOPE, (trx) => kbRepo.updateFaq(trx, req.params.id, { status: 'inactive' }));
    await kbService.afterPublish(row?.facility_id ?? null);
    return reply.code(204).send();
  });

  app.post(
    '/api/v1/kb/eval-cases',
    {
      config: { permission: 'kb.manage' },
      schema: {
        tags: ['kb'],
        body: z
          .object({
            facility_id: z.string().uuid().nullable().default(null),
            language: z.string().max(10),
            question: z.string().min(2).max(300),
            expected_document_id: z.string().uuid().nullable().default(null),
            expected_answer_contains: z.array(z.string()).default([]),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      const staff = requireStaff(req);
      return reply
        .code(201)
        .send(await withScope(STATE_SCOPE, (trx) => kbRepo.insertEvalCase(trx, { ...req.body, created_by: staff.userId })));
    },
  );
  app.post(
    '/api/v1/kb/eval/run',
    { config: { permission: 'kb.manage' }, schema: { tags: ['kb'] } },
    async () => (await kbService.runEval()) ?? { cases: 0 },
  );
}
