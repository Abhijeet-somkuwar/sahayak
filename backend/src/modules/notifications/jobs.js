/**
 * wa-outbound / sms-outbound processors (§9.9 outbound, §12.1) and notify-thresholds (§9.5.7).
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { encrypt } from '../../infra/crypto.js';
import { enqueue } from '../../infra/queues.js';
import { redisCore, keys } from '../../infra/redis.js';
import { sms } from '../../infra/sms/index.js';
import { waOutbound, waTemplateFallback } from '../../infra/metrics.js';
import { logger } from '../../infra/logger.js';
import { render } from '../../shared/i18n.js';
import { patientsRepo } from '../patients/repo.js';
import { patientsService } from '../patients/service.js';
import { waClient, WaError } from '../whatsapp/client.js';
import { notificationsRepo } from './repo.js';
import { notify } from './service.js';
import { getFacilityConfig, roomLabel } from '../facilities/service.js';

const WINDOW_MS = 24 * 3600 * 1000;

export class PermanentFailure extends Error {}

export async function runWaOutbound(data) {
  const n = await withScope(STATE_SCOPE, (trx) => notificationsRepo.byId(trx, data.notificationId));
  if (!n || n.status !== 'pending') return;
  const tpl = await render(n.template_code, n.language, n.variables, 'whatsapp');
  const result = await withScope(STATE_SCOPE, async (trx) => {
    const phone = await patientsService.contactPointPhone(trx, n.contact_point_id);
    if (!phone) throw new PermanentFailure('no phone');
    const conv = await notificationsRepo.conversationForContact(trx, n.contact_point_id);
    const inWindow = !!conv?.last_inbound_at && Date.now() - conv.last_inbound_at.getTime() < WINDOW_MS;
    return { phone, conv, inWindow };
  });
  try {
    let sent;
    const buttons = Array.isArray(n.variables['_buttons']) ? n.variables['_buttons'] : null;
    if (result.inWindow) {
      sent = buttons?.length
        ? await waClient.sendButtons(result.phone, tpl.text, buttons)
        : await waClient.sendText(result.phone, tpl.text);
    } else if (tpl.providerTemplateName) {
      waTemplateFallback.inc();
      const params = tpl.variables.map((v) => String(n.variables[v] ?? ''));
      sent = await waClient.sendTemplate(result.phone, tpl.providerTemplateName, tpl.language, params);
    } else {
      // Outside the window without an approved template: critical messages fall back to SMS, others fail.
      if (data.critical) {
        await enqueue('sms-outbound', 'send', { notificationId: n.id, critical: true }, { jobId: `${n.id}:sms` });
      }
      await withScope(STATE_SCOPE, (trx) =>
        notificationsRepo.setStatus(trx, n.id, data.critical ? 'sent' : 'failed', { error: 'outside_window_no_template' }),
      );
      waOutbound.inc({ status: 'no_template' });
      return;
    }
    await withScope(STATE_SCOPE, async (trx) => {
      await notificationsRepo.setStatus(trx, n.id, 'sent', { providerMessageId: sent.messageId });
      if (result.conv) {
        await notificationsRepo.insertMessage(trx, {
          conversation_id: result.conv.id,
          direction: 'outbound',
          channel: 'whatsapp',
          provider_message_id: sent.messageId,
          content_type: result.inWindow ? 'text' : 'template',
          body_enc: encrypt('pii', tpl.text).ciphertext,
          body_redacted: `[template ${n.template_code}]`,
          template_code: n.template_code,
          status: 'sent',
          encounter_id: n.encounter_id,
        });
        await notificationsRepo.touchOutbound(trx, result.conv.id);
      }
    });
    waOutbound.inc({ status: 'sent' });
  } catch (err) {
    if (err instanceof WaError && err.permanent) {
      await withScope(STATE_SCOPE, async (trx) => {
        if (err.code === 131026 || err.code === 131047) await patientsRepo.setWhatsappCapable(trx, n.contact_point_id, false);
        await notificationsRepo.setStatus(trx, n.id, 'failed', { error: `wa_${err.code ?? err.status}` });
      });
      waOutbound.inc({ status: 'failed_permanent' });
      if (data.critical) await enqueue('sms-outbound', 'send', { notificationId: n.id, critical: true }, { jobId: `${n.id}:sms` });
      return; // do not retry
    }
    await withScope(STATE_SCOPE, (trx) => notificationsRepo.setStatus(trx, n.id, 'pending', { error: err.message.slice(0, 200) }));
    waOutbound.inc({ status: 'retry' });
    throw err; // BullMQ retries with exponential backoff + jitter
  }
}

export async function runSmsOutbound(data) {
  const n = await withScope(STATE_SCOPE, (trx) => notificationsRepo.byId(trx, data.notificationId));
  if (!n) return;
  const tpl = await render(n.template_code, n.language, n.variables, 'sms');
  const phone = await withScope(STATE_SCOPE, (trx) => patientsService.contactPointPhone(trx, n.contact_point_id));
  if (!phone) return;
  const res = await sms().send(phone, tpl.providerTemplateName ?? n.template_code, tpl.text);
  await withScope(STATE_SCOPE, (trx) =>
    notificationsRepo.setStatus(trx, n.id, res.ok ? 'sent' : 'failed', {
      providerMessageId: res.providerMessageId ?? null,
      error: res.error ?? null,
    }),
  );
  if (!res.ok) throw new Error(res.error ?? 'sms failed');
}

/**
 * Threshold alerts (§9.5.7): after token.called for a session, read the first 12 members of each lane,
 * compute `ahead`, and send at 10 ahead and 3 ahead; each alert exactly once (dedupe key eta:<tokenId>:<threshold>).
 */
export async function runNotifyThresholds(data) {
  const qs = data.queueSessionId;
  const lanes = await Promise.all([0, 1, 2].map((l) => redisCore.zrange(keys.lane(qs, l), 0, 11)));
  const tokenIds = lanes.flat();
  if (tokenIds.length === 0) return;
  const cfg = await getFacilityConfig(data.facilityId).catch(() => null);
  const rows = await withScope(STATE_SCOPE, (trx) => notificationsRepo.contactsForTokens(trx, tokenIds));
  for (const [laneIdx, members] of lanes.entries()) {
    for (const tokenId of members) {
      const pos = await redisCore.tokenPosition(keys.lane(qs, 0), keys.lane(qs, 1), keys.lane(qs, 2), keys.meta(qs), tokenId, laneIdx);
      if (!pos) continue;
      const ahead = pos[1];
      const threshold = ahead <= 3 ? 3 : ahead <= 10 ? 10 : null;
      if (threshold === null) continue;
      const row = rows.find((r) => r.token_id === tokenId);
      if (!row?.contact_point_id) continue;
      const room = cfg ? roomLabel(cfg, row.service_point_id) : '';
      await notify(
        row.contact_point_id,
        threshold === 3 ? 'queue.three_ahead' : 'queue.ten_ahead',
        { token: row.display_code, ahead, room },
        { dedupeKey: `eta:${tokenId}:${threshold}`, encounterId: row.encounter_id, critical: threshold === 3 },
      ).catch((err) => logger.warn({ err }, 'threshold alert failed'));
    }
  }
}
