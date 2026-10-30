import { z } from 'zod';

import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { requireStaff } from '../../shared/auth.js';
import { triageRepo } from './repo.js';
import { triageService } from './service.js';
import { AppError } from '../../shared/errors.js';

const rid = z.object({ id: z.string().uuid() });

export async function triageRoutes(app) {
  app.get('/api/v1/triage/rule-sets', { config: { permission: 'rules.author' }, schema: { tags: ['triage'] } }, async () => ({
    items: await withScope(STATE_SCOPE, (trx) => triageRepo.list(trx)),
  }));

  app.get(
    '/api/v1/triage/rule-sets/:id',
    { config: { permission: 'rules.author' }, schema: { tags: ['triage'], params: rid } },
    async (req) => {
      const row = await withScope(STATE_SCOPE, (trx) => triageRepo.byId(trx, req.params.id));
      if (!row) throw AppError.notFound('rule set');
      return { ...row, checksum: row.checksum.toString('hex') };
    },
  );

  app.post(
    '/api/v1/triage/rule-sets',
    {
      config: { permission: 'rules.author' },
      schema: {
        tags: ['triage'],
        body: z
          .object({ rules: z.unknown(), test_cases: z.array(z.unknown()).min(1), notes: z.string().max(2000).nullable().optional() })
          .strict(),
      },
    },
    async (req, reply) => {
      const staff = requireStaff(req);
      const row = await withScope(STATE_SCOPE, (trx) => triageService.createDraft(trx, req.body, staff.userId));
      req.audit.record({
        action: 'rules.draft',
        resourceType: 'triage_rule_set',
        resourceId: row.id,
        purpose: 'administration',
        details: { version: row.version },
      });
      return reply.code(201).send({ ...row, checksum: row.checksum.toString('hex') });
    },
  );

  app.post(
    '/api/v1/triage/rule-sets/:id/test',
    { config: { permission: 'rules.author' }, schema: { tags: ['triage'], params: rid } },
    async (req) => withScope(STATE_SCOPE, (trx) => triageService.test(trx, req.params.id)),
  );

  app.post(
    '/api/v1/triage/rule-sets/:id/approve',
    { config: { permission: 'rules.approve' }, schema: { tags: ['triage'], params: rid } },
    async (req) => {
      const staff = requireStaff(req);
      const row = await withScope(STATE_SCOPE, (trx) => triageService.approve(trx, req.params.id, staff.userId));
      req.audit.record({
        action: 'rules.approve',
        resourceType: 'triage_rule_set',
        resourceId: row.id,
        purpose: 'administration',
        details: { version: row.version },
      });
      return { id: row.id, version: row.version, status: row.status, approved_by: row.approved_by };
    },
  );

  app.post(
    '/api/v1/triage/rule-sets/:id/publish',
    { config: { permission: 'rules.approve' }, schema: { tags: ['triage'], params: rid } },
    async (req) => {
      const staff = requireStaff(req);
      const row = await withScope(STATE_SCOPE, (trx) => triageService.publish(trx, req.params.id, staff.userId));
      await triageService.afterPublish();
      req.audit.record({
        action: 'rules.publish',
        resourceType: 'triage_rule_set',
        resourceId: row.id,
        purpose: 'administration',
        details: { version: row.version },
      });
      return { id: row.id, version: row.version, status: row.status, published_at: row.published_at };
    },
  );
}
