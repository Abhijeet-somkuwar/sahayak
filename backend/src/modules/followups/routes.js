import { z } from 'zod';

import { withScope } from '../../infra/db.js';
import { requireStaff, requirePatient } from '../../shared/auth.js';
import { scopeOf } from '../../shared/http.js';
import { followupsRepo } from './repo.js';
import { followupsService } from './service.js';

const idParam = z.object({ id: z.string().uuid() });

export async function followupsRoutes(app) {
  app.get(
    '/api/v1/encounters/:id/followups',
    { config: { permission: 'patient.clinical.read' }, schema: { tags: ['followups'], params: idParam } },
    async (req) => {
      requireStaff(req);
      return { items: await withScope(scopeOf(req.principal), (trx) => followupsRepo.forEncounter(trx, req.params.id)) };
    },
  );

  app.post(
    '/api/v1/encounters/:id/followups/report-ready',
    { config: { permission: 'queue.checkin' }, schema: { tags: ['followups'], params: idParam } },
    async (req, reply) => {
      requireStaff(req);
      const row = await withScope(scopeOf(req.principal), (trx) => followupsService.reportReady(trx, req.params.id));
      req.audit.record({ action: 'followup.report_ready', resourceType: 'encounter', resourceId: req.params.id, purpose: 'treatment' });
      return reply.code(201).send(row);
    },
  );

  // Web channel response to a symptom check-in (WhatsApp replies arrive through the whatsapp adapter).
  app.post(
    '/api/v1/followups/:id/respond',
    {
      schema: {
        tags: ['followups'],
        params: idParam,
        body: z
          .object({ encounter_id: z.string().uuid(), answer: z.enum(['better', 'same', 'worse']), text: z.string().max(1000).optional() })
          .strict(),
      },
    },
    async (req) => {
      requirePatient(req);
      return followupsService.respond(req.body.encounter_id, req.params.id, req.body.answer, req.body.text);
    },
  );
}
