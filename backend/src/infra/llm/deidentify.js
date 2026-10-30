const PHONE = /(?:(?<!\d)\+?91[\s-]?[6-9]\d{9}(?!\d))|(?:(?<!\d)[6-9]\d{9}(?!\d))/g;
const PHONE_SPACED = /(?:(?<!\d)\+?91[\s-]?[6-9]\d{4}[\s-]\d{5}(?!\d))|(?:(?<!\d)[6-9]\d{4}[\s-]\d{5}(?!\d))/g;
const LONG_ID = /(?<!\d)(?:\d[\s-]?){11}\d(?!\d)|(?<!\d)(?:\d[\s-]?){13}\d(?!\d)/g; // 12 or 14 digits, optionally grouped
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PIN = /(?<![\d-])[1-9]\d{5}(?![\d-])/g;
const ABHA_ADDRESS = /\b[a-z0-9._]+@(?:abdm|sbx)\b/gi;
const ADDRESS_LINE =
  /\b(?:house|h\.?\s?no|plot|flat|gali|street|st\.|road|rd\.|marg|nagar|colony|society|chawl|chowk|village|gaon|taluka|tehsil|pin\s?code)\b[^.,\n]{0,60}/gi;
const NAME_INTRO =
  /\b(?:my name is|mera naam|naam hai|i am|main|mera nam|name:)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}|[ऀ-ॿ]+(?:\s+[ऀ-ॿ]+){0,2}|[઀-૿]+(?:\s+[઀-૿]+){0,2})/g;
const HONORIFIC_NAME = /\b(?:Dr\.?|Shri|Smt\.?|Mr\.?|Mrs\.?|Ms\.?|Shree|Sri|Kumari)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deidentifyText(text, ctx = {}) {
  let out = text;
  out = out.replace(EMAIL, '[EMAIL]').replace(ABHA_ADDRESS, '[ABHA]');
  out = out.replace(PHONE_SPACED, '[PHONE]').replace(PHONE, '[PHONE]');
  out = out.replace(LONG_ID, '[ID]');
  out = out.replace(ADDRESS_LINE, '[ADDRESS]');
  out = out.replace(PIN, '[PIN]');
  out = out.replace(NAME_INTRO, (m, name) => m.replace(name, '[NAME]'));
  out = out.replace(HONORIFIC_NAME, '[NAME]');
  for (const n of ctx.knownNames ?? []) {
    for (const part of n.split(/\s+/)) {
      if (part.length >= 3) out = out.replace(new RegExp(`\\b${escapeRe(part)}\\b`, 'gi'), '[NAME]');
    }
  }
  // Other facilities → type + district, applied last so the replacement text is not scrubbed again.
  for (const f of ctx.otherFacilityNames ?? []) {
    if (f.name.length >= 3) out = out.replace(new RegExp(escapeRe(f.name), 'gi'), f.replacement);
  }
  return out;
}

function walk(value, ctx) {
  if (typeof value === 'string') return deidentifyText(value, ctx);
  if (Array.isArray(value)) return value.map((v) => walk(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, ctx);
    return out;
  }
  return value;
}

/** Scrubs every string in `value` (recursively) and brands the result as safe for the LLM gateway. */
export function deidentify(value, ctx = {}) {
  return { __deidentified: true, value: walk(value, ctx) };
}

/** For data that is already structural and identifier-free by construction (e.g. retrieved KB chunks). Still scrubbed. */
export const asDeidentified = deidentify;
