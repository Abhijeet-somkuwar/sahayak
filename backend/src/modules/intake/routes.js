import { z } from 'zod';

import { requirePatientOrDevice } from '../../shared/auth.js';
import { intakeService } from './service.js';

const idParam = z.object({ id: z.string().uuid() });
const answerBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal('choice'), id: z.string().min(1).max(200), title: z.string().max(100).optional() }),
  z.object({ kind: z.literal('location'), latitude: z.number(), longitude: z.number() }),
  z.object({ kind: z.literal('start'), facilityCode: z.string().max(32).nullable().optional() }),
]);

export async function intakeRoutes(app) {
  app.post(
    '/api/v1/intake/sessions',
    {
      schema: {
        tags: ['intake'],
        body: z
          .object({
            facility_code: z.string().max(32).nullable().optional(),
            facility_id: z.string().uuid().nullable().optional(),
            language: z.string().max(10).default('hi'),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      const p = requirePatientOrDevice(req);
      return reply.code(201).send(await intakeService.start(p, req.body));
    },
  );
  app.post('/api/v1/intake/sessions/:id/answers', { schema: { tags: ['intake'], params: idParam, body: answerBody } }, async (req) => {
    const p = requirePatientOrDevice(req);
    const idem = req.headers['idempotency-key'];
    return intakeService.answer(p, req.params.id, req.body, typeof idem === 'string' ? idem : undefined);
  });
  app.get('/api/v1/intake/sessions/:id', { schema: { tags: ['intake'], params: idParam } }, async (req) =>
    intakeService.resume(requirePatientOrDevice(req), req.params.id),
  );
  app.post(
    '/api/v1/bookings/:encounterId/cancel',
    { schema: { tags: ['intake'], params: z.object({ encounterId: z.string().uuid() }) } },
    async (req, reply) => {
      await intakeService.cancelBooking(req.principal, req.params.encounterId);
      req.audit.record({ action: 'booking.cancel', resourceType: 'encounter', resourceId: req.params.encounterId, purpose: 'treatment' });
      return reply.code(204).send();
    },
  );
}
