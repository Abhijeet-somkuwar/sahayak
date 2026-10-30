/**
 * Administration: staff (users + memberships) and message templates with clinical review (§11.2).
 */
import { z } from 'zod';

import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { blindIndex, encrypt } from '../../infra/crypto.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { assertFacilityAccess, requireStaff } from '../../shared/auth.js';
import { normalisePhone } from '../../shared/phone.js';
import { invalidateTemplateCache } from '../../shared/i18n.js';
import { authService, hashPassword } from '../auth/service.js';

const roles = z.enum([
  'state_admin',
  'facility_admin',
  'doctor',
  'nurse',
  'registration_clerk',
  'help_desk',
  'pharmacist',
  'lab_technician',
  'clinical_reviewer',
  'dpo',
  'auditor',
]);
const idParam = z.object({ id: z.string().uuid() });
const subParam = z.object({ id: z.string().uuid(), subId: z.string().uuid() });

export async function adminRoutes(app) {
  // ---- staff ----
  app.get(
    '/api/v1/facilities/:id/staff',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: idParam } },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      const items = await withScope(STATE_SCOPE, (trx) =>
        trx
          .selectFrom('staff_memberships as m')
          .innerJoin('users as u', 'u.id', 'm.user_id')
          .select([
            'm.id',
            'm.user_id',
            'u.display_name',
            'u.email',
            'u.hpr_id',
            'm.role',
            'm.department_id',
            'm.status',
            'm.valid_from',
            'm.valid_to',
            'u.status as user_status',
          ])
          .where('m.facility_id', '=', req.params.id)
          .orderBy('u.display_name')
          .execute(),
      );
      return { items };
    },
  );

  app.post(
    '/api/v1/facilities/:id/staff',
    {
      config: { permission: 'facility.configure' },
      schema: {
        tags: ['admin'],
        params: idParam,
        body: z
          .object({
            display_name: z.string().min(1).max(200),
            email: z.string().email().optional(),
            phone: z.string().optional(),
            password: z.string().min(10).max(200),
            hpr_id: z.string().max(64).optional(),
            role: roles,
            department_id: z.string().uuid().nullable().default(null),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      const staff = requireStaff(req);
      assertFacilityAccess(req, req.params.id);
      if (['state_admin', 'auditor', 'dpo'].includes(req.body.role) && !staff.stateScope)
        throw AppError.forbidden('only state admins create state-level roles');
      const row = await withScope(STATE_SCOPE, async (trx) => {
        const existing = req.body.email
          ? await trx
              .selectFrom('users')
              .select('id')
              .where((eb) => eb.fn('lower', ['email']), '=', req.body.email.toLowerCase())
              .executeTakeFirst()
          : undefined;
        let userId = existing?.id;
        if (!userId) {
          const phone = req.body.phone ? normalisePhone(req.body.phone) : null;
          const enc = phone ? encrypt('pii', phone) : null;
          userId = newId();
          await trx
            .insertInto('users')
            .values({
              id: userId,
              display_name: req.body.display_name,
              email: req.body.email ?? null,
              phone_hash: phone ? blindIndex('phone', phone) : null,
              phone_enc: enc?.ciphertext ?? null,
              key_version: enc?.keyVersion ?? null,
              password_hash: await hashPassword(req.body.password),
              hpr_id: req.body.hpr_id ?? null,
            })
            .execute();
        }
        const facilityId = ['state_admin', 'auditor', 'dpo'].includes(req.body.role) ? null : req.params.id;
        return trx
          .insertInto('staff_memberships')
          .values({
            id: newId(),
            user_id: userId,
            facility_id: facilityId,
            role: req.body.role,
            department_id: req.body.department_id,
            created_by: staff.userId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      req.audit.record({
        action: 'staff.role_changed',
        resourceType: 'staff_membership',
        resourceId: row.id,
        facilityId: req.params.id,
        purpose: 'administration',
        details: { role: row.role, user_id: row.user_id, change: 'granted' },
      });
      return reply.code(201).send(row);
    },
  );

  app.delete(
    '/api/v1/facilities/:id/staff/:subId',
    { config: { permission: 'facility.configure' }, schema: { tags: ['admin'], params: subParam } },
    async (req, reply) => {
      assertFacilityAccess(req, req.params.id);
      const row = await withScope(STATE_SCOPE, (trx) =>
        trx
          .updateTable('staff_memberships')
          .set({ status: 'inactive', valid_to: new Date().toISOString().slice(0, 10) })
          .where('id', '=', req.params.subId)
          .where('facility_id', '=', req.params.id)
          .returningAll()
          .executeTakeFirst(),
      );
      if (!row) throw AppError.notFound('membership');
      await authService.deactivateUser(row.user_id); // revocation list: tokens issued before now are rejected
      req.audit.record({
        action: 'staff.role_changed',
        resourceType: 'staff_membership',
        resourceId: row.id,
        facilityId: req.params.id,
        purpose: 'administration',
        details: { role: row.role, user_id: row.user_id, change: 'revoked' },
      });
      return reply.code(204).send();
    },
  );

  // ---- message templates (every patient-facing sentence) ----
  const channel = z.enum(['whatsapp', 'web', 'kiosk', 'sms', 'ivr']);
  app.get(
    '/api/v1/message-templates',
    {
      config: { permission: 'templates.review' },
      schema: {
        tags: ['admin'],
        querystring: z.object({ code: z.string().optional(), status: z.enum(['draft', 'active', 'retired']).optional() }),
      },
    },
    async (req) => {
      const items = await withScope(STATE_SCOPE, (trx) => {
        let q = trx.selectFrom('message_templates').selectAll();
        if (req.query.code) q = q.where('code', '=', req.query.code);
        if (req.query.status) q = q.where('status', '=', req.query.status);
        return q.orderBy('code').orderBy('language').orderBy('version', 'desc').limit(1000).execute();
      });
      return { items };
    },
  );
  app.post(
    '/api/v1/message-templates',
    {
      config: { permission: 'templates.review' },
      schema: {
        tags: ['admin'],
        body: z
          .object({
            code: z.string().min(1).max(100),
            channel,
            language: z.string().max(10),
            body: z.string().min(1).max(4000),
            variables: z.array(z.string()).default([]),
            provider_template_name: z.string().max(100).nullable().default(null),
            is_medical: z.boolean().default(false),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      const row = await withScope(STATE_SCOPE, async (trx) => {
        const last = await trx
          .selectFrom('message_templates')
          .select((eb) => eb.fn.max('version').as('v'))
          .where('code', '=', req.body.code)
          .where('channel', '=', req.body.channel)
          .where('language', '=', req.body.language)
          .executeTakeFirst();
        return trx
          .insertInto('message_templates')
          .values({ id: newId(), ...req.body, version: (Number(last?.v) || 0) + 1 })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      return reply.code(201).send(row);
    },
  );
  /** Review + activate: medical templates need a clinical reviewer (DB constraint); the previous active version is retired. */
  app.post(
    '/api/v1/message-templates/:id/review',
    {
      config: { permission: 'templates.review' },
      schema: { tags: ['admin'], params: idParam, body: z.object({ approve: z.boolean() }).strict() },
    },
    async (req) => {
      const staff = requireStaff(req);
      const row = await withScope(STATE_SCOPE, async (trx) => {
        const t = await trx.selectFrom('message_templates').selectAll().where('id', '=', req.params.id).executeTakeFirst();
        if (!t) throw AppError.notFound('template');
        if (!req.body.approve)
          return trx
            .updateTable('message_templates')
            .set({ status: 'retired' })
            .where('id', '=', t.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        await trx
          .updateTable('message_templates')
          .set({ status: 'retired' })
          .where('code', '=', t.code)
          .where('channel', '=', t.channel)
          .where('language', '=', t.language)
          .where('status', '=', 'active')
          .execute();
        return trx
          .updateTable('message_templates')
          .set({ status: 'active', clinically_reviewed_by: staff.userId })
          .where('id', '=', t.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      invalidateTemplateCache();
      req.audit.record({
        action: 'template.review',
        resourceType: 'message_template',
        resourceId: row.id,
        purpose: 'administration',
        details: { approve: req.body.approve, code: row.code },
      });
      return row;
    },
  );
}
