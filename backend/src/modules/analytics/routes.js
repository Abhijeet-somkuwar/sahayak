import { z } from 'zod';

import { withReplicaScope, STATE_SCOPE } from '../../infra/db.js';
import { assertFacilityAccess, assertPermission, requireStaff } from '../../shared/auth.js';
import { scopeOf } from '../../shared/http.js';
import { analyticsRepo } from './repo.js';
import { istDate, addDays } from '../../shared/time.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = z.object({ from: dateStr.optional(), to: dateStr.optional() });
const idParam = z.object({ id: z.string().uuid() });

export async function analyticsRoutes(app) {
  const resolveRange = (q) => ({ from: q.from ?? addDays(istDate(), -30), to: q.to ?? istDate() });

  app.get(
    '/api/v1/analytics/facilities/:id/daily',
    { config: { permission: 'facility.analytics' }, schema: { tags: ['analytics'], params: idParam, querystring: range } },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      const { from, to } = resolveRange(req.query);
      return { items: await withReplicaScope(scopeOf(req.principal), (trx) => analyticsRepo.daily(trx, req.params.id, from, to)) }; // dashboards read rollups from a replica
    },
  );
  app.get(
    '/api/v1/analytics/facilities/:id/hourly',
    { config: { permission: 'facility.analytics' }, schema: { tags: ['analytics'], params: idParam, querystring: range } },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      const { from, to } = resolveRange(req.query);
      return { items: await withReplicaScope(scopeOf(req.principal), (trx) => analyticsRepo.hourly(trx, req.params.id, from, to)) };
    },
  );
  app.get('/api/v1/analytics/state/daily', { schema: { tags: ['analytics'], querystring: range } }, async (req) => {
    requireStaff(req);
    assertPermission(req, 'state.analytics');
    const { from, to } = resolveRange(req.query);
    return { items: await withReplicaScope(STATE_SCOPE, (trx) => analyticsRepo.stateDaily(trx, from, to)) };
  });
}
