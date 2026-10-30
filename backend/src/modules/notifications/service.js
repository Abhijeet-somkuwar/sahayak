/**
 * One notification API (§9.10): notify(contactPointId, templateCode, vars, { dedupeKey, critical }).
 * Checks whatsapp_notifications consent for non-critical messages, applies quiet hours (21:00–07:00 IST) to
 * non-urgent ones, picks the channel, writes a notifications row and enqueues the send. 🔒 No marketing, ever.
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { redisCore, keys } from '../../infra/redis.js';
import { enqueue } from '../../infra/queues.js';
import { istDateTime, istDate, addDays, isQuietHours } from '../../shared/time.js';
import { patientsRepo } from '../patients/repo.js';
import { patientsService } from '../patients/service.js';
import { notificationsRepo } from './repo.js';

function msUntilQuietHoursEnd(now = new Date()) {
  const today = istDate(now);
  const sevenToday = istDateTime(today, '07:00');
  const target = now < sevenToday ? sevenToday : istDateTime(addDays(today, 1), '07:00');
  return Math.max(0, target.getTime() - now.getTime());
}

export async function notify(contactPointId, templateCode, vars, opts) {
  const once = await redisCore.set(keys.notifOnce(opts.dedupeKey), '1', 'EX', 48 * 3600, 'NX');
  if (once !== 'OK') return { status: 'suppressed', reason: 'duplicate' };
  const critical = !!opts.critical || !!opts.authentication;

  return withScope(STATE_SCOPE, async (trx) => {
    const cp = await patientsRepo.contactPointById(trx, contactPointId);
    if (!cp) return { status: 'suppressed', reason: 'unknown_contact' };
    if (!critical) {
      const consent = await patientsService.consentState(trx, contactPointId, null);
      if (consent['whatsapp_notifications'] === false) {
        await notificationsRepo.insert(trx, {
          contact_point_id: contactPointId,
          channel: 'whatsapp',
          template_code: templateCode,
          language: opts.language ?? 'hi',
          variables: vars,
          dedupe_key: opts.dedupeKey,
          status: 'suppressed',
          encounter_id: opts.encounterId ?? null,
        });
        return { status: 'suppressed', reason: 'consent_withdrawn' };
      }
    }
    const language = opts.language ?? (await notificationsRepo.primaryLanguage(trx, contactPointId)) ?? 'hi';
    const channel = cp.whatsapp_capable === false ? 'sms' : 'whatsapp';
    const delayMs = !critical && isQuietHours() ? msUntilQuietHoursEnd() : 0;
    const row = await notificationsRepo.insert(trx, {
      contact_point_id: contactPointId,
      channel,
      template_code: templateCode,
      language,
      variables: vars,
      dedupe_key: opts.dedupeKey,
      status: 'pending',
      encounter_id: opts.encounterId ?? null,
    });
    await enqueue(
      channel === 'whatsapp' ? 'wa-outbound' : 'sms-outbound',
      'send',
      { notificationId: row.id, critical },
      { jobId: row.id, delay: delayMs },
    );
    return { status: 'queued', notificationId: row.id, channel, delayMs };
  });
}

export const notificationsService = { notify };
