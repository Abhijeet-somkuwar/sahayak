/**
 * Outbox relay (§12.1): a loop in the worker running Q11 every 200 ms while there is work and every 1 s when idle,
 * publishing each event to its consumers and setting published_at. Two instances can run concurrently (SKIP LOCKED).
 * Consumers are idempotent (D18).
 */
import { sql } from 'kysely';
import { db } from '../infra/db.js';
import { outboxLag } from '../infra/metrics.js';
import { logger } from '../infra/logger.js';
import { uuid7Time } from '../shared/ids.js';
import { projectToken, setSessionMeta, storeTokenRef, tokenRefOf, laneCounts, tokenPosition } from '../modules/queue/projection.js';
import { publishRealtime } from '../modules/realtime/events.js';
import { enqueuePrebrief } from '../modules/prebrief/jobs.js';
import { scheduleSummaryRebuild } from '../modules/patients/jobs.js';
import { enqueue } from '../infra/queues.js';
import { notify } from '../modules/notifications/service.js';
import { followupsService } from '../modules/followups/service.js';
import { triageService } from '../modules/triage/service.js';
import { kbService } from '../modules/kb/service.js';
import { env } from '../config/env.js';

const TOKEN_STATUS = {
  'token.checked_in': 'waiting',
  'token.offline_synced': 'waiting',
  'token.called': 'called',
  'token.recalled': 'called',
  'token.skipped': 'skipped',
  'token.requeued': 'waiting',
  'token.started': 'in_consult',
  'token.completed': 'completed',
  'token.cancelled': 'cancelled',
  'token.no_show': 'no_show',
  'token.transferred': 'transferred',
};

async function dispatch(ev) {
  const p = ev.payload;
  const status = TOKEN_STATUS[ev.event_type];
  if (status && p.queueSessionId && p.tokenId && p.version !== undefined) {
    await projectToken({
      queueSessionId: p.queueSessionId,
      tokenId: p.tokenId,
      version: p.version,
      status,
      lane: p.lane ?? 2,
      score: p.score ?? Date.now(),
      code: p.code ?? '',
      room: p.room ?? '',
    });
    const [c0, c1, c2] = await laneCounts(p.queueSessionId);
    await publishRealtime({
      event: 'queue.updated',
      rooms: [{ kind: 'queue', id: p.queueSessionId }, ...(p.facilityId ? [{ kind: 'facility', id: p.facilityId }] : [])],
      payload: { queue_session_id: p.queueSessionId, lanes: { urgent: c0, protected: c1, general: c2 } },
    });
    const pos = await tokenPosition(p.queueSessionId, p.tokenId).catch(() => null);
    await publishRealtime({
      event: 'token.status',
      rooms: [{ kind: 'token', id: p.tokenId }],
      payload: { token: p.code, status, people_ahead: pos?.ahead ?? 0, eta: pos?.eta ?? null, room: p.room ?? '' },
    });
  }
  switch (ev.event_type) {
    case 'token.checked_in': {
      if (p.publicRef && p.queueSessionId && p.tokenId) await storeTokenRef(p.publicRef, p.queueSessionId, p.tokenId);
      if (p.encounterId && p.patientId) await enqueuePrebrief(p.encounterId, p.ahead ?? 0);
      if (p.contactPointId && p.publicRef && p.encounterId)
        await notify(
          p.contactPointId,
          'queue.checked_in',
          { token: p.code, status_url: `${env.PUBLIC_BASE_URL}/t/${p.publicRef}`, ahead: p.ahead ?? 0 },
          { dedupeKey: `checkin:${p.tokenId}`, encounterId: p.encounterId },
        );
      break;
    }
    case 'token.called':
    case 'token.recalled': {
      if (p.queueSessionId && p.tokenId) {
        await publishRealtime({
          event: 'token.called',
          rooms: [
            { kind: 'queue', id: p.queueSessionId },
            ...(p.doctorId ? [{ kind: 'doctor', id: p.doctorId }] : []),
            { kind: 'token', id: p.tokenId },
          ],
          payload: { queue_session_id: p.queueSessionId, token: p.code, room: p.room ?? '', lane: p.lane },
        });
        if (p.contactPointId && p.encounterId)
          await notify(
            p.contactPointId,
            'queue.your_turn',
            { token: p.code, room: p.room ?? '' },
            {
              dedupeKey: `eta:${p.tokenId}:0:${ev.event_type === 'token.recalled' ? p.version : 0}`,
              critical: true,
              encounterId: p.encounterId,
            },
          );
        if (p.facilityId)
          await enqueue(
            'notify-thresholds',
            'thresholds',
            { queueSessionId: p.queueSessionId, facilityId: p.facilityId },
            { jobId: `${p.queueSessionId}:${ev.id}` },
          );
      }
      break;
    }
    case 'token.cancelled': {
      if (p.offerNextSession && p.contactPointId && p.encounterId)
        await notify(
          p.contactPointId,
          'queue.session_closed_offer',
          { token: p.code },
          { dedupeKey: `closed:${p.tokenId}`, critical: true, encounterId: p.encounterId },
        );
      break;
    }
    case 'session.opened':
    case 'session.paused':
    case 'session.closed': {
      if (p.queueSessionId) {
        await setSessionMeta(
          p.queueSessionId,
          { status: ev.event_type.split('.')[1] === 'opened' ? 'open' : ev.event_type.split('.')[1] },
          6 * 3600,
        );
        await publishRealtime({
          event: 'queue.updated',
          rooms: [{ kind: 'queue', id: p.queueSessionId }],
          payload: { queue_session_id: p.queueSessionId, status: ev.event_type.split('.')[1] },
        });
        if (ev.event_type === 'session.paused') {
          // Pausing freezes ETAs and notifies waiting patients once (§9.5.9).
          const { withScope, STATE_SCOPE } = await import('../infra/db.js');
          const rows = await withScope(STATE_SCOPE, (trx) =>
            trx
              .selectFrom('opd_tokens as t')
              .innerJoin('encounters as e', 'e.id', 't.encounter_id')
              .select(['t.id', 'e.contact_point_id', 'e.id as encounter_id'])
              .where('t.queue_session_id', '=', p.queueSessionId)
              .where('t.status', '=', 'waiting')
              .execute(),
          );
          for (const r of rows)
            if (r.contact_point_id)
              await notify(
                r.contact_point_id,
                'queue.paused',
                {},
                { dedupeKey: `paused:${p.queueSessionId}:${r.id}`, encounterId: r.encounter_id },
              );
        }
      }
      break;
    }
    case 'encounter.completed':
    case 'allergy.changed':
    case 'condition.changed':
    case 'prescription.recorded':
      if (p.patientId) await scheduleSummaryRebuild(p.patientId);
      break;
    case 'observation.recorded':
      // Regenerate the pre-brief if vitals arrive before the call (§9.6).
      if (p.encounterId) {
        const ref = p.encounterId;
        await enqueuePrebrief(ref, 0, `obs-${ev.id}`);
      }
      break;
    case 'prealert.created':
      if (p.facilityId)
        await publishRealtime({
          event: 'ed.prealert',
          rooms: [{ kind: 'ed', id: p.facilityId }],
          payload: { prealert_id: p.prealertId, summary: p.summary ?? {} },
        });
      break;
    case 'followup.scheduled':
      if (p.followupId && p.encounterId && p.dueAt) await followupsService.enqueueDispatch(p.followupId, p.encounterId, new Date(p.dueAt));
      break;
    case 'rules.published':
      await triageService.afterPublish();
      break;
    case 'kb.published':
      await kbService.afterPublish(p.facilityId ?? null);
      break;
    case 'doctor.status_changed':
    case 'token.transferred':
    case 'encounter.created':
    case 'triage.overridden':
    case 'patient.merged':
    case 'token.started':
    case 'token.completed':
    case 'token.skipped':
    case 'token.requeued':
    case 'token.no_show':
    case 'token.offline_synced':
      if (ev.event_type === 'token.completed' && p.queueSessionId && typeof p['consultSeconds'] === 'number') {
        const { recordConsult } = await import('../modules/queue/projection.js');
        await recordConsult(p.queueSessionId, p['consultSeconds']);
      }
      if (ev.event_type === 'token.transferred' && p.tokenId) {
        const ref = await tokenRefOf(p.tokenId);
        void ref;
      }
      break;
    default:
      break;
  }
}

/** Failing events back off (2^attempts seconds, max 60 s) so one poison event does not spin the relay. */
const retryAfter = new Map();

export async function relayOnce() {
  return db.transaction().execute(async (trx) => {
    const rows = await sql`
      -- query: Q11
      SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts
      FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY id
      LIMIT 500
      FOR UPDATE SKIP LOCKED`
      .execute(trx)
      .then((r) => r.rows);
    if (rows.length === 0) {
      outboxLag.set(0);
      return 0;
    }
    outboxLag.set(Math.max(0, (Date.now() - uuid7Time(rows[0].id).getTime()) / 1000));
    const done = [];
    const failed = [];
    const now = Date.now();
    for (const ev of rows) {
      if ((retryAfter.get(ev.id) ?? 0) > now) continue;
      try {
        await dispatch(ev);
        done.push(ev.id);
        retryAfter.delete(ev.id);
      } catch (err) {
        failed.push(ev.id);
        const attempt = ev.attempts ?? 0;
        retryAfter.set(ev.id, now + Math.min(60_000, 2 ** Math.min(attempt, 6) * 1000));
        logger.error({ err, event: ev.event_type, id: ev.id, attempt }, 'outbox dispatch failed');
      }
    }
    if (done.length) await trx.updateTable('outbox_events').set({ published_at: new Date() }).where('id', 'in', done).execute();
    if (failed.length)
      await trx
        .updateTable('outbox_events')
        .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
        .where('id', 'in', failed)
        .execute();
    return rows.length;
  });
}

export function startOutboxRelay() {
  let running = true;
  (async () => {
    while (running) {
      let n = 0;
      try {
        n = await relayOnce();
      } catch (err) {
        logger.warn({ err }, 'outbox relay iteration failed');
      }
      await new Promise((r) => setTimeout(r, n > 0 ? 200 : 1000));
    }
  })();
  return {
    stop: () => {
      running = false;
    },
  };
}
