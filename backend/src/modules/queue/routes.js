import { z } from 'zod';

import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { AppError } from '../../shared/errors.js';
import { assertFacilityAccess, assertPermission, requireDevice, requireStaff } from '../../shared/auth.js';
import { scopeOf } from '../../shared/http.js';
import { requireVersion, setEtag } from '../../shared/etag.js';
import { assertClinicalAccess } from '../../shared/access.js';
import { writeOutbox } from '../../shared/outbox.js';
import { istDate, istHour } from '../../shared/time.js';
import { queueRepo } from './repo.js';
import { queueService } from './service.js';
import * as S from './schemas.js';
import { prebriefService } from '../prebrief/service.js';
import { followupsService } from '../followups/service.js';
import { triageRepo } from '../triage/repo.js';
import { triageService } from '../triage/service.js';
import { isLessUrgent } from '../triage/engine.js';
import { triageOverrides } from '../../infra/metrics.js';

const idParam = z.object({ id: z.string().uuid() });
const sessionParam = z.object({ sessionId: z.string().uuid() });

export async function queueRoutes(app) {
  // ---- public status link (no PHI) ----
  app.get(
    '/api/v1/t/:publicRef',
    {
      config: { public: true, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { tags: ['public'], params: z.object({ publicRef: z.string().regex(/^[a-z2-7]{10}$/) }) },
    },
    async (req) => queueService.statusByRef(req.params.publicRef),
  );

  // ---- today's queues ----
  app.get(
    '/api/v1/facilities/:id/queues/today',
    { schema: { tags: ['queue'], params: idParam, querystring: S.sessionDate } },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      if (req.principal.kind === 'staff') {
        try {
          assertPermission(req, 'queue.checkin');
        } catch {
          assertPermission(req, 'queue.operate');
        }
      }
      return { items: await queueService.sessionsToday(scopeOf(req.principal), req.params.id, req.query.date ?? istDate()) };
    },
  );

  // ---- session lifecycle ----
  for (const action of ['open', 'pause', 'close']) {
    app.post(
      `/api/v1/queues/:sessionId/${action}`,
      { config: { permission: 'queue.operate' }, schema: { tags: ['queue'], params: sessionParam } },
      async (req) => {
        const staff = requireStaff(req);
        const result = await withScope(scopeOf(req.principal), async (trx) => {
          if (action === 'open') return { session: await queueService.openSession(trx, req.params.sessionId, { userId: staff.userId }) };
          if (action === 'pause') return { session: await queueService.pauseSession(trx, req.params.sessionId, { userId: staff.userId }) };
          return queueService.closeSession(trx, req.params.sessionId, { userId: staff.userId });
        });
        if (action === 'open') {
          const { getFacilityConfig } = await import('../facilities/service.js');
          await queueService.seedSessionMeta(result.session, await getFacilityConfig(result.session.facility_id));
        }
        req.audit.record({
          action: `queue.session.${action}`,
          resourceType: 'queue_session',
          resourceId: req.params.sessionId,
          facilityId: result.session.facility_id,
          purpose: 'treatment',
        });
        return result;
      },
    );
  }

  // ---- check-in (Idempotency-Key required) ----
  app.post(
    '/api/v1/queues/:sessionId/checkins',
    { config: { permission: 'queue.checkin', idempotent: true }, schema: { tags: ['queue'], params: sessionParam, body: S.checkIn } },
    async (req, reply) => {
      const actor =
        req.principal.kind === 'staff'
          ? { userId: req.principal.userId }
          : req.principal.kind === 'device'
            ? { deviceId: req.principal.deviceId }
            : {};
      const result = await queueService.checkIn(scopeOf(req.principal), req.params.sessionId, req.body, actor);
      req.audit.record({
        action: 'queue.checkin',
        resourceType: 'opd_token',
        resourceId: result.token.id,
        purpose: 'treatment',
        details: { encounter_id: result.encounter_id },
      });
      setEtag(reply, result.token.version);
      return reply.code(201).send(result);
    },
  );

  // ---- call next ----
  app.post(
    '/api/v1/queues/:sessionId/call-next',
    { config: { permission: 'queue.operate' }, schema: { tags: ['queue'], params: sessionParam, body: S.callNext.nullish() } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const result = await queueService.callNext(
        scopeOf(req.principal),
        req.params.sessionId,
        staff.userId,
        req.body?.service_point_id ?? null,
      );
      if (!result) return reply.code(204).send();
      const prebrief = await prebriefService.cached(result.encounter.id);
      req.audit.record({
        action: 'queue.call_next',
        resourceType: 'opd_token',
        resourceId: result.token.id,
        patientId: result.encounter.patient_id,
        purpose: 'treatment',
      });
      if (prebrief)
        req.audit.record({
          action: 'prebrief.view',
          resourceType: 'prebrief',
          resourceId: result.encounter.id,
          patientId: result.encounter.patient_id,
          purpose: 'treatment',
        });
      setEtag(reply, result.token.version);
      return { token: result.token, room: result.room, encounter: result.encounter, prebrief };
    },
  );

  // ---- token transitions (If-Match) ----
  for (const action of ['recall', 'skip', 'start', 'complete', 'requeue', 'cancel']) {
    app.post(
      `/api/v1/tokens/:id/${action}`,
      { config: { permission: 'queue.operate' }, schema: { tags: ['queue'], params: idParam, body: S.skip.nullish() } },
      async (req, reply) => {
        const staff = requireStaff(req);
        const token = await queueService.transition(
          scopeOf(req.principal),
          req.params.id,
          requireVersion(req),
          action,
          { userId: staff.userId },
          { reason: req.body?.reason },
        );
        req.audit.record({ action: `queue.token.${action}`, resourceType: 'opd_token', resourceId: token.id, purpose: 'treatment' });
        setEtag(reply, token.version);
        return token;
      },
    );
  }
  app.post(
    '/api/v1/tokens/:id/transfer',
    { config: { permission: 'queue.operate' }, schema: { tags: ['queue'], params: idParam, body: S.transfer } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const result = await queueService.transfer(
        scopeOf(req.principal),
        req.params.id,
        requireVersion(req),
        req.body.department_id,
        { userId: staff.userId },
        req.body.reason,
      );
      req.audit.record({
        action: 'queue.token.transfer',
        resourceType: 'opd_token',
        resourceId: req.params.id,
        purpose: 'treatment',
        details: { to_department_id: req.body.department_id },
      });
      setEtag(reply, result.token.version);
      return result;
    },
  );

  app.get(
    '/api/v1/tokens/:id',
    { config: { permission: 'queue.read' }, schema: { tags: ['queue'], params: idParam } },
    async (req, reply) => {
      const t = await withScope(scopeOf(req.principal), (trx) => queueRepo.tokenById(trx, req.params.id));
      if (!t) throw AppError.notFound('token');
      setEtag(reply, t.version);
      return t;
    },
  );

  // ---- added for the web frontend: next waiting tokens per lane (codes only), for the doctor's queue rail ----
  app.get(
    '/api/v1/queues/:sessionId/next',
    { config: { permission: 'queue.read' }, schema: { tags: ['queue'], params: sessionParam, querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }) } },
    async (req) => {
      const session = await withScope(scopeOf(req.principal), (trx) => queueRepo.sessionById(trx, req.params.sessionId));
      if (!session) throw AppError.notFound('queue session');
      const items = await withScope(scopeOf(req.principal), async (trx) =>
        (await Promise.all([0, 1, 2].map((lane) => queueRepo.nextWaitingCodes(trx, req.params.sessionId, lane, req.query.limit)))).flat(),
      );
      return { queue_session_id: session.id, status: session.status, items: items.map((t) => ({ id: t.id, token: t.display_code, lane: t.lane })) };
    },
  );

  // ---- added for the web frontend: resolve a booking QR (sahayak:enc:<id>) to today's queue session. No PHI. ----
  app.get(
    '/api/v1/bookings/:encounterId',
    { schema: { tags: ['queue'], params: z.object({ encounterId: z.string().uuid() }) } },
    async (req) => {
      if (req.principal.kind !== 'device' && req.principal.kind !== 'staff') throw new AppError('unauthenticated', 'kiosk or staff authentication required');
      return withScope(scopeOf(req.principal), async (trx) => {
        const e = await queueService.encounter(trx, req.params.encounterId);
        if (req.principal.kind === 'device' && e.facility_id !== req.principal.facilityId) throw AppError.forbidden('booking belongs to another facility');
        const session = e.department_id ? await queueService.ensureSession(trx, e.facility_id, e.department_id, istDate(), istHour() < 14 ? 'morning' : 'evening') : null;
        return { encounter_id: e.id, status: e.status, department_id: e.department_id, token_display: e.token_display ?? null, queue_session_id: session ? session.id : null };
      });
    },
  );

  // ---- doctor status / heartbeat ----
  app.put(
    '/api/v1/doctors/me/status',
    { config: { permission: 'doctor.status' }, schema: { tags: ['queue'], body: S.doctorStatus } },
    async (req) => {
      const staff = requireStaff(req);
      return queueService.setDoctorStatus(staff.userId, req.body.status, req.body.queue_session_id ?? null, staff.facilityIds);
    },
  );

  // ---- emergency pre-alerts (casualty dashboard) ----
  app.get(
    '/api/v1/facilities/:id/emergency-prealerts',
    { config: { permission: 'prealert.read' }, schema: { tags: ['queue'], params: idParam } },
    async (req) => {
      assertFacilityAccess(req, req.params.id);
      return { items: await withScope(scopeOf(req.principal), (trx) => queueRepo.openPrealerts(trx, req.params.id)) };
    },
  );
  app.post(
    '/api/v1/emergency-prealerts/:id/ack',
    { config: { permission: 'prealert.read' }, schema: { tags: ['queue'], params: idParam } },
    async (req) => {
      const staff = requireStaff(req);
      const row = await withScope(scopeOf(req.principal), (trx) => queueRepo.ackPrealert(trx, req.params.id, staff.userId));
      if (!row) throw new AppError('invalid_state', 'pre-alert is not open');
      req.audit.record({
        action: 'prealert.ack',
        resourceType: 'emergency_prealert',
        resourceId: row.id,
        facilityId: row.facility_id,
        purpose: 'treatment',
      });
      return row;
    },
  );

  // ---- counter registration ----
  app.post(
    '/api/v1/encounters',
    { config: { permission: 'queue.checkin', idempotent: true }, schema: { tags: ['encounters'], body: S.createEncounter } },
    async (req, reply) => {
      assertFacilityAccess(req, req.body.facility_id);
      const actor =
        req.principal.kind === 'staff'
          ? { userId: req.principal.userId }
          : req.principal.kind === 'device'
            ? { deviceId: req.principal.deviceId }
            : {};
      const { encounter, session } = await withScope(scopeOf(req.principal), async (trx) => {
        const encounter = await queueService.createEncounter(trx, {
          facilityId: req.body.facility_id,
          patientId: req.body.patient_id,
          channel: req.principal.kind === 'device' ? 'kiosk' : 'counter',
          kind: req.body.kind,
          departmentId: req.body.department_id,
          triageLevel: req.body.triage_level,
          status: 'triaged',
        });
        const session = req.body.check_in
          ? await queueService.ensureSession(
              trx,
              req.body.facility_id,
              req.body.department_id,
              istDate(),
              req.body.shift ?? (istHour() < 14 ? 'morning' : 'evening'),
            )
          : null;
        return { encounter, session };
      });
      req.audit.record({
        action: 'encounter.create',
        resourceType: 'encounter',
        resourceId: encounter.id,
        patientId: encounter.patient_id,
        facilityId: encounter.facility_id,
        purpose: 'treatment',
      });
      if (!session) {
        setEtag(reply, encounter.version);
        return reply.code(201).send({ encounter });
      }
      const checkin = await queueService.checkIn(
        scopeOf(req.principal),
        session.id,
        {
          encounter_id: encounter.id,
          source: req.principal.kind === 'device' ? 'kiosk' : 'counter',
          preferred_doctor_id: req.body.preferred_doctor_id ?? null,
          protected_lane: req.body.protected_lane,
        },
        actor,
      );
      return reply.code(201).send({ encounter: { ...encounter, status: 'checked_in' }, checkin });
    },
  );

  app.get(
    '/api/v1/encounters/:id',
    { config: { permission: 'patient.clinical.read' }, schema: { tags: ['encounters'], params: idParam } },
    async (req, reply) => {
      const staff = requireStaff(req);
      return withScope(scopeOf(req.principal), async (trx) => {
        const e = await queueService.encounter(trx, req.params.id);
        if (e.patient_id) await assertClinicalAccess(trx, staff, e.patient_id, req.audit);
        const [triage, observations, diagnoses, prescriptions, token] = await Promise.all([
          triageRepo.assessment(trx, e.id),
          queueRepo.observations(trx, e.id),
          queueRepo.diagnoses(trx, e.id),
          queueRepo.prescriptions(trx, e.id),
          queueRepo.liveTokenForEncounter(trx, e.id),
        ]);
        req.audit.record({
          action: 'patient.clinical.read',
          resourceType: 'encounter',
          resourceId: e.id,
          patientId: e.patient_id,
          facilityId: e.facility_id,
          purpose: 'treatment',
        });
        setEtag(reply, e.version);
        return { ...e, triage, observations, diagnoses, prescriptions, token };
      });
    },
  );

  app.post(
    '/api/v1/encounters/:id/observations',
    { config: { permission: 'encounter.vitals.write' }, schema: { tags: ['encounters'], params: idParam, body: S.observation } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const row = await withScope(scopeOf(req.principal), async (trx) => {
        const e = await queueService.encounter(trx, req.params.id);
        if (!e.patient_id) throw AppError.validation('encounter has no patient');
        const row = await queueRepo.insertObservation(trx, {
          encounter_id: e.id,
          facility_id: e.facility_id,
          patient_id: e.patient_id,
          code: req.body.code,
          value_num: req.body.value_num ?? null,
          value_text: req.body.value_text ?? null,
          unit: req.body.unit ?? null,
          source: 'staff',
          recorded_by: staff.userId,
        });
        await writeOutbox(trx, {
          aggregateType: 'encounter',
          aggregateId: e.id,
          eventType: 'observation.recorded',
          payload: { encounterId: e.id, patientId: e.patient_id, facilityId: e.facility_id },
        });
        return row;
      });
      req.audit.record({
        action: 'observation.recorded',
        resourceType: 'observation',
        resourceId: row.id,
        patientId: row.patient_id,
        purpose: 'treatment',
      });
      return reply.code(201).send(row);
    },
  );

  app.post(
    '/api/v1/encounters/:id/diagnoses',
    { config: { permission: 'encounter.clinical.write' }, schema: { tags: ['encounters'], params: idParam, body: S.diagnosis } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const row = await withScope(scopeOf(req.principal), async (trx) => {
        const e = await queueService.encounter(trx, req.params.id);
        if (!e.patient_id) throw AppError.validation('encounter has no patient');
        return queueRepo.insertDiagnosis(trx, {
          encounter_id: e.id,
          facility_id: e.facility_id,
          patient_id: e.patient_id,
          code_system: req.body.code_system,
          code: req.body.code ?? null,
          display_text: req.body.display_text,
          is_primary: req.body.is_primary,
          recorded_by: staff.userId,
        });
      });
      req.audit.record({
        action: 'diagnosis.recorded',
        resourceType: 'encounter_diagnosis',
        resourceId: row.id,
        patientId: row.patient_id,
        purpose: 'treatment',
      });
      return reply.code(201).send(row);
    },
  );

  app.post(
    '/api/v1/encounters/:id/prescriptions',
    { config: { permission: 'encounter.clinical.write' }, schema: { tags: ['encounters'], params: idParam, body: S.prescription } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const row = await withScope(scopeOf(req.principal), async (trx) => {
        const e = await queueService.encounter(trx, req.params.id);
        if (!e.patient_id) throw AppError.validation('encounter has no patient');
        const row = await queueRepo.insertPrescription(trx, {
          encounter_id: e.id,
          facility_id: e.facility_id,
          patient_id: e.patient_id,
          drug_code: req.body.drug_code ?? null,
          drug_name: req.body.drug_name,
          strength: req.body.strength ?? null,
          dosage_form: req.body.dosage_form ?? null,
          dose: req.body.dose,
          frequency: req.body.frequency,
          duration_days: req.body.duration_days ?? null,
          route: req.body.route ?? null,
          instructions_i18n: req.body.instructions_i18n,
          prescribed_by: staff.userId,
        });
        await writeOutbox(trx, {
          aggregateType: 'encounter',
          aggregateId: e.id,
          eventType: 'prescription.recorded',
          payload: { encounterId: e.id, patientId: e.patient_id, facilityId: e.facility_id },
        });
        return row;
      });
      req.audit.record({
        action: 'prescription.recorded',
        resourceType: 'prescription_item',
        resourceId: row.id,
        patientId: row.patient_id,
        purpose: 'treatment',
      });
      return reply.code(201).send(row);
    },
  );

  app.post(
    '/api/v1/encounters/:id/complete',
    { config: { permission: 'encounter.complete' }, schema: { tags: ['encounters'], params: idParam, body: S.completeEncounter } },
    async (req) => {
      const staff = requireStaff(req);
      const live = await withScope(scopeOf(req.principal), (trx) => queueRepo.liveTokenForEncounter(trx, req.params.id));
      if (live && (live.status === 'in_consult' || live.status === 'called'))
        await queueService.transition(scopeOf(req.principal), live.id, live.version, 'complete', { userId: staff.userId });
      const result = await withScope(scopeOf(req.principal), async (trx) => {
        const e = await queueService.encounter(trx, req.params.id);
        const status = req.body.referred ? 'referred' : 'completed';
        await queueRepo.setEncounterStatus(trx, e.id, status, {
          closed_at: new Date(),
          consult_ended_at: e.consult_ended_at ?? new Date(),
        });
        const followups = await followupsService.schedule(trx, { ...e, status }, req.body.followups);
        await writeOutbox(trx, {
          aggregateType: 'encounter',
          aggregateId: e.id,
          eventType: 'encounter.completed',
          payload: { encounterId: e.id, patientId: e.patient_id, facilityId: e.facility_id, referred: req.body.referred },
        });
        return { encounter_id: e.id, status, followups };
      });
      req.audit.record({
        action: 'encounter.complete',
        resourceType: 'encounter',
        resourceId: req.params.id,
        purpose: 'treatment',
        details: { followups: req.body.followups.map((f) => f.kind) },
      });
      return result;
    },
  );

  // ---- triage override (If-Match on the encounter version) ----
  app.patch(
    '/api/v1/encounters/:id/triage',
    { config: { permission: 'triage.override' }, schema: { tags: ['encounters'], params: idParam, body: S.triageOverride } },
    async (req, reply) => {
      const staff = requireStaff(req);
      const version = requireVersion(req);
      const result = await withScope(scopeOf(req.principal), async (trx) => {
        const e = await queueService.encounter(trx, req.params.id);
        if (e.version !== version) throw AppError.versionConflict();
        const a = await triageRepo.assessment(trx, e.id);
        if (!a) throw AppError.notFound('triage assessment');
        const updated = await triageRepo.override(trx, e.id, req.body.final_level, staff.userId, req.body.reason);
        const enc = await queueRepo.updateEncounter(trx, e.id, e.version, { triage_level: req.body.final_level });
        await writeOutbox(trx, {
          aggregateType: 'encounter',
          aggregateId: e.id,
          eventType: 'triage.overridden',
          payload: { encounterId: e.id, from: a.final_level, to: req.body.final_level, by: staff.userId },
        });
        triageOverrides.inc({ direction: isLessUrgent(req.body.final_level, a.final_level) ? 'down' : 'up' });
        return { assessment: updated, encounter: enc };
      });
      req.audit.record({
        action: 'triage.override',
        resourceType: 'encounter',
        resourceId: req.params.id,
        patientId: result.encounter?.patient_id,
        purpose: 'treatment',
        details: { final_level: req.body.final_level, reason: req.body.reason },
      });
      setEtag(reply, result.encounter?.version ?? version + 1);
      return result;
    },
  );

  // ---- devices: offline mode ----
  app.post('/api/v1/devices/me/token-blocks', { schema: { tags: ['devices'], body: S.tokenBlock } }, async (req, reply) => {
    const device = requireDevice(req, ['kiosk', 'counter_terminal']);
    return reply
      .code(201)
      .send(await queueService.allocateBlock(scopeOf(req.principal), device.deviceId, req.body.queue_session_id, req.body.size));
  });
  app.post(
    '/api/v1/devices/me/offline-tokens',
    { config: { idempotent: true }, schema: { tags: ['devices'], body: S.offlineTokens } },
    async (req) => {
      const device = requireDevice(req, ['kiosk', 'counter_terminal']);
      return queueService.uploadOfflineTokens(scopeOf(req.principal), device, req.body);
    },
  );
  app.get('/api/v1/displays/me/snapshot', { schema: { tags: ['devices'] } }, async (req) => {
    const device = requireDevice(req);
    return queueService.displaySnapshot(device.facilityId, device.departmentIds);
  });

  void STATE_SCOPE;
  void triageService;
}
