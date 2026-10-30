/**
 * IST helpers (§6.1, §17.3). Business dates are always computed in Asia/Kolkata, never from the server TZ.
 */
export const IST = 'Asia/Kolkata';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' in IST. */
export function istDate(at = new Date()) {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/** Hour of day (0-23) in IST. */
export function istHour(at = new Date()) {
  return new Date(at.getTime() + IST_OFFSET_MS).getUTCHours();
}

/** Minutes since midnight in IST. */
export function istMinutes(at = new Date()) {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** ISO weekday 1 = Monday ... 7 = Sunday, in IST. */
export function istIsoWeekday(at = new Date()) {
  const d = new Date(at.getTime() + IST_OFFSET_MS).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Convert an IST date ('YYYY-MM-DD') and time ('HH:MM' or 'HH:MM:SS') to an instant. */
export function istDateTime(date, time) {
  const [h, m, s] = time.split(':').map((x) => parseInt(x, 10));
  const [y, mo, d] = date.split('-').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, mo - 1, d, h ?? 0, m ?? 0, s ?? 0) - IST_OFFSET_MS);
}

/** 'YYYY-MM-DD' of the day after the given IST date. */
export function addDays(date, days) {
  const [y, mo, d] = date.split('-').map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

export function isQuietHours(at = new Date()) {
  const h = istHour(at);
  return h >= 21 || h < 7; // 21:00–07:00 IST (§9.10)
}

/** Age in whole years from a birth date or birth year, as of today (IST). */
export function ageYears(birthDate, birthYear, now = new Date()) {
  const today = istDate(now);
  const [ty, tm, td] = today.split('-').map((x) => parseInt(x, 10));
  if (birthDate) {
    const bd = typeof birthDate === 'string' ? birthDate : birthDate.toISOString().slice(0, 10);
    const [by, bm, bdd] = bd.split('-').map((x) => parseInt(x, 10));
    let age = ty - by;
    if (tm < bm || (tm === bm && td < bdd)) age -= 1;
    return Math.max(0, age);
  }
  if (birthYear) return Math.max(0, ty - birthYear);
  return 0;
}

/** 5-year age band used in de-identified contexts: '45-49', '0-4', '85+'. */
export function ageBand(age) {
  if (age >= 85) return '85+';
  const lo = Math.floor(age / 5) * 5;
  return `${lo}-${lo + 4}`;
}

/** Relative phrase for de-identified contexts: 'today', '3 days ago', '5 months ago', '2 years ago'. */
export function relativePhrase(at, now = new Date()) {
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** Round seconds to the nearest 5 minutes, in minutes. */
export function roundTo5Minutes(seconds) {
  return Math.max(0, Math.round(seconds / 300) * 5);
}
