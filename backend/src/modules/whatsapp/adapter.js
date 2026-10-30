import { waClient } from './client.js';
import { putObject, storageKeys } from '../../infra/storage.js';

export function extractMessages(body) {
  const messages = [];
  const statuses = [];
  for (const e of body.entry ?? [])
    for (const c of e.changes ?? []) {
      messages.push(...(c.value?.messages ?? []));
      statuses.push(...(c.value?.statuses ?? []));
    }
  return { messages, statuses };
}

/** Streams media from the Graph API to object storage (max 16 MB); returns the storage key. */
export async function toInboundEvent(m, conversationId) {
  switch (m.type) {
    case 'text':
      return m.text?.body ? { kind: 'text', text: m.text.body } : null;
    case 'interactive': {
      const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
      return r ? { kind: 'choice', id: r.id, title: r.title } : null;
    }
    case 'button':
      return m.button?.payload ? { kind: 'choice', id: m.button.payload, title: m.button.text } : null;
    case 'location':
      return m.location ? { kind: 'location', latitude: m.location.latitude, longitude: m.location.longitude } : null;
    case 'audio':
    case 'image':
    case 'document': {
      const media = m.audio ?? m.image ?? m.document;
      if (!media) return null;
      const info = await waClient.mediaUrl(media.id);
      const buf = await waClient.downloadMedia(info.url);
      const ext = (media.mime_type.split(';')[0]?.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '');
      const key = storageKeys.media(conversationId, m.id, ext);
      if (buf.length) await putObject(key, buf, media.mime_type);
      return m.type === 'audio'
        ? { kind: 'audio', storageKey: key, mimeType: media.mime_type }
        : m.type === 'image'
          ? { kind: 'image', storageKey: key, mimeType: media.mime_type }
          : { kind: 'document', storageKey: key, mimeType: media.mime_type };
    }
    default:
      return null;
  }
}

/** Interactive limits: ≤ 3 buttons (titles ≤ 20 chars), lists ≤ 10 rows. */
export async function sendOutbound(phone, msg, buttonLabel) {
  if (msg.buttons?.length) return { ...(await waClient.sendButtons(phone, msg.text, msg.buttons.slice(0, 3))), contentType: 'interactive' };
  if (msg.list?.rows.length)
    return {
      ...(await waClient.sendList(phone, msg.text, msg.list.button || buttonLabel, msg.list.rows.slice(0, 10), msg.list.sectionTitle)),
      contentType: 'interactive',
    };
  if (msg.requestLocation) return { ...(await waClient.sendLocationRequest(phone, msg.text)), contentType: 'interactive' };
  return { ...(await waClient.sendText(phone, msg.link ? `${msg.text}\n${msg.link}` : msg.text)), contentType: 'text' };
}
