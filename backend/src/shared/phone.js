/**
 * Normalisation before hashing (§9.2): phone → E.164 (+91XXXXXXXXXX); ABHA number → 14 digits.
 */
import { AppError } from './errors.js';

export function normalisePhone(raw) {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits.slice(1))) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) return `+${digits}`;
  if (hasPlus && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  throw AppError.validation('invalid phone number');
}

export function normaliseAbha(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 14) throw AppError.validation('ABHA number must have 14 digits');
  return digits;
}

export function normaliseAbhaAddress(raw) {
  const v = raw.trim().toLowerCase();
  if (!/^[a-z0-9._]+@(abdm|sbx)$/.test(v)) throw AppError.validation('invalid ABHA address');
  return v;
}

/** Lower-case Latin transliteration for fuzzy search; keeps Latin as-is, strips diacritics and punctuation. */
export function nameSearchKey(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ઀-૿ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Masked display for staff screens: +91******1234. */
export function maskPhone(e164) {
  return e164.length > 4 ? `${e164.slice(0, 3)}******${e164.slice(-4)}` : '****';
}
