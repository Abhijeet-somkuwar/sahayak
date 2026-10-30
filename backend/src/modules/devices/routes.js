/**
 * Devices (§9.1, §11.2): per-device API keys (only the hash is stored), restricted to their facility and departments.
 */
import { z } from 'zod';

import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { randomToken, sha256 } from '../../infra/crypto.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { assertFacilityAccess, requireDevice } from '../../shared/auth.js';
import { getFacilityConfig } from '../facilities/service.js';

const idParam = z.object({ id: z.string().uuid() });
const subParam = z.object({ id: z.string().uuid(), subId: z.string().uuid() });

export async function devicesRoutes(app) {
  app.get('/api/v1/devices/me', { schema: { tags: ['devices'] } }, async (req) => {
    const d = requireDevice(req);
    const cfg = await getFacilityConfig(d.facilityId);
    return {
      device_id: d.deviceId,
      kind: d.deviceKind,
      facility: cfg.facility,
      departments: cfg.departments
        .filter((x) => d.departmentIds.length === 0 || d.departmentIds.includes(x.id))
        .map(({ id, code, name, name_i18n, token_prefix }) => ({ id, code, name, name_i18n, token_prefix })),
      service_points: cfg.servicePoints.filter((s) => d.servicePointIds.includes(s.id)),
      flags: { offline_blocks_enabled: cfg.opd.offline_blocks_enabled, offline_block_size: cfg.opd.offline_block_size },
    };
  });

  app.get(
    '/api/v1/facilities/:id/devices',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: idParam } },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      return {
        items: await withScope(STATE_SCOPE, (trx) =>
          trx
            .selectFrom('devices')
            .select(['id', 'kind', 'label', 'department_ids', 'service_point_ids', 'last_seen_at', 'status', 'created_at'])
            .where('facility_id', '=', req.params.id)
            .orderBy('label')
            .execute(),
        ),
      };
    },
  );

  app.post(
    '/api/v1/facilities/:id/devices',
    {
      config: { permission: 'facility.configure' },
      schema: {
        tags: ['admin'],
        params: idParam,
        body: z
          .object({
            kind: z.enum(['queue_display', 'kiosk', 'counter_terminal']),
            label: z.string().min(1).max(100),
            department_ids: z.array(z.string().uuid()).default([]),
            service_point_ids: z.array(z.string().uuid()).default([]),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      assertFacilityAccess(req, req.params.id);
      const apiKey = `sk_dev_${randomToken(32)}`;
      const row = await withScope(STATE_SCOPE, (trx) =>
        trx
          .insertInto('devices')
          .values({ id: newId(), facility_id: req.params.id, ...req.body, api_key_hash: sha256(apiKey) })
          .returning(['id', 'kind', 'label'])
          .executeTakeFirstOrThrow(),
      );
      req.audit.record({
        action: 'device.create',
        resourceType: 'device',
        resourceId: row.id,
        facilityId: req.params.id,
        purpose: 'administration',
      });
      return reply.code(201).send({ ...row, api_key: apiKey }); // shown once; only the hash is stored
    },
  );

  app.post(
    '/api/v1/facilities/:id/devices/:subId/rotate-key',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: subParam } },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      const apiKey = `sk_dev_${randomToken(32)}`;
      const row = await withScope(STATE_SCOPE, (trx) =>
        trx
          .updateTable('devices')
          .set({ api_key_hash: sha256(apiKey) })
          .where('id', '=', req.params.subId)
          .where('facility_id', '=', req.params.id)
          .returning('id')
          .executeTakeFirst(),
      );
      if (!row) throw AppError.notFound('device');
      req.audit.record({
        action: 'device.rotate_key',
        resourceType: 'device',
        resourceId: row.id,
        facilityId: req.params.id,
        purpose: 'administration',
      });
      return { id: row.id, api_key: apiKey };
    },
  );

  app.delete(
    '/api/v1/facilities/:id/devices/:subId',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: subParam } },
    async (req, reply) => {
      assertFacilityAccess(req, req.params.id);
      await withScope(STATE_SCOPE, (trx) =>
        trx
          .updateTable('devices')
          .set({ status: 'inactive' })
          .where('id', '=', req.params.subId)
          .where('facility_id', '=', req.params.id)
          .execute(),
      );
      req.audit.record({
        action: 'device.deactivate',
        resourceType: 'device',
        resourceId: req.params.subId,
        facilityId: req.params.id,
        purpose: 'administration',
      });
      return reply.code(204).send();
    },
  );
}
