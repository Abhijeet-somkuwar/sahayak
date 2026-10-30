const localeFor = (lng) => (lng === 'hi' ? 'hi-IN' : lng === 'gu' ? 'gu-IN' : 'en-IN');

export const formatTime = (iso, lng = 'en') => new Intl.DateTimeFormat(localeFor(lng), { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

// ETA is always shown as a range, never one time.
export const formatRange = (range, lng = 'en') => `${formatTime(range[0], lng)} – ${formatTime(range[1], lng)}`;

export const tokenCode = (prefix, number) => `${prefix}-${String(number || 0).padStart(3, '0')}`;

export const secondsSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000)) : 0);

// A visit date (YYYY-MM-DD, IST) as "7 Oct 2026" in the reader's language.
export const formatDate = (isoDate, lng = 'en') => (isoDate ? new Intl.DateTimeFormat(localeFor(lng), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${String(isoDate).slice(0, 10)}T12:00:00`)) : '');

// Whole days between a visit date and today.
export const daysAgo = (isoDate) => (isoDate ? Math.max(0, Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(String(isoDate).slice(0, 10))) / 86_400_000)) : 0);
