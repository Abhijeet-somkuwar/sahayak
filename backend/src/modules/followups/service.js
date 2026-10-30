import { withScope, STATE_SCOPE } from '../../infra/db.js';

import { enqueue } from '../../infra/queues.js';
import { boundaryMonthsAgo, newId } from '../../shared/ids.js';
import { istDate, istDateTime, addDays } from '../../shared/time.js';
import { writeOutbox } from '../../shared/outbox.js';
import { AppError } from '../../shared/errors.js';
import { notify } from '../notifications/service.js';
import { queueService } from '../queue/service.js';
import { getPublishedRuleSet } from '../triage/service.js';
import { emergencyPrescreen } from '../triage/engine.js';
import { followupsRepo } from './repo.js';

const TEMPLATE = {
  symptom_checkin: 'followup.symptom_checkin',
  medication_reminder: 'followup.medication_reminder',
  revisit_due: 'followup.revisit_due',
  report_ready: 'followup.report_ready',
};

export const followupsService = {
  /** Called when the doctor completes an encounter and ticks the follow-ups to schedule. */
  async schedule(trx, encounter, requests) {
    if (!encounter.patient_id) return [];
    let contactPointId = encounter.contact_point_id;
    if (!contactPointId) contactPointId = await followupsRepo.primaryContactForPatient(trx, encounter.patient_id);
    if (!contactPointId) return [];
    const out = [];
    const now = Date.now();
    const add = async (kind, dueAt, payload) => {
      const row = await followupsRepo.insert(trx, {
        encounter_id: encounter.id,
        facility_id: encounter.facility_id,
        patient_id: encounter.patient_id,
        contact_point_id: contactPointId,
        kind,
        due_at: dueAt,
        template_code: TEMPLATE[kind],
        payload,
      });
      await writeOutbox(trx, {
        aggregateType: 'followup',
        aggregateId: row.id,
        eventType: 'followup.scheduled',
        payload: { followupId: row.id, encounterId: encounter.id, dueAt: dueAt.toISOString() },
      });
      out.push({ id: row.id, kind, due_at: dueAt });
    };
    for (const r of requests) {
      if (r.kind === 'symptom_checkin') await add('symptom_checkin', new Date(now + (r.due_in_hours ?? 72) * 3600_000), {});
      else if (r.kind === 'revisit_due') await add('revisit_due', new Date(now + (r.due_in_hours ?? 24 * 7) * 3600_000), {});
      else if (r.kind === 'report_ready') await add('report_ready', new Date(now + (r.due_in_hours ?? 48) * 3600_000), {});
      else if (r.kind === 'medication_reminder') {
        // Patient opt-in: daily at chosen times until the prescription's duration ends (capped at 30 days).
        const days = Math.min(r.days ?? 5, 30);
        const times = r.reminder_times?.length ? r.reminder_times : ['09:00', '21:00'];
        let date = istDate();
        for (let d = 0; d < days; d++) {
          for (const t of times) {
            const due = istDateTime(date, t);
            if (due.getTime() > now) await add('medication_reminder', due, { time: t, day: d + 1, days });
          }
          date = addDays(date, 1);
        }
      }
    }
    return out;
  },

  /** Relay/sweep → delayed job. */
  async enqueueDispatch(followupId, encounterId, dueAt) {
    await enqueue(
      'followup-dispatch',
      'dispatch',
      { followupId, encounterId },
      { jobId: followupId, delay: Math.max(0, dueAt.getTime() - Date.now()) },
    );
  },

  async dispatch(followupId, encounterId) {
    const f = await withScope(STATE_SCOPE, (trx) => followupsRepo.byId(trx, encounterId, followupId));
    if (!f || f.status !== 'scheduled') return;
    const vars = { ...f.payload, encounter_id: encounterId, followup_id: followupId };
    if (f.kind === 'symptom_checkin')
      vars['_buttons'] = [
        { id: `fu:${encounterId}:${followupId}:better`, title: 'Better' },
        { id: `fu:${encounterId}:${followupId}:same`, title: 'Same' },
        { id: `fu:${encounterId}:${followupId}:worse`, title: 'Worse' },
      ];
    const res = await notify(f.contact_point_id, f.template_code, vars, {
      dedupeKey: `fu:${followupId}`,
      encounterId,
      critical: f.kind === 'report_ready',
    });
    await withScope(STATE_SCOPE, (trx) =>
      followupsRepo.setStatus(trx, encounterId, followupId, res.status === 'queued' ? 'sent' : 'failed', { sent_at: new Date() }),
    );
  },

  /** Q12 safety net. */
  async sweep() {
    return withScope(STATE_SCOPE, async (trx) => {
      const due = await followupsRepo.dueSweep(trx, boundaryMonthsAgo(6));
      for (const d of due) await this.enqueueDispatch(d.id, d.encounter_id, new Date());
      return due.length;
    });
  },

  /** Symptom check-in response: Better → close; Same → offer revisit; Worse → pre-screen + priority booking (§9.10). */
  async respond(encounterId, followupId, answer, freeText) {
    return withScope(STATE_SCOPE, async (trx) => {
      const f = await followupsRepo.byId(trx, encounterId, followupId);
      if (!f) throw AppError.notFound('follow-up');
      const original = await queueService.encounter(trx, encounterId);
      if (answer === 'better') {
        await followupsRepo.setStatus(trx, encounterId, followupId, 'responded', { responded_at: new Date(), response: { answer } });
        return { outcome: 'closed' };
      }
      if (answer === 'same') {
        await followupsRepo.setStatus(trx, encounterId, followupId, 'responded', { responded_at: new Date(), response: { answer } });
        return { outcome: 'offer_revisit' };
      }
      // worse
      const rules = await getPublishedRuleSet();
      const pre = freeText ? emergencyPrescreen(rules.rules, freeText) : { emergency: false, selfHarm: false, matched: [] };
      const escalationId = newId();
      if (pre.emergency || pre.selfHarm) {
        await queueService.createEncounter(trx, {
          id: escalationId,
          facilityId: original.facility_id,
          patientId: original.patient_id,
          contactPointId: original.contact_point_id,
          channel: 'whatsapp',
          kind: 'emergency',
          status: 'emergency_redirected',
          triageLevel: 'emergency',
          parentEncounterId: encounterId,
        });
        await queueService.createPrealert(trx, original.facility_id, escalationId, {
          source: 'followup_worse',
          matched: pre.matched,
          self_harm: pre.selfHarm,
        });
        await followupsRepo.setStatus(trx, encounterId, followupId, 'escalated', {
          responded_at: new Date(),
          response: { answer, text_redacted: '[redacted]' },
          escalation_encounter_id: escalationId,
        });
        return { outcome: 'emergency', escalation_encounter_id: escalationId };
      }
      await queueService.createEncounter(trx, {
        id: escalationId,
        facilityId: original.facility_id,
        patientId: original.patient_id,
        contactPointId: original.contact_point_id,
        channel: 'whatsapp',
        kind: 'opd_followup',
        status: 'booked',
        departmentId: original.department_id,
        triageLevel: 'priority',
        parentEncounterId: encounterId,
        sessionDate: addDays(istDate(), 1),
      });
      await followupsRepo.setStatus(trx, encounterId, followupId, 'escalated', {
        responded_at: new Date(),
        response: { answer },
        escalation_encounter_id: escalationId,
      });
      return { outcome: 'priority_booked', escalation_encounter_id: escalationId };
    });
  },

  /** report_ready is triggered by staff now (lab integration in phase 3). */
  async reportReady(trx, encounterId) {
    const e = await queueService.encounter(trx, encounterId);
    const rows = await this.schedule(trx, e, [{ kind: 'report_ready', due_in_hours: 0.01 }]);
    return rows[0] ?? null;
  },
};
