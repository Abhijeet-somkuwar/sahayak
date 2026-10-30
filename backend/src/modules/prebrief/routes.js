import { z } from 'zod';

import { withScope } from '../../infra/db.js';
import { requireStaff } from '../../shared/auth.js';
import { scopeOf } from '../../shared/http.js';
import { assertClinicalAccess } from '../../shared/access.js';
import { queueService } from '../queue/service.js';
import { prebriefService } from './service.js';

const idParam = z.object({ id: z.string().uuid() });

export async function prebriefRoutes(app) {
  app.get(
    '/api/v1/encounters/:id/prebrief',
    { config: { permission: 'patient.clinical.read' }, schema: { tags: ['prebrief'], params: idParam } },
    async (req) => {
      const staff = requireStaff(req);
      return withScope(scopeOf(req.principal), async (trx) => {
        const e = await queueService.encounter(trx, req.params.id);
        const purpose = e.patient_id ? await assertClinicalAccess(trx, staff, e.patient_id, req.audit) : 'treatment';
        const pb = await prebriefService.view(trx, e.id, staff.userId);
        req.audit.record({
          action: 'prebrief.view',
          resourceType: 'prebrief',
          resourceId: pb.prebrief_id ?? e.id,
          patientId: e.patient_id,
          facilityId: e.facility_id,
          purpose,
        });
        return pb;
      });
    },
  );

  // The doctor's "Try again": regenerate (for example after the AI was rate limited). prebrief.ready follows.
  app.post(
    '/api/v1/encounters/:id/prebrief/regenerate',
    { config: { permission: 'patient.clinical.read' }, schema: { tags: ['prebrief'], params: idParam } },
    async (req, reply) => {
      const staff = requireStaff(req);
      await withScope(scopeOf(req.principal), async (trx) => {
        const e = await queueService.encounter(trx, req.params.id);
        if (e.patient_id) await assertClinicalAccess(trx, staff, e.patient_id, req.audit);
      });
      await prebriefService.regenerate(req.params.id);
      req.audit.record({ action: 'prebrief.regenerate', resourceType: 'encounter', resourceId: req.params.id, purpose: 'treatment' });
      return reply.code(202).send({ queued: true });
    },
  );

  app.post(
    '/api/v1/encounters/:id/prebrief/feedback',
    {
      config: { permission: 'prebrief.feedback' },
      schema: {
        tags: ['prebrief'],
        params: idParam,
        body: z.object({ feedback: z.union([z.literal(1), z.literal(-1)]), note: z.string().max(500).nullable().default(null) }).strict(),
      },
    },
    async (req) => {
      requireStaff(req);
      const row = await withScope(scopeOf(req.principal), (trx) =>
        prebriefService.feedback(trx, req.params.id, req.body.feedback, req.body.note),
      );
      req.audit.record({
        action: 'prebrief.feedback',
        resourceType: 'prebrief',
        resourceId: row?.id ?? req.params.id,
        purpose: 'treatment',
        details: { feedback: req.body.feedback },
      });
      return { ok: true, feedback: row?.feedback };
    },
  );
}
