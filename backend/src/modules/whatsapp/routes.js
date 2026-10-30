import { env } from '../../config/env.js';
import { encryptJson } from '../../infra/crypto.js';
import { hmacSha256Hex, safeEqual } from '../../infra/crypto.js';
import { redisCore, keys } from '../../infra/redis.js';
import { enqueue } from '../../infra/queues.js';
import { waInbound, waSignatureFailures, waWebhookDuration } from '../../infra/metrics.js';
import { AppError } from '../../shared/errors.js';
import { extractMessages } from './adapter.js';

export async function whatsappWebhookRoutes(app) {
  // Keep the raw body for signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    try {
      done(null, { raw: body, json: JSON.parse(body.toString('utf8')) });
    } catch (err) {
      done(err, undefined);
    }
  });

  app.get('/api/v1/webhooks/whatsapp', { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
    const q = req.query;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === env.WA_VERIFY_TOKEN && q['hub.challenge'])
      return reply.type('text/plain').send(q['hub.challenge']);
    throw AppError.forbidden('verification failed');
  });

  app.post('/api/v1/webhooks/whatsapp', { config: { public: true }, schema: { hide: true } }, async (req, reply) => {
    const end = waWebhookDuration.startTimer();
    const { raw, json } = req.body;
    const sig = req.headers['x-hub-signature-256'];
    const expected = `sha256=${hmacSha256Hex(env.WA_APP_SECRET, raw)}`;
    if (typeof sig !== 'string' || !safeEqual(sig, expected)) {
      waSignatureFailures.inc();
      end();
      throw new AppError('unauthenticated', 'invalid signature');
    }
    const { messages, statuses } = extractMessages(json);
    const multi = redisCore.multi();
    for (const m of messages) multi.set(keys.dedupeWa(m.id), '1', 'EX', 691_200, 'NX');
    const res = (messages.length ? await multi.exec() : []) ?? [];
    const contacts = new Map();
    for (const e of json.entry ?? [])
      for (const c of e.changes ?? []) for (const ct of c.value?.contacts ?? []) contacts.set(ct.wa_id, ct.profile?.name);
    for (const [i, m] of messages.entries()) {
      if (res[i]?.[1] !== 'OK') continue; // duplicate delivery
      // 🔒 job data is encrypted: it contains the sender's phone number and message text.
      const payload = encryptJson('jobs', { message: m, waId: m.from, profileName: contacts.get(m.from) ?? null }).ciphertext.toString(
        'base64',
      );
      await enqueue('wa-inbound', 'inbound', { enc: payload, messageId: m.id }, { jobId: m.id });
      waInbound.inc();
    }
    for (const s of statuses)
      await enqueue(
        'wa-status',
        'status',
        { providerMessageId: s.id, status: s.status, errors: s.errors ?? [], recipient: s.recipient_id ?? null },
        { jobId: `${s.id}:${s.status}` },
      );
    end();
    return reply.code(200).send({ ok: true });
  });
}
