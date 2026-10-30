/**
 * wa-inbound and wa-status processors (§9.9). Per-conversation lock keeps one person's messages ordered.
 */
import { DelayedError } from 'bullmq';
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { blindIndex, decryptJson, encrypt, randomToken } from '../../infra/crypto.js';
import { redisCore, keys } from '../../infra/redis.js';
import { logger } from '../../infra/logger.js';
import { boundaryDaysAgo } from '../../shared/ids.js';
import { render } from '../../shared/i18n.js';
import { normalisePhone } from '../../shared/phone.js';
import { deidentifyText } from '../../infra/llm/deidentify.js';
import { patientsService } from '../patients/service.js';
import { patientsRepo } from '../patients/repo.js';
import { intakeRepo } from '../intake/repo.js';
import { intakeEngine } from '../intake/engine.js';
import { sendOutbound, toInboundEvent } from './adapter.js';
import { waClient } from './client.js';

export async function runWaInbound(job, token) {
  const { message, waId } = decryptJson('jobs', Buffer.from(job.data.enc, 'base64'));
  const phone = normalisePhone(`+${waId}`);
  const refHash = blindIndex('wa_id', waId);
  const cp = await patientsService.findOrCreateContactPoint(phone, { verified: true });
  const conv = await withScope(STATE_SCOPE, async (trx) => {
    const c = await intakeRepo.findOrCreateConversation(trx, {
      channel: 'whatsapp',
      external_ref_hash: refHash,
      contact_point_id: cp.id,
      facility_id: null,
      language: 'hi',
    });
    if (cp.whatsapp_capable !== true) await patientsRepo.setWhatsappCapable(trx, cp.id, true);
    return c;
  });

  // Per-conversation lock: SET NX PX 30000 with a random owner token; held → delay this job 300 ms and retry in order.
  const owner = randomToken(16);
  const lockKey = keys.lockConv(conv.id);
  const got = await redisCore.set(lockKey, owner, 'PX', 30_000, 'NX');
  if (got !== 'OK') {
    await job.moveToDelayed(Date.now() + 300, token);
    throw new DelayedError();
  }
  try {
    const event = await toInboundEvent(message, conv.id);
    const inboundAt = new Date(Number(message.timestamp) * 1000);
    const stale = !!conv.last_inbound_at && inboundAt.getTime() < conv.last_inbound_at.getTime() - 1000;
    await withScope(STATE_SCOPE, async (trx) => {
      await intakeRepo.insertMessage(trx, {
        conversation_id: conv.id,
        direction: 'inbound',
        channel: 'whatsapp',
        provider_message_id: message.id,
        content_type: message.type,
        body_enc: encrypt('pii', JSON.stringify(message)).ciphertext,
        body_redacted: message.text?.body ? deidentifyText(message.text.body).slice(0, 500) : `[${message.type}]`,
        status: 'received',
        encounter_id: conv.active_encounter_id,
      });
      await intakeRepo.touchInbound(trx, conv.id);
    });
    void waClient.markRead(message.id);
    if (!event) return;
    // A message older than the last processed one only drives the state machine if it answers the open question.
    if (stale && event.kind !== 'choice') return;
    const messages = await intakeEngine.handle({ conversationId: conv.id, channel: 'whatsapp', messageId: message.id }, event);
    const buttonLabel = (await render('btn.choose', conv.language)).text;
    for (const m of messages) {
      try {
        const sent = await sendOutbound(phone, m, buttonLabel);
        await withScope(STATE_SCOPE, async (trx) => {
          await intakeRepo.insertMessage(trx, {
            conversation_id: conv.id,
            direction: 'outbound',
            channel: 'whatsapp',
            provider_message_id: sent.messageId,
            content_type: sent.contentType,
            body_enc: encrypt('pii', m.text).ciphertext,
            body_redacted: `[${m.templateCode}]`,
            template_code: m.templateCode,
            status: 'sent',
            encounter_id: conv.active_encounter_id,
          });
          await trx.updateTable('conversations').set({ last_outbound_at: new Date() }).where('id', '=', conv.id).execute();
        });
      } catch (err) {
        logger.error({ err, template: m.templateCode }, 'whatsapp reply failed');
      }
    }
  } finally {
    await redisCore.releaseLock(lockKey, owner).catch(() => {});
  }
}

const STATUS_MAP = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

export async function runWaStatus(data) {
  const status = STATUS_MAP[data.status];
  if (!status) return;
  await withScope(STATE_SCOPE, async (trx) => {
    await intakeRepo.updateMessageStatus(trx, data.providerMessageId, status, boundaryDaysAgo(7)); // Q13
    if (status === 'failed') {
      await trx
        .updateTable('notifications')
        .set({ status: 'failed', last_error: `wa_${data.errors[0]?.code ?? 'failed'}` })
        .where('provider_message_id', '=', data.providerMessageId)
        .where('id', '>=', boundaryDaysAgo(7))
        .execute();
      await intakeRepo.setMessageError(trx, data.providerMessageId, String(data.errors[0]?.code ?? ''), boundaryDaysAgo(7));
    } else {
      await trx
        .updateTable('notifications')
        .set({ status: status === 'read' ? 'delivered' : status === 'delivered' ? 'delivered' : 'sent' })
        .where('provider_message_id', '=', data.providerMessageId)
        .where('id', '>=', boundaryDaysAgo(7))
        .where('status', 'in', ['pending', 'sent'])
        .execute();
    }
  });
}

/** template-sync (every 6 h): refresh provider approval statuses. Needs the WABA id (WA_WABA_ID) to be configured. */
export async function runTemplateSync() {
  const wabaId = process.env['WA_WABA_ID'];
  if (!wabaId) return 0;
  const list = await waClient.listTemplates(wabaId);
  await withScope(STATE_SCOPE, async (trx) => {
    for (const t of list)
      await trx
        .updateTable('message_templates')
        .set({ provider_status: t.status })
        .where('provider_template_name', '=', t.name)
        .where('language', '=', t.language.split('_')[0])
        .execute();
  });
  return list.length;
}
