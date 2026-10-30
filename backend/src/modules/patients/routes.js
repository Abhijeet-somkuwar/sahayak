import { z } from 'zod';

import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { AppError } from '../../shared/errors.js';
import { assertPermission, requirePatient, requireStaff } from '../../shared/auth.js';
import { scopeOf } from '../../shared/http.js';
import { assertClinicalAccess, openBreakGlass } from '../../shared/access.js';
import { paginationQuery, toPage } from '../../shared/pagination.js';
import { boundaryMonthsAgo } from '../../shared/ids.js';
import { normalisePhone } from '../../shared/phone.js';
import { pick } from '../../shared/i18n.js';
import { resolveTokenRef } from '../queue/projection.js';
import { blindIndex } from '../../infra/crypto.js';
import { patientsRepo } from './repo.js';
import { patientsService } from './service.js';
import * as S from './schemas.js';

const pid = z.object({ id: z.string().uuid() });
const HIDDEN_VISIT_STATUSES = new Set(['intake', 'cancelled', 'abandoned']);

/** Visit details → JSON. Patients get their own words; staff also get the AI headline of that visit. */
async function shapeVisits(trx, rows, lang, { staff = false } = {}) {
  const codes = [...new Set(rows.flatMap((r) => (r.symptoms ?? []).map((s) => s.code)).filter(Boolean))];
  const catalog = await patientsRepo.symptomLabels(trx, codes);
  const label = (code) => {
    const c = catalog.find((x) => x.code === code);
    return (c && (pick(c.labels, lang) || c.labels['en'])) || String(code).replace(/^SYM_/, '').replace(/_/g, ' ').toLowerCase();
  };
  return rows.map((r) => ({
    id: r.id,
    patient_id: r.patient_id,
    date: r.session_date,
    status: r.status,
    kind: r.kind,
    token: r.token_display,
    triage_level: r.triage_level,
    department: (r.department_i18n && pick(r.department_i18n, lang)) || r.department,
    facility: r.facility,
    doctor: r.doctor,
    completed_at: r.consult_ended_at,
    complaint: (r.symptoms ?? []).map((s) => label(s.code)),
    diagnoses: r.diagnoses ?? [],
    prescriptions: r.prescriptions ?? [],
    ...(staff ? { ai_headline: r.ai_headline ?? null } : {}),
  }));
}

export async function patientsRoutes(app) {
  // ---- Patient portal ----
  app.get('/api/v1/me/household', { schema: { tags: ['patient'] } }, async (req) => {
    const p = requirePatient(req);
    const items = await withScope(STATE_SCOPE, (trx) => patientsRepo.householdByContactPointId(trx, p.contactPointId));
    return { items };
  });

  app.get('/api/v1/me/encounters', { schema: { tags: ['patient'], querystring: paginationQuery } }, async (req) => {
    const p = requirePatient(req);
    return withScope(STATE_SCOPE, async (trx) => {
      const hh = await patientsRepo.householdByContactPointId(trx, p.contactPointId);
      if (hh.length === 0) return { items: [], next_cursor: null };
      const rows = await patientsRepo.encountersForHousehold(
        trx,
        hh.map((m) => m.id),
        boundaryMonthsAgo(24),
        req.query.limit,
        req.query.cursor,
      );
      return toPage(rows, req.query.limit, (r) => r.id);
    });
  });

  // The patient's own visits with the doctor's diagnosis and medicines ("My visits"), newest first.
  app.get(
    '/api/v1/me/visits',
    { schema: { tags: ['patient'], querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), lang: z.string().max(10).default('en') }) } },
    async (req) => {
      const p = requirePatient(req);
      return withScope(STATE_SCOPE, async (trx) => {
        const hh = await patientsRepo.householdByContactPointId(trx, p.contactPointId);
        if (hh.length === 0) return { items: [] };
        const ids = (await patientsRepo.encountersForHousehold(trx, hh.map((m) => m.id), boundaryMonthsAgo(24), 50, null))
          .filter((e) => !HIDDEN_VISIT_STATUSES.has(e.status))
          .slice(0, req.query.limit)
          .map((e) => e.id);
        const items = await shapeVisits(trx, await patientsRepo.visitDetails(trx, ids), req.query.lang);
        const names = new Map(hh.map((m) => [m.id, m.display_name]));
        req.audit.record({ action: 'patient.visits.read', resourceType: 'contact_point', resourceId: p.contactPointId, purpose: 'patient_access' });
        return { items: items.map((v) => ({ ...v, patient_name: names.get(v.patient_id) ?? null })) };
      });
    },
  );

  // One visit by its slip code (the slip page after "Complete"): only for the phone that owns the visit.
  app.get(
    '/api/v1/me/visits/by-ref/:ref',
    { schema: { tags: ['patient'], params: z.object({ ref: z.string().regex(/^[a-z2-7]{10}$/) }), querystring: z.object({ lang: z.string().max(10).default('en') }) } },
    async (req) => {
      const p = requirePatient(req);
      const resolved = await resolveTokenRef(req.params.ref);
      if (!resolved) throw AppError.notFound('visit');
      return withScope(STATE_SCOPE, async (trx) => {
        const token = await patientsRepo.encounterIdForToken(trx, resolved.tokenId);
        if (!token) throw AppError.notFound('visit');
        const hh = await patientsRepo.householdByContactPointId(trx, p.contactPointId);
        const [row] = await patientsRepo.visitDetails(trx, [token.encounter_id]);
        if (!row || !hh.some((m) => m.id === row.patient_id)) throw AppError.notFound('visit');
        const [visit] = await shapeVisits(trx, [row], req.query.lang);
        req.audit.record({ action: 'patient.visits.read', resourceType: 'encounter', resourceId: row.id, patientId: row.patient_id, purpose: 'patient_access' });
        return { ...visit, patient_name: hh.find((m) => m.id === row.patient_id)?.display_name ?? null };
      });
    },
  );

  app.post(
    '/api/v1/me/consents',
    { schema: { tags: ['patient'], body: S.recordConsent.omit({ phone: true, contact_point_id: true }) } },
    async (req, reply) => {
      const p = requirePatient(req);
      const row = await withScope(STATE_SCOPE, (trx) =>
        patientsService.recordConsent(trx, {
          contactPointId: p.contactPointId,
          patientId: req.body.patient_id,
          purpose: req.body.purpose,
          granted: req.body.granted,
          noticeVersion: req.body.notice_version,
          language: req.body.language,
          channel: 'web',
          capturedBy: null,
        }),
      );
      req.audit.record({
        action: 'consent.recorded',
        resourceType: 'consent',
        resourceId: row.id,
        patientId: req.body.patient_id,
        purpose: 'consent',
        details: { purpose: req.body.purpose, granted: req.body.granted },
      });
      return reply.code(201).send(row);
    },
  );

  // ---- Staff ----
  app.get(
    '/api/v1/patients/search',
    { config: { permission: 'patient.demographics.read' }, schema: { tags: ['patients'], querystring: S.searchQuery } },
    async (req) => {
      const result = await withScope(scopeOf(req.principal), (trx) => patientsService.search(trx, req.query));
      req.audit.record({
        action: 'patient.search',
        resourceType: 'patient',
        purpose: 'treatment',
        details: { kind: result.kind, results: result.items.length },
      });
      return result;
    },
  );

  app.post(
    '/api/v1/patients',
    { config: { permission: 'patient.demographics.write' }, schema: { tags: ['patients'], body: S.createPatient } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const row = await withScope(scopeOf(req.principal), (trx) => patientsService.create(trx, req.body, staff.userId));
      req.audit.record({ action: 'patient.create', resourceType: 'patient', resourceId: row.id, patientId: row.id, purpose: 'treatment' });
      reply.header('etag', `"${row.version}"`);
      return reply
        .code(201)
        .send({ id: row.id, display_name: row.display_name, sex: row.sex, birth_year: row.birth_year, version: row.version });
    },
  );

  app.get(
    '/api/v1/patients/:id',
    { config: { permission: 'patient.demographics.read' }, schema: { tags: ['patients'], params: pid } },
    async (req, reply) => {
      const d = await withScope(scopeOf(req.principal), (trx) => patientsService.demographics(trx, req.params.id));
      req.audit.record({ action: 'patient.read', resourceType: 'patient', resourceId: d.id, patientId: d.id, purpose: 'treatment' });
      reply.header('etag', `"${d.version}"`);
      return d;
    },
  );

  app.post(
    '/api/v1/patients/:id/contacts',
    { config: { permission: 'patient.demographics.write' }, schema: { tags: ['patients'], params: pid, body: S.linkContact } },
    async (req, reply) => {
      await withScope(scopeOf(req.principal), (trx) => patientsService.linkContact(trx, req.params.id, req.body));
      req.audit.record({
        action: 'patient.contact.link',
        resourceType: 'patient',
        resourceId: req.params.id,
        patientId: req.params.id,
        purpose: 'treatment',
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/patients/:id/clinical-summary',
    { config: { permission: 'patient.clinical.read' }, schema: { tags: ['patients'], params: pid } },
    async (req) => {
      const staff = requireStaff(req);
      return withScope(scopeOf(req.principal), async (trx) => {
        const purpose = await assertClinicalAccess(trx, staff, req.params.id, req.audit);
        req.audit.record({
          action: 'patient.clinical.read',
          resourceType: 'patient',
          resourceId: req.params.id,
          patientId: req.params.id,
          purpose,
        });
        return patientsService.clinicalSummary(trx, req.params.id);
      });
    },
  );

  app.get(
    '/api/v1/patients/:id/encounters',
    { config: { permission: 'patient.clinical.read' }, schema: { tags: ['patients'], params: pid, querystring: paginationQuery } },
    async (req) => {
      const staff = requireStaff(req);
      return withScope(scopeOf(req.principal), async (trx) => {
        const purpose = await assertClinicalAccess(trx, staff, req.params.id, req.audit);
        req.audit.record({
          action: 'patient.history.read',
          resourceType: 'patient',
          resourceId: req.params.id,
          patientId: req.params.id,
          purpose,
        });
        const rows = await patientsRepo.encountersForPatient(trx, req.params.id, boundaryMonthsAgo(24), req.query.limit, req.query.cursor);
        return toPage(rows, req.query.limit, (r) => r.id);
      });
    },
  );

  // Doctor's visit history: every visit in the last 24 months with complaint, diagnoses, medicines and the AI
  // pre-brief headline written at that visit.
  app.get(
    '/api/v1/patients/:id/visits',
    {
      config: { permission: 'patient.clinical.read' },
      schema: { tags: ['patients'], params: pid, querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }) },
    },
    async (req) => {
      const staff = requireStaff(req);
      return withScope(scopeOf(req.principal), async (trx) => {
        const purpose = await assertClinicalAccess(trx, staff, req.params.id, req.audit);
        req.audit.record({ action: 'patient.history.read', resourceType: 'patient', resourceId: req.params.id, patientId: req.params.id, purpose });
        const ids = (await patientsRepo.encountersForPatient(trx, req.params.id, boundaryMonthsAgo(24), 60, null))
          .filter((e) => !HIDDEN_VISIT_STATUSES.has(e.status))
          .slice(0, req.query.limit)
          .map((e) => e.id);
        return { items: await shapeVisits(trx, await patientsRepo.visitDetails(trx, ids, true), 'en', { staff: true }) };
      });
    },
  );

  app.post(
    '/api/v1/patients/:id/breakglass',
    { config: { permission: 'patient.clinical.read' }, schema: { tags: ['patients'], params: pid, body: S.breakGlass } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const exists = await withScope(STATE_SCOPE, (trx) => patientsRepo.byId(trx, req.params.id));
      if (!exists) throw AppError.notFound('patient');
      const grant = await openBreakGlass(staff.userId, req.params.id, req.body.reason);
      req.audit.record({
        action: 'breakglass.open',
        resourceType: 'patient',
        resourceId: req.params.id,
        patientId: req.params.id,
        purpose: 'breakglass',
        details: { reason: req.body.reason, expires_at: grant.expiresAt.toISOString() },
      });
      return reply.code(201).send({ patient_id: req.params.id, expires_at: grant.expiresAt.toISOString() });
    },
  );

  app.post(
    '/api/v1/patients/:id/allergies',
    { config: { permission: 'encounter.clinical.write' }, schema: { tags: ['patients'], params: pid, body: S.createAllergy } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const row = await withScope(scopeOf(req.principal), async (trx) => {
        await assertClinicalAccess(trx, staff, req.params.id, req.audit);
        return patientsService.addAllergy(trx, req.params.id, req.body, staff.userId);
      });
      req.audit.record({
        action: 'allergy.recorded',
        resourceType: 'allergy',
        resourceId: row.id,
        patientId: req.params.id,
        purpose: 'treatment',
      });
      return reply.code(201).send(row);
    },
  );

  app.post(
    '/api/v1/patients/:id/conditions',
    { config: { permission: 'encounter.clinical.write' }, schema: { tags: ['patients'], params: pid, body: S.createCondition } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const row = await withScope(scopeOf(req.principal), async (trx) => {
        await assertClinicalAccess(trx, staff, req.params.id, req.audit);
        return patientsService.addCondition(trx, req.params.id, req.body, staff.userId);
      });
      req.audit.record({
        action: 'condition.recorded',
        resourceType: 'condition',
        resourceId: row.id,
        patientId: req.params.id,
        purpose: 'treatment',
      });
      return reply.code(201).send(row);
    },
  );

  app.post(
    '/api/v1/patients/:id/consents',
    { config: { permission: 'patient.demographics.write' }, schema: { tags: ['patients'], params: pid, body: S.recordConsent } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const row = await withScope(scopeOf(req.principal), async (trx) => {
        let cpId = req.body.contact_point_id;
        if (!cpId && req.body.phone)
          cpId = (await patientsRepo.contactPointByHash(trx, blindIndex('phone', normalisePhone(req.body.phone))))?.id;
        if (!cpId) throw AppError.validation('contact_point_id or a known phone is required');
        return patientsService.recordConsent(trx, {
          contactPointId: cpId,
          patientId: req.params.id,
          purpose: req.body.purpose,
          granted: req.body.granted,
          noticeVersion: req.body.notice_version,
          language: req.body.language,
          channel: 'counter',
          capturedBy: staff.userId,
        });
      });
      req.audit.record({
        action: 'consent.recorded',
        resourceType: 'consent',
        resourceId: row.id,
        patientId: req.params.id,
        purpose: 'consent',
        details: { purpose: req.body.purpose, granted: req.body.granted },
      });
      return reply.code(201).send(row);
    },
  );

  app.post(
    '/api/v1/patients/:id/merge',
    { config: { permission: 'patient.demographics.write' }, schema: { tags: ['patients'], params: pid, body: S.mergePatients } },
    async (req, reply) => {
      assertPermission(req, 'patient.demographics.write');
      await withScope(scopeOf(req.principal), (trx) => patientsService.merge(trx, req.params.id, req.body.into_patient_id));
      req.audit.record({
        action: 'patient.merge',
        resourceType: 'patient',
        resourceId: req.params.id,
        patientId: req.body.into_patient_id,
        purpose: 'administration',
        details: { from: req.params.id, reason: req.body.reason },
      });
      return reply.code(204).send();
    },
  );
}
