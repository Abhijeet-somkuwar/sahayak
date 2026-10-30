import { z } from 'zod';

import { withScope } from '../../infra/db.js';
import { AppError } from '../../shared/errors.js';
import { requireStaff } from '../../shared/auth.js';
import { scopeOf } from '../../shared/http.js';
import { assertClinicalAccess } from '../../shared/access.js';
import { patientDocsRepo } from './repo.js';
import { patientDocsService } from './service.js';

const pid = z.object({ id: z.string().uuid() });
const IMAGE_OR_PDF = (buf) =>
  buf.subarray(0, 5).toString() === '%PDF-'
    ? 'application/pdf'
    : buf[0] === 0xff && buf[1] === 0xd8
      ? 'image/jpeg'
      : buf[0] === 0x89 && buf[1] === 0x50
        ? 'image/png'
        : null;

export async function patientDocsRoutes(app) {
  app.post(
    '/api/v1/patients/:id/documents',
    { config: { permission: 'patient.demographics.write' }, schema: { tags: ['patientdocs'], params: pid, hide: true } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const file = await req.file();
      if (!file) throw AppError.validation('multipart file is required');
      const buf = await file.toBuffer();
      const mime = IMAGE_OR_PDF(buf);
      if (!mime) throw new AppError('unsupported_media_type', 'only PDF, JPEG and PNG are accepted');
      const kind = z
        .enum(['old_prescription', 'lab_report', 'discharge_summary', 'referral_letter', 'imaging_report', 'other'])
        .catch('other')
        .parse(file.fields['kind']?.value);
      const row = await withScope(scopeOf(req.principal), (trx) =>
        patientDocsService.upload(trx, {
          patientId: req.params.id,
          encounterId: null,
          kind,
          buf,
          mimeType: mime,
          via: 'web',
          uploadedBy: staff.userId,
        }),
      );
      req.audit.record({
        action: 'patientdocs.upload',
        resourceType: 'patient_document',
        resourceId: row.id,
        patientId: req.params.id,
        purpose: 'treatment',
      });
      return reply.code(201).send(row);
    },
  );

  app.get(
    '/api/v1/patients/:id/documents',
    { config: { permission: 'patient.clinical.read' }, schema: { tags: ['patientdocs'], params: pid } },
    async (req) => {
      const staff = requireStaff(req);
      return withScope(scopeOf(req.principal), async (trx) => {
        const purpose = await assertClinicalAccess(trx, staff, req.params.id, req.audit);
        req.audit.record({
          action: 'patientdocs.read',
          resourceType: 'patient',
          resourceId: req.params.id,
          patientId: req.params.id,
          purpose,
        });
        return { label: 'patient-provided, unverified', items: await patientDocsRepo.forPatient(trx, req.params.id) };
      });
    },
  );

  app.post(
    '/api/v1/patients/:id/ask',
    {
      config: { permission: 'patient.clinical.read' },
      schema: { tags: ['patientdocs'], params: pid, body: z.object({ question: z.string().min(3).max(500) }).strict() },
    },
    async (req) => {
      const staff = requireStaff(req);
      return withScope(scopeOf(req.principal), async (trx) => {
        const purpose = await assertClinicalAccess(trx, staff, req.params.id, req.audit);
        req.audit.record({
          action: 'patientdocs.read',
          resourceType: 'patient',
          resourceId: req.params.id,
          patientId: req.params.id,
          purpose,
          details: { qa: true },
        });
        return patientDocsService.ask(trx, req.params.id, req.body.question);
      });
    },
  );
}
