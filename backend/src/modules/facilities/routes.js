import { z } from 'zod';

import { withScope, withReplicaScope, STATE_SCOPE } from '../../infra/db.js';
import { AppError } from '../../shared/errors.js';
import { assertFacilityAccess, assertPermission, requireStaff } from '../../shared/auth.js';
import { scopeOf } from '../../shared/http.js';
import { pick } from '../../shared/i18n.js';
import { istDate, istIsoWeekday } from '../../shared/time.js';
import { facilitiesRepo } from './repo.js';
import { facilitiesService, getFacilityConfig, invalidateFacilityConfig } from './service.js';
import * as S from './schemas.js';
import { waitboard } from '../queue/service.js';

export async function facilitiesRoutes(app) {
  // ---- Public ----
  app.get(
    '/api/v1/facilities/:code/public',
    {
      config: { public: true, rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { tags: ['public'], params: z.object({ code: z.string() }), querystring: z.object({ lang: z.string().default('en') }) },
    },
    async (req) => {
      const f = await withReplicaScope(STATE_SCOPE, (trx) => facilitiesRepo.byCode(trx, req.params.code));
      if (!f) throw AppError.notFound('facility');
      const cfg = await getFacilityConfig(f.id);
      const today = istDate();
      const weekday = istIsoWeekday();
      const schedules = await withReplicaScope(STATE_SCOPE, (trx) => facilitiesRepo.schedulesForDate(trx, f.id, today, weekday));
      const board = await waitboard(f.id);
      const lang = req.query.lang;
      return {
        code: f.code,
        name: pick(f.name_i18n, lang, f.name),
        kind: f.kind,
        address: f.address,
        registration_hours: cfg.opd.registration_hours,
        departments: cfg.departments
          .filter((d) => !d.is_emergency)
          .map((d) => ({
            id: d.id,
            code: d.code,
            name: pick(d.name_i18n, lang, d.name),
            specialty_code: d.specialty_code,
            open_today: schedules.some((s) => s.department_id === d.id),
            timings: schedules
              .filter((s) => s.department_id === d.id)
              .map((s) => ({ shift: s.shift, starts_at: s.starts_at, ends_at: s.ends_at })),
            wait: board.departments.find((b) => b.department_id === d.id) ?? null,
          })),
      };
    },
  );

  app.get(
    '/api/v1/facilities/nearby',
    {
      config: { public: true, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['public'],
        querystring: z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }),
      },
    },
    async (req) => ({ items: await withReplicaScope(STATE_SCOPE, (trx) => facilitiesRepo.nearby(trx, req.query.lat, req.query.lng)) }),
  );

  // ---- Administration (facility.configure) ----
  app.get('/api/v1/facilities', { schema: { tags: ['admin'] } }, async (req) => {
    const staff = requireStaff(req);
    const items = await withScope(STATE_SCOPE, (trx) => facilitiesRepo.list(trx));
    return { items: staff.stateScope ? items : items.filter((f) => staff.facilityIds.includes(f.id)) };
  });

  app.post('/api/v1/facilities', { schema: { tags: ['admin'], body: S.createFacility } }, async (req, reply) => {
    const staff = requireStaff(req);
    if (!staff.stateScope) throw AppError.forbidden('state_admin required');
    req.audit.record({ action: 'facility.create', resourceType: 'facility', purpose: 'administration' });
    return reply.code(201).send(await facilitiesService.createFacility(req.body));
  });

  app.get('/api/v1/facilities/:id', { schema: { tags: ['admin'], params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    requireStaff(req);
    assertFacilityAccess(req, req.params.id);
    return getFacilityConfig(req.params.id);
  });

  app.patch(
    '/api/v1/facilities/:id',
    {
      config: { permission: 'facility.configure' },
      schema: { tags: ['admin'], params: z.object({ id: z.string().uuid() }), body: S.updateFacilityConfig },
    },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      req.audit.record({
        action: 'facility.configure',
        resourceType: 'facility',
        resourceId: req.params.id,
        facilityId: req.params.id,
        purpose: 'administration',
        details: { keys: Object.keys(req.body) },
      });
      return facilitiesService.updateFacility(req.params.id, req.body);
    },
  );

  const fid = z.object({ id: z.string().uuid() });
  const fidSub = z.object({ id: z.string().uuid(), subId: z.string().uuid() });

  app.get('/api/v1/facilities/:id/departments', { schema: { tags: ['admin'], params: fid } }, async (req) => {
    requireStaff(req);
    assertFacilityAccess(req, req.params.id);
    return { items: await withScope(scopeOf(req.principal), (trx) => facilitiesRepo.departments(trx, req.params.id, true)) };
  });
  app.post(
    '/api/v1/facilities/:id/departments',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: fid, body: S.createDepartment } },
    async (req, reply) => {
      assertFacilityAccess(req, req.params.id);
      const row = await withScope(scopeOf(req.principal), (trx) => facilitiesService.createDepartment(trx, req.params.id, req.body));
      await invalidateFacilityConfig(req.params.id);
      req.audit.record({
        action: 'department.create',
        resourceType: 'department',
        resourceId: row.id,
        facilityId: req.params.id,
        purpose: 'administration',
      });
      return reply.code(201).send(row);
    },
  );
  app.patch(
    '/api/v1/facilities/:id/departments/:subId',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: fidSub, body: S.updateDepartment } },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      const row = await withScope(scopeOf(req.principal), (trx) =>
        facilitiesService.updateDepartment(trx, req.params.id, req.params.subId, req.body),
      );
      await invalidateFacilityConfig(req.params.id);
      req.audit.record({
        action: 'department.update',
        resourceType: 'department',
        resourceId: row.id,
        facilityId: req.params.id,
        purpose: 'administration',
      });
      return row;
    },
  );

  app.get('/api/v1/facilities/:id/service-points', { schema: { tags: ['admin'], params: fid } }, async (req) => {
    requireStaff(req);
    assertFacilityAccess(req, req.params.id);
    return { items: await withScope(scopeOf(req.principal), (trx) => facilitiesRepo.servicePoints(trx, req.params.id, true)) };
  });
  app.post(
    '/api/v1/facilities/:id/service-points',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: fid, body: S.createServicePoint } },
    async (req, reply) => {
      assertFacilityAccess(req, req.params.id);
      const row = await withScope(scopeOf(req.principal), (trx) => facilitiesService.createServicePoint(trx, req.params.id, req.body));
      await invalidateFacilityConfig(req.params.id);
      return reply.code(201).send(row);
    },
  );
  app.patch(
    '/api/v1/facilities/:id/service-points/:subId',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: fidSub, body: S.updateServicePoint } },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      const row = await withScope(scopeOf(req.principal), (trx) =>
        facilitiesService.updateServicePoint(trx, req.params.id, req.params.subId, req.body),
      );
      await invalidateFacilityConfig(req.params.id);
      return row;
    },
  );

  app.get('/api/v1/facilities/:id/doctor-schedules', { schema: { tags: ['admin'], params: fid } }, async (req) => {
    requireStaff(req);
    assertFacilityAccess(req, req.params.id);
    return { items: await withScope(scopeOf(req.principal), (trx) => facilitiesRepo.schedules(trx, req.params.id)) };
  });
  app.post(
    '/api/v1/facilities/:id/doctor-schedules',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: fid, body: S.createSchedule } },
    async (req, reply) => {
      assertFacilityAccess(req, req.params.id);
      return reply
        .code(201)
        .send(await withScope(scopeOf(req.principal), (trx) => facilitiesService.createSchedule(trx, req.params.id, req.body)));
    },
  );
  app.delete(
    '/api/v1/facilities/:id/doctor-schedules/:subId',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: fidSub } },
    async (req, reply) => {
      assertFacilityAccess(req, req.params.id);
      await withScope(scopeOf(req.principal), (trx) => facilitiesRepo.deleteSchedule(trx, req.params.subId, req.params.id));
      return reply.code(204).send();
    },
  );
  app.post(
    '/api/v1/facilities/:id/schedule-overrides',
    { schema: { tags: ['admin'], params: fid, body: S.createOverride } },
    async (req, reply) => {
      const staff = requireStaff(req);
      assertFacilityAccess(req, req.params.id);
      assertPermission(req, 'facility.configure', req.params.id);
      return reply
        .code(201)
        .send(
          await withScope(scopeOf(req.principal), (trx) => facilitiesService.createOverride(trx, req.params.id, req.body, staff.userId)),
        );
    },
  );
}
