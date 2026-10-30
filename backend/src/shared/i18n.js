/**
 * 🔒 Patient-facing text only through render(templateCode, language, vars) (§17.7), reading message_templates.
 * Fallback order: (code, channel, lang) → (code, 'web', lang) → (code, channel, 'en') → (code, 'web', 'en').
 */
import { db } from '../infra/db.js';

import { logger } from '../infra/logger.js';

let cache = null;
let loadedAt = 0;
const TTL_MS = 60_000;

async function templates() {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  const rows = await db
    .selectFrom('message_templates')
    .select(['code', 'channel', 'language', 'body', 'variables', 'provider_template_name', 'is_medical'])
    .where('status', '=', 'active')
    .execute();
  const m = new Map();
  for (const r of rows) m.set(`${r.code}|${r.channel}|${r.language}`, r);
  cache = m;
  loadedAt = Date.now();
  return m;
}

export function invalidateTemplateCache() {
  cache = null;
}

export function interpolate(body, vars) {
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

export async function render(code, language, vars = {}, channel = 'whatsapp') {
  const t = await templates();
  const lang = language.split('-')[0] ?? 'en';
  const candidates = [`${code}|${channel}|${lang}`, `${code}|web|${lang}`, `${code}|${channel}|en`, `${code}|web|en`];
  for (const key of candidates) {
    const tpl = t.get(key);
    if (tpl) {
      return {
        code,
        language: tpl.language,
        text: interpolate(tpl.body, vars),
        providerTemplateName: tpl.provider_template_name,
        isMedical: tpl.is_medical,
        variables: tpl.variables,
      };
    }
  }
  logger.warn({ code, language, channel }, 'missing message template');
  return { code, language: lang, text: `[${code}]`, providerTemplateName: null, isMedical: false, variables: [] };
}

/** Pick a localised string from an i18n jsonb object ({"en": ..., "hi": ...}). */
export function pick(i18n, language, fallback = '') {
  if (!i18n) return fallback;
  const lang = language.split('-')[0] ?? 'en';
  return i18n[lang] ?? i18n['en'] ?? Object.values(i18n)[0] ?? fallback;
}

/** Detect script of free text: Devanagari → 'hi', Gujarati → 'gu', otherwise 'en' (Latin incl. Hinglish). */
export function detectLanguage(text) {
  if (/[઀-૿]/.test(text)) return 'gu';
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/[A-Za-z]/.test(text)) return 'en';
  return null;
}
