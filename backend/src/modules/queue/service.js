import { withScope, STATE_SCOPE, facilityScope } from '../../infra/db.js';

import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { ageYears, istDate, istDateTime, istMinutes } from '../../shared/time.js';
import { writeOutbox } from '../../shared/outbox.js';
import { randomBase32 } from '../../infra/crypto.js';
import { cacheGetOrSet } from '../../infra/cache.js';
import { keys } from '../../infra/redis.js';
import { queueCheckins, queueCallNextDuration, queueWaitSeconds } from '../../infra/metrics.js';
import { logger } from '../../infra/logger.js';
import { getFacilityConfig, roomLabel } from '../facilities/service.js';
import { publishRealtime } from '../realtime/events.js';
import { queueRepo } from './repo.js';
import { assignLane, etaRange, laneFallbackOrder, selectLane, LANE_URGENT } from './lanes.js';
import * as proj from './projection.js';

const SESSION_TTL = 6 * 3600;

function displayCode(prefix, n) {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

async function tokenRoom(cfg, servicePointId) {
  return roomLabel(cfg, servicePointId);
}

async function afterTokenCommit(cfg, qs, token, extra = {}) {
  await proj.projectToken({
    queueSessionId: qs,
    tokenId: token.id,
    version: token.version,
    status: token.status,
    lane: token.lane,
    score: token.queue_entry_at.getTime(),
    code: token.display_code,
    room: await tokenRoom(cfg, token.service_point_id),
  });
  if (extra.publish !== false) {
    const [c0, c1, c2] = await proj.laneCounts(qs);
    await publishRealtime({
      event: 'queue.updated',
      rooms: [
        { kind: 'queue', id: qs },
        { kind: 'facility', id: cfg.facility.id },
      ],
      payload: { queue_session_id: qs, lanes: { urgent: c0, protected: c1, general: c2 } },
    });
  }
}

export const queueService = {
  // ---------- sessions ----------
  async ensureSession(trx, facilityId, departmentId, date, shift, opts = {}) {
    const existing = await queueRepo.sessionFor(trx, departmentId, date, shift);
    if (existing) return existing;
    const cfg = await getFacilityConfig(facilityId);
    const dept = cfg.departments.find((d) => d.id === departmentId);
    if (!dept) throw AppError.notFound('department');
    const startsAt = opts.startsAt ?? istDateTime(date, shift === 'morning' ? cfg.opd.registration_hours.start : '14:00');
    const endsAt = opts.endsAt ?? istDateTime(date, shift === 'morning' ? '14:00' : '20:00');
    const row = await queueRepo.insertSession(trx, {
      facility_id: facilityId,
      department_id: departmentId,
      session_date: date,
      shift,
      token_prefix: opts.tokenPrefix ?? dept.token_prefix,
      lane_ratio: opts.laneRatio ?? cfg.opd.lane_ratio,
      starts_at: startsAt,
      ends_at: endsAt,
      capacity: null,
    });
    return row ?? (await queueRepo.sessionFor(trx, departmentId, date, shift));
  },

  async openSession(trx, sessionId, actor) {
    const s = await queueRepo.sessionById(trx, sessionId);
    if (!s) throw AppError.notFound('queue session');
    if (s.status === 'closed') throw new AppError('session_closed', 'session is closed');
    if (s.status === 'open') return s;
    const updated = await queueRepo.setSessionStatus(trx, sessionId, 'open', { opened_at: s.opened_at ?? new Date() });
    await queueRepo.insertEvent(trx, {
      queue_session_id: sessionId,
      facility_id: s.facility_id,
      kind: 'session_opened',
      actor_user_id: actor.userId ?? null,
      device_id: actor.deviceId ?? null,
    });
    await writeOutbox(trx, {
      aggregateType: 'queue_session',
      aggregateId: sessionId,
      eventType: 'session.opened',
      payload: { queueSessionId: sessionId, facilityId: s.facility_id, departmentId: s.department_id },
    });
    return updated;
  },

  /** Seeds ETA inputs at open (§9.5.6): median of the last 4 same-weekday sessions, else department default. */
  async seedSessionMeta(session, cfg) {
    const dept = cfg.departments.find((d) => d.id === session.department_id);
    const seed = await withScope(STATE_SCOPE, async (trx) => {
      const rows = await trx
        .selectFrom('facility_daily_stats')
        .select('consult_p50_seconds')
        .where('facility_id', '=', session.facility_id)
        .where('department_id', '=', session.department_id)
        .where('consult_p50_seconds', 'is not', null)
        .orderBy('stat_date', 'desc')
        .limit(4)
        .execute();
      const vals = rows.map((r) => r.consult_p50_seconds).sort((a, b) => a - b);
      return vals.length ? vals[Math.floor(vals.length / 2)] : null;
    }).catch(() => null);
    const [rp, rg] = session.lane_ratio;
    await proj.setSessionMeta(
      session.id,
      {
        status: session.status,
        ewma_consult_sec: seed ?? dept?.default_consult_seconds ?? cfg.opd.default_eta_seconds,
        ratio_protected: rp ?? 1,
        ratio_general: rg ?? 2,
        starts_at: session.starts_at.getTime(),
      },
      SESSION_TTL + Math.max(0, Math.floor((session.ends_at.getTime() - Date.now()) / 1000)),
    );
  },

  async pauseSession(trx, sessionId, actor) {
    const s = await queueRepo.sessionById(trx, sessionId);
    if (!s) throw AppError.notFound('queue session');
    if (s.status !== 'open') throw new AppError('invalid_state', `cannot pause a ${s.status} session`);
    const updated = await queueRepo.setSessionStatus(trx, sessionId, 'paused');
    await queueRepo.insertEvent(trx, {
      queue_session_id: sessionId,
      facility_id: s.facility_id,
      kind: 'session_paused',
      actor_user_id: actor.userId ?? null,
    });
    await writeOutbox(trx, {
      aggregateType: 'queue_session',
      aggregateId: sessionId,
      eventType: 'session.paused',
      payload: { queueSessionId: sessionId, facilityId: s.facility_id },
    });
    return updated;
  },

  /** Close (§9.5.9): waiting → cancelled + LWBS; skipped → no_show. */
  async closeSession(trx, sessionId, actor) {
    const s = await queueRepo.sessionById(trx, sessionId);
    if (!s) throw AppError.notFound('queue session');
    if (s.status === 'closed') return { session: s, cancelled: 0, noShows: 0, affected: [] };
    const tokens = await queueRepo.tokensByStatus(trx, sessionId, ['waiting', 'skipped', 'called']);
    const affected = [];
    let cancelled = 0,
      noShows = 0;
    for (const t of tokens) {
      const toStatus = t.status === 'skipped' || t.status === 'called' ? 'no_show' : 'cancelled';
      const updated = await queueRepo.transition(trx, t.id, t.version, { status: toStatus });
      if (!updated) continue;
      affected.push(updated);
      await queueRepo.setEncounterStatus(trx, t.encounter_id, toStatus === 'no_show' ? 'no_show' : 'left_without_being_seen', {
        closed_at: new Date(),
      });
      await queueRepo.insertEvent(trx, {
        queue_session_id: sessionId,
        token_id: t.id,
        encounter_id: t.encounter_id,
        facility_id: s.facility_id,
        kind: toStatus,
        actor_user_id: actor.userId ?? null,
        token_version: updated.version,
        payload: { reason: 'session_closed' },
      });
      await writeOutbox(trx, {
        aggregateType: 'opd_token',
        aggregateId: t.id,
        eventType: toStatus === 'no_show' ? 'token.no_show' : 'token.cancelled',
        payload: {
          queueSessionId: sessionId,
          tokenId: t.id,
          encounterId: t.encounter_id,
          version: updated.version,
          lane: t.lane,
          score: t.queue_entry_at.getTime(),
          code: t.display_code,
          facilityId: s.facility_id,
          reason: 'session_closed',
          offerNextSession: toStatus === 'cancelled',
        },
      });
      if (toStatus === 'cancelled') cancelled++;
      else noShows++;
    }
    const updated = await queueRepo.setSessionStatus(trx, sessionId, 'closed', { closed_at: new Date() });
    await queueRepo.insertEvent(trx, {
      queue_session_id: sessionId,
      facility_id: s.facility_id,
      kind: 'session_closed',
      actor_user_id: actor.userId ?? null,
      payload: { cancelled, no_shows: noShows },
    });
    await writeOutbox(trx, {
      aggregateType: 'queue_session',
      aggregateId: sessionId,
      eventType: 'session.closed',
      payload: { queueSessionId: sessionId, facilityId: s.facility_id, cancelled, noShows },
    });
    return { session: updated, cancelled, noShows, affected };
  },

  async sessionsToday(scope, facilityId, date = istDate()) {
    const cfg = await getFacilityConfig(facilityId);
    const sessions = await withScope(scope, (trx) => queueRepo.sessionsForDay(trx, facilityId, date));
    return Promise.all(
      sessions.map(async (s) => {
        const [counts, meta] = await Promise.all([proj.laneCounts(s.id), proj.getSessionMeta(s.id)]);
        const dept = cfg.departments.find((d) => d.id === s.department_id);
        const waiting = counts[0] + counts[1] + counts[2];
        return {
          id: s.id,
          department_id: s.department_id,
          department: dept?.name ?? null,
          token_prefix: s.token_prefix,
          shift: s.shift,
          status: s.status,
          session_date: s.session_date,
          starts_at: s.starts_at,
          ends_at: s.ends_at,
          last_token_no: s.last_token_no,
          capacity: s.capacity,
          lane_ratio: s.lane_ratio,
          lanes: { urgent: counts[0], protected: counts[1], general: counts[2] },
          waiting,
          ewma_consult_sec: meta.ewma_consult_sec,
          active_servers: meta.active_servers,
          eta_for_new_token: etaRange(
            Math.ceil((waiting + 1) / Math.max(meta.active_servers, 1)) * meta.ewma_consult_sec,
            meta.active_servers,
            s.starts_at,
          ),
        };
      }),
    );
  },

  // ---------- encounters ----------
  async createEncounter(trx, input) {
    const id = input.id ?? newId();
    const row = await queueRepo.insertEncounter(trx, {
      id,
      facility_id: input.facilityId,
      patient_id: input.patientId,
      contact_point_id: input.contactPointId ?? null,
      channel: input.channel,
      kind: input.kind ?? 'opd_new',
      status: input.status ?? 'intake',
      session_date: input.sessionDate ?? istDate(),
      department_id: input.departmentId ?? null,
      triage_level: input.triageLevel ?? null,
      parent_encounter_id: input.parentEncounterId ?? null,
    });
    await writeOutbox(trx, {
      aggregateType: 'encounter',
      aggregateId: id,
      eventType: 'encounter.created',
      payload: { encounterId: id, facilityId: input.facilityId, channel: input.channel },
    });
    return row;
  },

  async encounter(trx, id) {
    const e = await queueRepo.encounterById(trx, id);
    if (!e) throw AppError.notFound('encounter');
    return e;
  },

  async setTriageLevel(trx, encounterId, level) {
    const e = await this.encounter(trx, encounterId);
    await queueRepo.updateEncounter(trx, encounterId, e.version, { triage_level: level });
  },

  /** Pre-arrival alert for casualty (§9.3 outcome_emergency). Summary carries no direct identifiers. */
  async createPrealert(trx, facilityId, encounterId, summary) {
    const row = await queueRepo.insertPrealert(trx, { facility_id: facilityId, encounter_id: encounterId, summary });
    await writeOutbox(trx, {
      aggregateType: 'emergency_prealert',
      aggregateId: row.id,
      eventType: 'prealert.created',
      payload: { prealertId: row.id, facilityId, encounterId, summary },
    });
    return row;
  },

  // ---------- check-in (§9.5.3) ----------
  async checkIn(scope, sessionId, input, actor) {
    const started = Date.now();
    const result = await withScope(scope, async (trx) => {
      const session = await queueRepo.sessionById(trx, sessionId);
      if (!session) throw AppError.notFound('queue session');
      const cfg = await getFacilityConfig(session.facility_id);

      // Resolve or create the encounter.
      let encounter;
      if (input.encounter_id) {
        encounter = await this.encounter(trx, input.encounter_id);
        if (encounter.facility_id !== session.facility_id)
          throw new AppError('facility_scope_violation', 'encounter belongs to another facility');
        if (['checked_in', 'in_consult', 'completed'].includes(encounter.status)) {
          const live = await queueRepo.liveTokenForEncounter(trx, encounter.id);
          if (live)
            throw new AppError('conflict', 'encounter already has a live token', { token_id: live.id, display_code: live.display_code });
        }
        if (!['intake', 'triaged', 'booked'].includes(encounter.status))
          throw new AppError('invalid_state', `encounter is ${encounter.status}`);
      } else {
        encounter = await this.createEncounter(trx, {
          facilityId: session.facility_id,
          patientId: input.patient_id,
          channel: input.source,
          departmentId: session.department_id,
          triageLevel: input.triage_level ?? 'routine',
          status: 'triaged',
        });
      }
      const triageLevel = input.triage_level ?? encounter.triage_level ?? 'routine';
      if (triageLevel === 'emergency')
        throw new AppError('invalid_state', '🔒 emergency triage never enters an OPD queue; send the patient to casualty');
      if (!encounter.patient_id) throw AppError.validation('encounter has no patient yet');

      // Lane.
      const patient = await queueRepo.patientBasics(trx, encounter.patient_id);
      if (!patient) throw AppError.notFound('patient');
      const facts = await queueRepo.intakeFactsForEncounter(trx, encounter.id);
      const lane = assignLane({
        triageLevel,
        ageYears: ageYears(patient.birth_date, patient.birth_year),
        pregnant: facts['pregnant'] === true,
        disability: facts['disability'] === true || !!input.protected_lane,
        protectedMinAge: cfg.opd.protected_lane_min_age,
      });

      // queue_entry_at: on-time arrivals within the reporting window keep window_start (§9.5.1).
      const now = new Date();
      let queueEntryAt = now;
      const ws = typeof facts['reporting_window_start'] === 'string' ? new Date(facts['reporting_window_start']) : null;
      if (ws && !Number.isNaN(ws.getTime())) {
        const windowEnd = new Date(ws.getTime() + cfg.opd.reporting_window_minutes * 60_000);
        if (now <= windowEnd) queueEntryAt = ws < now ? ws : now; // early arrivals are ordered by arrival, on-time by window start
        if (now < ws) queueEntryAt = now;
      }

      // Q4 — token number under the session row lock.
      const alloc = await queueRepo.allocateTokenNo(trx, sessionId);
      if (!alloc) throw new AppError('queue_unavailable', 'queue session is closed or full');
      const [c0, c1, c2] = await proj.laneCounts(sessionId).catch(() => [0, 0, 0]);
      const meta = await proj.getSessionMeta(sessionId);
      const ahead = lane === 0 ? c0 : lane === 1 ? c0 + c1 : c0 + c1 + c2;
      const token = await queueRepo.insertToken(trx, {
        id: newId(),
        queue_session_id: sessionId,
        encounter_id: encounter.id,
        facility_id: session.facility_id,
        session_date: session.session_date,
        token_no: alloc.token_no,
        display_code: displayCode(alloc.token_prefix, alloc.token_no),
        lane,
        queue_entry_at: queueEntryAt,
        status: 'waiting',
        source: input.source,
        preferred_doctor_id: input.preferred_doctor_id ?? null,
        eta_seconds_at_entry: Math.ceil((ahead + 1) / Math.max(meta.active_servers, 1)) * meta.ewma_consult_sec,
      });
      const updatedEnc = await queueRepo.updateEncounter(trx, encounter.id, encounter.version, {
        status: 'checked_in',
        checked_in_at: now,
        token_display: token.display_code,
        department_id: session.department_id,
        triage_level: triageLevel,
      });
      if (!updatedEnc) throw AppError.versionConflict();
      await queueRepo.insertEvent(trx, {
        queue_session_id: sessionId,
        token_id: token.id,
        encounter_id: encounter.id,
        facility_id: session.facility_id,
        kind: 'checked_in',
        actor_user_id: actor.userId ?? null,
        device_id: actor.deviceId ?? null,
        token_version: token.version,
        payload: { lane, token_no: token.token_no },
      });
      const publicRef = randomBase32(10);
      await writeOutbox(trx, {
        aggregateType: 'opd_token',
        aggregateId: token.id,
        eventType: 'token.checked_in',
        payload: {
          queueSessionId: sessionId,
          tokenId: token.id,
          encounterId: encounter.id,
          patientId: encounter.patient_id,
          contactPointId: encounter.contact_point_id,
          version: token.version,
          lane,
          score: queueEntryAt.getTime(),
          code: token.display_code,
          room: '',
          facilityId: session.facility_id,
          departmentId: session.department_id,
          ahead,
          publicRef,
        },
      });
      if (session.status === 'scheduled') await this.openSession(trx, sessionId, actor); // first check-in opens the session
      return { session, cfg, token, encounter: updatedEnc, publicRef, ahead };
    });

    // After commit: projection, status link, realtime, metrics. (The outbox relay replays these if we crash here.)
    if (result.session.status === 'scheduled') await this.seedSessionMeta({ ...result.session, status: 'open' }, result.cfg);
    await proj.setSessionMeta(sessionId, { status: 'open' }, SESSION_TTL);
    await afterTokenCommit(result.cfg, sessionId, result.token);
    await proj.storeTokenRef(result.publicRef, sessionId, result.token.id).catch(() => {});
    const position = await proj.tokenPosition(sessionId, result.token.id, result.session.starts_at).catch(() => null);
    queueCheckins.inc({ facility: result.session.facility_id, department: result.session.department_id });
    logger.debug({ latency_ms: Date.now() - started }, 'check-in');
    return {
      token: {
        id: result.token.id,
        display_code: result.token.display_code,
        lane: result.token.lane,
        token_no: result.token.token_no,
        status: result.token.status,
        version: result.token.version,
        queue_entry_at: result.token.queue_entry_at.toISOString(),
      },
      encounter_id: result.encounter.id,
      queue_session_id: sessionId,
      public_ref: result.publicRef,
      status_url: `/t/${result.publicRef}`,
      position,
    };
  },

  // ---------- call next (§9.5.4) ----------
  async callNext(scope, sessionId, doctorId, servicePointId) {
    const end = queueCallNextDuration.startTimer();
    const session = await withScope(scope, (trx) => queueRepo.sessionById(trx, sessionId));
    if (!session) throw AppError.notFound('queue session');
    if (session.status !== 'open') throw new AppError('invalid_state', `session is ${session.status}`);
    const cfg = await getFacilityConfig(session.facility_id);
    let heads;
    try {
      heads = await proj.laneHeads(sessionId);
    } catch {
      heads = (await withScope(scope, (trx) => queueRepo.laneHeads(trx, sessionId))).map((h) => ({
        lane: h.lane,
        queueEntryAt: h.queue_entry_at.getTime(),
      }));
    }
    const meta = await proj.getSessionMeta(sessionId);
    const selected = selectLane(
      {
        ratioProtected: meta.ratio_protected,
        ratioGeneral: meta.ratio_general,
        servedProtected: meta.served_protected,
        servedGeneral: meta.served_general,
      },
      heads,
      cfg.opd.max_wait_minutes,
    );
    if (selected === null) {
      end();
      return null;
    }

    const called = await withScope(scope, async (trx) => {
      for (const lane of laneFallbackOrder(selected)) {
        const row = await queueRepo.callNext(trx, sessionId, lane, doctorId, servicePointId);
        if (row) {
          const token = await queueRepo.tokenById(trx, row.id);
          const encounter = await this.encounter(trx, token.encounter_id);
          await queueRepo.updateEncounter(trx, encounter.id, encounter.version, { doctor_user_id: doctorId });
          await queueRepo.insertEvent(trx, {
            queue_session_id: sessionId,
            token_id: token.id,
            encounter_id: token.encounter_id,
            facility_id: session.facility_id,
            kind: 'called',
            actor_user_id: doctorId,
            token_version: token.version,
            payload: { lane, service_point_id: servicePointId },
          });
          await writeOutbox(trx, {
            aggregateType: 'opd_token',
            aggregateId: token.id,
            eventType: 'token.called',
            payload: {
              queueSessionId: sessionId,
              tokenId: token.id,
              encounterId: token.encounter_id,
              contactPointId: encounter.contact_point_id,
              version: token.version,
              lane,
              score: token.queue_entry_at.getTime(),
              code: token.display_code,
              room: roomLabel(cfg, servicePointId),
              facilityId: session.facility_id,
              departmentId: session.department_id,
              doctorId,
            },
          });
          queueWaitSeconds.observe((Date.now() - token.queue_entry_at.getTime()) / 1000);
          return { token, encounter };
        }
      }
      return null;
    });
    if (!called) {
      end();
      return null;
    }
    await proj.incrServed(sessionId, called.token.lane);
    await afterTokenCommit(cfg, sessionId, called.token);
    await proj.setServing(sessionId, doctorId, called.token.id);
    end();
    return { token: called.token, encounter: called.encounter, room: roomLabel(cfg, servicePointId) };
  },

  // ---------- transitions (§9.5.2, §9.5.5) ----------
  async transition(scope, tokenId, expectedVersion, action, actor, opts = {}) {
    const res = await withScope(scope, async (trx) => {
      const t = await queueRepo.tokenById(trx, tokenId);
      if (!t) throw AppError.notFound('token');
      if (t.version !== expectedVersion) throw AppError.versionConflict();
      const session = await queueRepo.sessionById(trx, t.queue_session_id);
      const cfg = await getFacilityConfig(session.facility_id);
      const encounter = await this.encounter(trx, t.encounter_id);
      const now = new Date();
      let patch = {};
      let kind;
      let eventType;
      let encPatch = null;
      let encStatus = null;
      switch (action) {
        case 'recall':
          if (t.status !== 'called') throw new AppError('invalid_state', `cannot recall a ${t.status} token`);
          if (t.call_count >= 3) throw new AppError('invalid_state', 'maximum of 3 calls reached; skip the patient');
          patch = { status: 'called', called_at: now, call_count: t.call_count + 1 };
          kind = 'recalled';
          eventType = 'token.recalled';
          break;
        case 'skip':
          if (t.status !== 'called') throw new AppError('invalid_state', `cannot skip a ${t.status} token`);
          patch = { status: 'skipped' };
          kind = 'skipped';
          eventType = 'token.skipped';
          break;
        case 'start':
          if (t.status !== 'called') throw new AppError('invalid_state', `cannot start consult for a ${t.status} token`);
          patch = { status: 'in_consult', consult_started_at: now };
          kind = 'consult_started';
          eventType = 'token.started';
          encStatus = 'in_consult';
          encPatch = { consult_started_at: now, wait_seconds: Math.round((now.getTime() - t.queue_entry_at.getTime()) / 1000) };
          break;
        case 'complete': {
          if (t.status !== 'in_consult' && t.status !== 'called')
            throw new AppError('invalid_state', `cannot complete a ${t.status} token`);
          const startedAt = t.consult_started_at ?? t.called_at ?? now;
          patch = { status: 'completed', consult_ended_at: now, consult_started_at: startedAt };
          kind = 'consult_ended';
          eventType = 'token.completed';
          encStatus = 'completed';
          encPatch = {
            consult_ended_at: now,
            consult_started_at: encounter.consult_started_at ?? startedAt,
            consult_seconds: Math.round((now.getTime() - startedAt.getTime()) / 1000),
            wait_seconds: encounter.wait_seconds ?? Math.round((startedAt.getTime() - t.queue_entry_at.getTime()) / 1000),
          };
          break;
        }
        case 'requeue':
          if (t.status !== 'skipped') throw new AppError('invalid_state', `cannot re-queue a ${t.status} token`);
          patch = {
            status: 'waiting',
            queue_entry_at: new Date(t.queue_entry_at.getTime() + cfg.opd.requeue_penalty_minutes * 60_000),
            served_by: null,
            service_point_id: null,
          };
          kind = 'lane_changed';
          eventType = 'token.requeued';
          break;
        case 'cancel':
          if (!['waiting', 'skipped'].includes(t.status)) throw new AppError('invalid_state', `cannot cancel a ${t.status} token`);
          patch = { status: 'cancelled' };
          kind = 'cancelled';
          eventType = 'token.cancelled';
          encStatus = 'cancelled';
          encPatch = { closed_at: now };
          break;
      }
      const updated = await queueRepo.transition(trx, t.id, t.version, patch);
      if (!updated) throw AppError.versionConflict();
      if (encStatus) await queueRepo.setEncounterStatus(trx, encounter.id, encStatus, encPatch ?? {});
      else if (encPatch) await queueRepo.updateEncounter(trx, encounter.id, encounter.version, encPatch);
      await queueRepo.insertEvent(trx, {
        queue_session_id: t.queue_session_id,
        token_id: t.id,
        encounter_id: t.encounter_id,
        facility_id: t.facility_id,
        kind,
        actor_user_id: actor.userId ?? null,
        device_id: actor.deviceId ?? null,
        token_version: updated.version,
        payload: { action, reason: opts.reason ?? null },
      });
      await writeOutbox(trx, {
        aggregateType: 'opd_token',
        aggregateId: t.id,
        eventType,
        payload: {
          queueSessionId: t.queue_session_id,
          tokenId: t.id,
          encounterId: t.encounter_id,
          patientId: encounter.patient_id,
          contactPointId: encounter.contact_point_id,
          version: updated.version,
          lane: updated.lane,
          score: updated.queue_entry_at.getTime(),
          code: updated.display_code,
          room: roomLabel(cfg, updated.service_point_id),
          facilityId: t.facility_id,
          departmentId: session.department_id,
          doctorId: actor.userId ?? null,
          consultSeconds:
            action === 'complete' ? Math.round((now.getTime() - (t.consult_started_at ?? t.called_at ?? now).getTime()) / 1000) : undefined,
        },
      });
      if (action === 'complete' && encStatus === 'completed')
        await writeOutbox(trx, {
          aggregateType: 'encounter',
          aggregateId: encounter.id,
          eventType: 'encounter.completed',
          payload: { encounterId: encounter.id, patientId: encounter.patient_id, facilityId: encounter.facility_id },
        });
      return { token: updated, cfg, session, encounter };
    });
    await afterTokenCommit(res.cfg, res.token.queue_session_id, res.token);
    if (action === 'complete') {
      const consultSeconds = Math.round(
        (res.token.consult_ended_at.getTime() - (res.token.consult_started_at ?? res.token.consult_ended_at).getTime()) / 1000,
      );
      await proj.recordConsult(res.token.queue_session_id, consultSeconds);
      if (res.token.served_by) await proj.setServing(res.token.queue_session_id, res.token.served_by, null);
    }
    if (action === 'skip' && res.token.served_by) await proj.setServing(res.token.queue_session_id, res.token.served_by, null);
    return res.token;
  },

  /** Transfer (§9.5.2): old token → transferred; new token in the target department's session (source staff_transfer). */
  async transfer(scope, tokenId, expectedVersion, departmentId, actor, reason) {
    const res = await withScope(scope, async (trx) => {
      const t = await queueRepo.tokenById(trx, tokenId);
      if (!t) throw AppError.notFound('token');
      if (t.version !== expectedVersion) throw AppError.versionConflict();
      if (!['waiting', 'called', 'in_consult'].includes(t.status))
        throw new AppError('invalid_state', `cannot transfer a ${t.status} token`);
      const session = await queueRepo.sessionById(trx, t.queue_session_id);
      if (session.department_id === departmentId) throw AppError.validation('token is already in this department');
      const cfg = await getFacilityConfig(session.facility_id);
      const target = await this.ensureSession(trx, session.facility_id, departmentId, session.session_date, session.shift);
      const alloc = await queueRepo.allocateTokenNo(trx, target.id);
      if (!alloc) throw new AppError('queue_unavailable', 'target queue is closed or full');
      const old = await queueRepo.transition(trx, t.id, t.version, { status: 'transferred' });
      if (!old) throw AppError.versionConflict();
      const now = new Date();
      const fresh = await queueRepo.insertToken(trx, {
        id: newId(),
        queue_session_id: target.id,
        encounter_id: t.encounter_id,
        facility_id: t.facility_id,
        session_date: t.session_date,
        token_no: alloc.token_no,
        display_code: displayCode(alloc.token_prefix, alloc.token_no),
        lane: t.lane,
        queue_entry_at: t.queue_entry_at,
        status: 'waiting',
        source: 'staff_transfer',
        eta_seconds_at_entry: null,
      });
      const encounter = await this.encounter(trx, t.encounter_id);
      await queueRepo.updateEncounter(trx, encounter.id, encounter.version, {
        department_id: departmentId,
        token_display: fresh.display_code,
        status: 'checked_in',
        doctor_user_id: null,
      });
      await queueRepo.insertEvent(trx, {
        queue_session_id: t.queue_session_id,
        token_id: t.id,
        encounter_id: t.encounter_id,
        facility_id: t.facility_id,
        kind: 'transferred',
        actor_user_id: actor.userId ?? null,
        token_version: old.version,
        payload: { to_department_id: departmentId, new_token_id: fresh.id, reason: reason ?? null },
      });
      await queueRepo.insertEvent(trx, {
        queue_session_id: target.id,
        token_id: fresh.id,
        encounter_id: t.encounter_id,
        facility_id: t.facility_id,
        kind: 'token_issued',
        actor_user_id: actor.userId ?? null,
        token_version: fresh.version,
        payload: { transferred_from: t.id },
      });
      await writeOutbox(trx, {
        aggregateType: 'opd_token',
        aggregateId: t.id,
        eventType: 'token.transferred',
        payload: {
          queueSessionId: t.queue_session_id,
          tokenId: t.id,
          encounterId: t.encounter_id,
          version: old.version,
          lane: old.lane,
          score: old.queue_entry_at.getTime(),
          code: old.display_code,
          room: '',
          facilityId: t.facility_id,
          departmentId: session.department_id,
        },
      });
      await writeOutbox(trx, {
        aggregateType: 'opd_token',
        aggregateId: fresh.id,
        eventType: 'token.checked_in',
        payload: {
          queueSessionId: target.id,
          tokenId: fresh.id,
          encounterId: t.encounter_id,
          patientId: encounter.patient_id,
          contactPointId: encounter.contact_point_id,
          version: fresh.version,
          lane: fresh.lane,
          score: fresh.queue_entry_at.getTime(),
          code: fresh.display_code,
          room: '',
          facilityId: t.facility_id,
          departmentId,
          ahead: 0,
          publicRef: null,
          transferred: true,
          at: now.toISOString(),
        },
      });
      if (target.status === 'scheduled') await this.openSession(trx, target.id, actor);
      return { old, fresh, target, cfg };
    });
    await afterTokenCommit(res.cfg, res.old.queue_session_id, res.old);
    await proj.setSessionMeta(res.target.id, { status: 'open' }, SESSION_TTL);
    await afterTokenCommit(res.cfg, res.target.id, res.fresh);
    const ref = await proj.tokenRefOf(tokenId);
    if (ref) await proj.storeTokenRef(ref, res.target.id, res.fresh.id).catch(() => {});
    return { transferred: res.old, token: res.fresh, queue_session_id: res.target.id };
  },

  // ---------- public status link (§9.1) ----------
  async statusByRef(ref) {
    const resolved = await proj.resolveTokenRef(ref);
    if (!resolved) throw AppError.notFound('token');
    const session = await withScope(STATE_SCOPE, (trx) => queueRepo.sessionById(trx, resolved.qs));
    const cfg = session ? await getFacilityConfig(session.facility_id) : null;
    const dept = cfg?.departments.find((d) => d.id === session?.department_id);
    let position = null;
    try {
      position = await proj.tokenPosition(resolved.qs, resolved.tokenId, session?.starts_at);
    } catch {
      position = null;
    }
    if (!position) {
      // Redis unavailable or evicted → compute from Postgres (slower; §8.4).
      const t = await withScope(STATE_SCOPE, (trx) => queueRepo.tokenById(trx, resolved.tokenId));
      if (!t) throw AppError.notFound('token');
      const p = t.status === 'waiting' ? await withScope(STATE_SCOPE, (trx) => queueRepo.sqlPosition(trx, t)) : null;
      const meta = await proj
        .getSessionMeta(resolved.qs)
        .catch(() => ({ ewma_consult_sec: cfg?.opd.default_eta_seconds ?? 300, active_servers: 1 }));
      const ahead = p ? (t.lane === 0 ? p.rank : t.lane === 1 ? p.urgent + p.rank : p.urgent + p.protected_ + p.rank) : 0;
      const etaSeconds = Math.ceil((ahead + 1) / Math.max(meta.active_servers, 1)) * meta.ewma_consult_sec;
      position = {
        rank: p?.rank ?? 0,
        ahead,
        eta_seconds: etaSeconds,
        eta: etaRange(etaSeconds, meta.active_servers, session?.starts_at),
        status: t.status,
        code: t.display_code,
        room: cfg ? roomLabel(cfg, t.service_point_id) : '',
        lane: t.lane,
      };
    }
    // 🔒 Only token code, department, room, position and ETA range: no name, no clinical data.
    return {
      token: position.code,
      department: dept?.name ?? null,
      department_i18n: dept?.name_i18n ?? {},
      room: position.room || null,
      status: position.status,
      people_ahead: position.ahead,
      eta: position.eta,
      session_status: session?.status ?? null,
    };
  },

  // ---------- doctor status (§9.5.6) ----------
  async setDoctorStatus(userId, status, queueSessionId, facilityIds) {
    await proj.setDoctorStatus(userId, status, queueSessionId);
    const sessions = await withScope(facilityScope(facilityIds), (trx) => queueRepo.openSessions(trx));
    for (const s of sessions.filter((x) => !queueSessionId || x.id === queueSessionId)) {
      const doctors = await withScope(STATE_SCOPE, (trx) =>
        trx.selectFrom('doctor_schedules').select('user_id').where('department_id', '=', s.department_id).execute(),
      );
      const ids = new Set(doctors.map((d) => d.user_id));
      ids.add(userId);
      const n = await proj.refreshActiveServers(s.id, [...ids]);
      await publishRealtime({
        event: 'doctor.status',
        rooms: [
          { kind: 'queue', id: s.id },
          { kind: 'doctor', id: userId },
        ],
        payload: { queue_session_id: s.id, doctor_id: userId, status, active_servers: n },
      });
      if (n === 0)
        await publishRealtime({
          event: 'queue.updated',
          rooms: [{ kind: 'queue', id: s.id }],
          payload: { queue_session_id: s.id, doctor_unavailable: true },
        });
    }
    await withScope(facilityScope(facilityIds), async (trx) => {
      for (const s of sessions.filter((x) => !queueSessionId || x.id === queueSessionId)) {
        await queueRepo.insertEvent(trx, {
          queue_session_id: s.id,
          facility_id: s.facility_id,
          kind: 'doctor_status_changed',
          actor_user_id: userId,
          payload: { status },
        });
      }
    });
    return { status, queue_session_id: queueSessionId };
  },

  // ---------- offline blocks (§9.5.8) ----------
  async allocateBlock(scope, deviceId, sessionId, size) {
    return withScope(scope, async (trx) => {
      const session = await queueRepo.sessionById(trx, sessionId);
      if (!session) throw AppError.notFound('queue session');
      const cfg = await getFacilityConfig(session.facility_id);
      if (!cfg.opd.offline_blocks_enabled) throw AppError.forbidden('offline token blocks are disabled for this facility');
      const n = size ?? cfg.opd.offline_block_size;
      const alloc = await queueRepo.allocateBlock(trx, sessionId, n);
      if (!alloc) throw new AppError('queue_unavailable', 'queue session is closed or full');
      const block = await queueRepo.insertTokenBlock(trx, {
        queue_session_id: sessionId,
        device_id: deviceId,
        first_no: alloc.last_no - n + 1,
        last_no: alloc.last_no,
      });
      return {
        block_id: block.id,
        queue_session_id: sessionId,
        first_no: block.first_no,
        last_no: block.last_no,
        token_prefix: alloc.token_prefix,
      };
    });
  },

  async uploadOfflineTokens(scope, device, input) {
    const skewMs = Math.abs(Date.now() - new Date(input.device_time).getTime());
    const useServerTime = skewMs > 5 * 60_000;
    const out = [];
    const created = [];
    const result = await withScope(scope, async (trx) => {
      const session = await queueRepo.sessionById(trx, input.queue_session_id);
      if (!session) throw AppError.notFound('queue session');
      if (session.facility_id !== device.facilityId) throw new AppError('facility_scope_violation');
      const cfg = await getFacilityConfig(session.facility_id);
      const blocks = await queueRepo.blocksForDevice(trx, device.deviceId, session.id);
      for (const tk of input.tokens) {
        const existing = await queueRepo.tokenById(trx, tk.client_id);
        if (existing) {
          out.push({ client_id: tk.client_id, status: 'exists', token_id: existing.id });
          continue;
        }
        if (!blocks.some((b) => tk.token_no >= b.first_no && tk.token_no <= b.last_no)) {
          out.push({ client_id: tk.client_id, status: 'rejected', reason: 'number outside the device blocks' });
          continue;
        }
        let patientId = tk.patient_id ?? null;
        if (!patientId && tk.patient) {
          const { patientsService } = await import('../patients/service.js');
          const cp = tk.patient.phone
            ? await patientsService.findOrCreateContactPoint((await import('../../shared/phone.js')).normalisePhone(tk.patient.phone))
            : null;
          const p = cp
            ? await patientsService.createFromIntake(trx, cp.id, {
                name: tk.patient.display_name,
                sex: tk.patient.sex,
                ageYears: tk.patient.age_years,
                language: 'hi',
                relationship: 'self',
              })
            : await patientsService.create(
                trx,
                {
                  display_name: tk.patient.display_name,
                  sex: tk.patient.sex,
                  age_years: tk.patient.age_years,
                  preferred_language: 'hi',
                  relationship: 'self',
                  force: true,
                },
                null,
              );
          patientId = p.id;
        }
        if (!patientId) {
          out.push({ client_id: tk.client_id, status: 'rejected', reason: 'patient required' });
          continue;
        }
        const enc = await this.createEncounter(trx, {
          facilityId: session.facility_id,
          patientId,
          channel: 'offline_sync',
          departmentId: session.department_id,
          triageLevel: 'routine',
          status: 'triaged',
          sessionDate: session.session_date,
        });
        const entryAt = useServerTime ? new Date() : new Date(tk.issued_at);
        const token = await queueRepo.insertToken(trx, {
          id: tk.client_id,
          queue_session_id: session.id,
          encounter_id: enc.id,
          facility_id: session.facility_id,
          session_date: session.session_date,
          token_no: tk.token_no,
          display_code: displayCode(session.token_prefix, tk.token_no),
          lane: tk.lane,
          queue_entry_at: entryAt,
          status: 'waiting',
          source: 'offline_block',
        });
        await queueRepo.updateEncounter(trx, enc.id, enc.version, {
          status: 'checked_in',
          checked_in_at: entryAt,
          token_display: token.display_code,
        });
        await queueRepo.insertEvent(trx, {
          queue_session_id: session.id,
          token_id: token.id,
          encounter_id: enc.id,
          facility_id: session.facility_id,
          kind: 'offline_tokens_synced',
          device_id: device.deviceId,
          token_version: token.version,
          payload: { token_no: tk.token_no, clock_skew_ms: skewMs },
        });
        await writeOutbox(trx, {
          aggregateType: 'opd_token',
          aggregateId: token.id,
          eventType: 'token.offline_synced',
          payload: {
            queueSessionId: session.id,
            tokenId: token.id,
            encounterId: enc.id,
            version: token.version,
            lane: token.lane,
            score: entryAt.getTime(),
            code: token.display_code,
            room: '',
            facilityId: session.facility_id,
            departmentId: session.department_id,
          },
        });
        created.push(token);
        out.push({ client_id: tk.client_id, status: 'created', token_id: token.id });
      }
      return { cfg, session };
    });
    for (const t of created) await afterTokenCommit(result.cfg, result.session.id, t, { publish: false });
    return { results: out, used_server_time: useServerTime };
  },

  // ---------- display snapshot & wait board ----------
  async displaySnapshot(facilityId, departmentIds) {
    const cfg = await getFacilityConfig(facilityId);
    const sessions = await withScope(facilityScope([facilityId]), (trx) => queueRepo.sessionsForDay(trx, facilityId, istDate()));
    const items = [];
    for (const s of sessions.filter((x) => departmentIds.length === 0 || departmentIds.includes(x.department_id))) {
      const serving = await (await import('../../infra/redis.js')).redisCore.hgetall(keys.serving(s.id)).catch(() => ({}));
      const nowServing = [];
      for (const [doctorId, tokenId] of Object.entries(serving)) {
        const tok = await (await import('../../infra/redis.js')).redisCore.hgetall(keys.tok(s.id, tokenId)).catch(() => null);
        if (tok?.['status'] === 'called' || tok?.['status'] === 'in_consult')
          nowServing.push({ token: tok['code'], room: tok['room'], doctor_id: doctorId });
      }
      const next = await withScope(facilityScope([facilityId]), async (trx) =>
        (await Promise.all([0, 1, 2].map((l) => queueRepo.nextWaitingCodes(trx, s.id, l, 5)))).flat(),
      );
      const dept = cfg.departments.find((d) => d.id === s.department_id);
      items.push({
        queue_session_id: s.id,
        department: dept?.name ?? '',
        department_i18n: dept?.name_i18n ?? {},
        status: s.status,
        now_serving: nowServing,
        next: next.map((n) => ({ token: n.display_code, lane: n.lane })),
      });
    }
    // 🔒 token codes and rooms only
    return { facility: cfg.facility.name, items, generated_at: new Date().toISOString() };
  },
};

/** Public per-department wait snapshot, cached 15 s (waitboard:<facilityId>). */
export async function waitboard(facilityId) {
  return cacheGetOrSet(keys.waitboard(facilityId), { ttlSeconds: 15 }, async () => {
    const sessions = await withScope(STATE_SCOPE, (trx) => queueRepo.sessionsForDay(trx, facilityId, istDate()));
    const departments = [];
    for (const s of sessions) {
      const [counts, meta] = await Promise.all([proj.laneCounts(s.id).catch(() => [0, 0, 0]), proj.getSessionMeta(s.id)]);
      const waiting = counts[0] + counts[1] + counts[2];
      departments.push({
        department_id: s.department_id,
        waiting,
        status: s.status,
        eta: etaRange(
          Math.ceil((waiting + 1) / Math.max(meta.active_servers, 1)) * meta.ewma_consult_sec,
          meta.active_servers,
          s.starts_at,
        ),
      });
    }
    return { departments };
  });
}

export { LANE_URGENT, istMinutes };
