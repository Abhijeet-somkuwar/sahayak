/**
 * SMS fallback for critical messages using DLT-registered templates (§9.9, §20 open decision 8).
 */
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

class LogSms {
  async send(_to, dltTemplateId) {
    logger.info({ dltTemplateId }, 'SMS (log provider): message would be sent');
    return { ok: true, providerMessageId: `log-${Date.now()}` };
  }
}

class HttpSms {
  async send(toE164, dltTemplateId, text) {
    try {
      const res = await fetch(env.SMS_API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SMS_API_KEY}` },
        body: JSON.stringify({ to: toE164, template_id: dltTemplateId, text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const json = await res.json().catch(() => ({}));
      return { ok: true, providerMessageId: json.id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

export function sms() {
  return env.SMS_PROVIDER === 'http' && env.SMS_API_URL ? new HttpSms() : new LogSms();
}
