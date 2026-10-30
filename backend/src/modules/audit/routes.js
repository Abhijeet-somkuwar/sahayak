import { z } from 'zod';

import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { AppError } from '../../shared/errors.js';
import { requireStaff } from '../../shared/auth.js';
import { auditRepo } from './repo.js';
import { auditService } from './service.js';

const idParam = z.object({ id: z.string().uuid() });

export async function auditRoutes(app) {
  app.get(
    '/api/v1/audit/patients/:id/access-log',
    { config: { permission: 'audit.read' }, schema: { tags: ['audit'], params: idParam } },
    async (req) => {
      const items = await withScope(STATE_SCOPE, (trx) => auditService.accessLog(trx, req.params.id));
      req.audit.record({
        action: 'audit.access_log.read',
        resourceType: 'patient',
        resourceId: req.params.id,
        patientId: req.params.id,
        purpose: 'audit',
      });
      return { items };
    },
  );

  // Patients can see who accessed their household's records (right of access).
  app.get('/api/v1/me/access-log/:id', { schema: { tags: ['patient'], params: idParam } }, async (req) => {
    if (req.principal.kind !== 'patient') throw new AppError('unauthenticated');
    const cp = req.principal.contactPointId;
    return withScope(STATE_SCOPE, async (trx) => {
      if (!(await auditRepo.contactLinkedToPatient(trx, cp, req.params.id))) throw AppError.notFound('patient');
      req.audit.record({
        action: 'audit.access_log.read',
        resourceType: 'patient',
        resourceId: req.params.id,
        patientId: req.params.id,
        purpose: 'audit',
      });
      return { items: await auditService.accessLog(trx, req.params.id) };
    });
  });

  app.get(
    '/api/v1/audit/breakglass',
    {
      config: { permission: 'audit.read' },
      schema: { tags: ['audit'], querystring: z.object({ status: z.enum(['pending', 'reviewed']).default('pending') }) },
    },
    async (req) => ({ items: await withScope(STATE_SCOPE, (trx) => auditService.breakglassQueue(trx, req.query.status)) }),
  );

  app.post(
    '/api/v1/audit/breakglass/:id/review',
    {
      config: { permission: 'audit.read' },
      schema: {
        tags: ['audit'],
        params: idParam,
        body: z.object({ outcome: z.enum(['justified', 'unjustified', 'needs_followup']), note: z.string().max(1000).optional() }).strict(),
      },
    },
    async (req) => {
      const staff = requireStaff(req);
      const ev = await withScope(STATE_SCOPE, (trx) => auditRepo.eventById(trx, req.params.id));
      if (!ev || ev.action !== 'breakglass.open') throw AppError.notFound('break-glass event');
      req.audit.record({
        action: 'breakglass.review',
        resourceType: 'audit_event',
        resourceId: ev.id,
        patientId: ev.patient_id,
        facilityId: ev.facility_id,
        purpose: 'audit',
        details: { outcome: req.body.outcome, note: req.body.note ?? null, reviewer: staff.userId },
      });
      return { reviewed: ev.id, outcome: req.body.outcome };
    },
  );

  app.get(
    '/api/v1/audit/consents/:id',
    { config: { permission: 'audit.read' }, schema: { tags: ['audit'], params: idParam } },
    async (req) => {
      req.audit.record({ action: 'audit.consent_ledger.read', resourceType: 'contact_point', resourceId: req.params.id, purpose: 'audit' });
      return { items: await withScope(STATE_SCOPE, (trx) => auditRepo.consentLedger(trx, req.params.id)) };
    },
  );

  app.post(
    '/api/v1/audit/data-requests',
    {
      config: { permission: 'audit.read' },
      schema: {
        tags: ['audit'],
        body: z
          .object({
            kind: z.enum(['access', 'correction', 'erasure']),
            contact_point_id: z.string().uuid(),
            patient_id: z.string().uuid().nullable().default(null),
            decision: z.string().min(5).max(1000),
          })
          .strict(),
      },
    },
    async (req) => {
      const staff = requireStaff(req);
      let result = null;
      if (req.body.kind === 'erasure')
        result = await withScope(STATE_SCOPE, (trx) => auditService.eraseNonClinical(trx, req.body.contact_point_id));
      req.audit.record({
        action: `data_request.${req.body.kind}`,
        resourceType: 'contact_point',
        resourceId: req.body.contact_point_id,
        patientId: req.body.patient_id,
        purpose: 'audit',
        details: { decision: req.body.decision, by: staff.userId, result },
      });
      return { kind: req.body.kind, result };
    },
  );
}
