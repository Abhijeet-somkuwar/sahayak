/**
 * WhatsApp Cloud API client (Graph API). Without WA_ACCESS_TOKEN it runs in simulation mode (dev/demo):
 * messages are logged (redacted) and get a synthetic id.
 */
import { env } from '../../config/env.js';
import { logger } from '../../infra/logger.js';
import { newId } from '../../shared/ids.js';

export class WaError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'WaError';
  }
  /** Permanent recipient-side failures (not on WhatsApp, blocked, invalid number). */
  get permanent() {
    return (
      [131026, 131047, 131051, 131052, 131053, 100].includes(this.code ?? -1) ||
      (this.status >= 400 && this.status < 500 && this.status !== 429)
    );
  }
}

// ≤ 10 rows

export const simulated = () => !env.WA_ACCESS_TOKEN || !env.WA_PHONE_NUMBER_ID;

async function post(payload) {
  if (simulated()) {
    logger.info({ type: payload['type'], simulated: true }, 'whatsapp send (simulated)');
    return { messageId: `wamid.sim.${newId()}` };
  }
  const res = await fetch(`https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new WaError(res.status, json.error?.code ?? null, json.error?.message ?? `whatsapp http ${res.status}`);
  return { messageId: json.messages?.[0]?.id ?? `wamid.${newId()}` };
}

const to = (e164) => e164.replace('+', '');

export const waClient = {
  sendText: (phone, text) => post({ to: to(phone), type: 'text', text: { body: text.slice(0, 4096), preview_url: false } }),

  sendButtons: (phone, body, buttons) =>
    post({
      to: to(phone),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })),
        },
      },
    }),

  sendList: (phone, body, buttonLabel, rows, sectionTitle = 'Options') =>
    post({
      to: to(phone),
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body.slice(0, 1024) },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: [
            {
              title: sectionTitle.slice(0, 24),
              rows: rows
                .slice(0, 10)
                .map((r) => ({ id: r.id.slice(0, 200), title: r.title.slice(0, 24), description: r.description?.slice(0, 72) })),
            },
          ],
        },
      },
    }),

  sendLocationRequest: (phone, body) =>
    post({
      to: to(phone),
      type: 'interactive',
      interactive: { type: 'location_request_message', body: { text: body.slice(0, 1024) }, action: { name: 'send_location' } },
    }),

  /** Meta-approved template, required outside the 24-hour window. Body parameters are positional. */
  sendTemplate: (phone, name, language, bodyParams, buttonUrlParam) =>
    post({
      to: to(phone),
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: [
          ...(bodyParams.length ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t })) }] : []),
          ...(buttonUrlParam
            ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: buttonUrlParam }] }]
            : []),
        ],
      },
    }),

  markRead: (messageId) => post({ status: 'read', message_id: messageId }).catch(() => undefined),

  async mediaUrl(mediaId) {
    if (simulated()) return { url: `simulated://${mediaId}`, mimeType: 'application/octet-stream', fileSize: 0 };
    const res = await fetch(`https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${mediaId}`, {
      headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new WaError(res.status, null, 'media lookup failed');
    const j = await res.json();
    return { url: j.url, mimeType: j.mime_type, fileSize: j.file_size };
  },

  /** Streams media (max 16 MB) into a Buffer; callers write it straight to object storage, never to local disk. */
  async downloadMedia(url, maxBytes = 16 * 1024 * 1024) {
    if (url.startsWith('simulated://')) return Buffer.alloc(0);
    const res = await fetch(url, { headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok || !res.body) throw new WaError(res.status, null, 'media download failed');
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new WaError(413, null, 'media exceeds 16 MB');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  },

  /** Template approval statuses for the business account (template-sync job). */
  async listTemplates(wabaId) {
    if (simulated()) return [];
    const res = await fetch(
      `https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${wabaId}/message_templates?fields=name,language,status&limit=200`,
      { headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}` } },
    );
    if (!res.ok) return [];
    const j = await res.json();
    return j.data ?? [];
  },
};
