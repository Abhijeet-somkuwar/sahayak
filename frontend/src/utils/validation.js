// Form validation rules from FRONTEND_DESIGN.md §8. Each validator returns an i18n key or null.
// `rule(validator, t)` turns one into an Ant Design Form rule.

export const digits = (s) => String(s || '').replace(/[\s-]/g, '');
export const normalizeIndianMobile = (s) => digits(s).replace(/^(\+91|91|0)(?=\d{10}$)/, '');

export const validatePhone = (v) => (/^[6-9]\d{9}$/.test(normalizeIndianMobile(v)) ? null : 'v.phone.invalid');
export const validateOptionalPhone = (v) => (!v || !String(v).trim() ? null : validatePhone(v));
export const validateOtp = (v) => (/^\d{6}$/.test(String(v || '')) ? null : 'v.otp.invalid');
export const validateAbha = (v) => (/^\d{14}$/.test(digits(v)) ? null : 'v.abha.invalid');
export const validatePincode = (v) => (/^[1-9]\d{5}$/.test(String(v || '')) ? null : 'v.pincode.invalid');

export function validateName(v) {
  const s = String(v || '').trim();
  if (s.length < 2) return 'v.name.short';
  if (s.length > 80) return 'v.name.long';
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(s)) return 'v.name.chars';
  return null;
}

export function validateAge(v) {
  const n = Number(v);
  if (v === '' || v == null || !Number.isInteger(n) || n < 0 || n > 120) return 'v.age.range';
  return null;
}

export function validateBirthYear(v) {
  const n = Number(v);
  const y = new Date().getFullYear();
  if (v === '' || v == null || !Number.isInteger(n) || n < y - 120 || n > y) return 'v.year.range';
  return null;
}

export const validateAgeOrYear = (value) => (value.kind === 'year' ? validateBirthYear(value.value) : validateAge(value.value));
export const validateRequired = (key) => (v) => (v == null || String(v).trim() === '' ? key : null);
export const validateMinLength = (min, key) => (v) => (String(v || '').trim().length < min ? key : null);
export const validateMaxLength = (max, key) => (v) => (String(v || '').trim().length > max ? key : null);

export const validateDiagnosis = (v) => validateMinLength(3, 'v.diagnosis.short')(v) || validateMaxLength(500, 'v.diagnosis.long')(v);
export const validateReason = (v) => validateMinLength(10, 'v.reason.short')(v) || validateMaxLength(500, 'v.reason.long')(v);
export const validateDurationDays = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? null : 'v.duration.range';
};

export const FREQUENCIES = ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'STAT'];
export const ROUTES = ['oral', 'topical', 'inhaled', 'iv', 'im', 'sc', 'other'];
export const RELATIONSHIPS = ['self', 'parent', 'child', 'spouse', 'sibling', 'other_family', 'caregiver', 'asha_worker'];

// Vitals: hard limits are errors, soft limits (configured by clinicians) are warnings.
const VITAL_LIMITS = {
  bpSystolic: [50, 260],
  bpDiastolic: [30, 160],
  pulse: [20, 250],
  tempC: [30, 45],
  spo2: [50, 100],
  weightKg: [0.5, 300],
  rbsMgDl: [20, 600],
};
export function validateVitals(v) {
  const errors = {};
  for (const [key, [min, max]] of Object.entries(VITAL_LIMITS)) {
    if (v[key] === '' || v[key] == null) continue;
    const n = Number(v[key]);
    if (Number.isNaN(n) || n < min || n > max) errors[key] = 'v.vital.range';
  }
  if (!errors.bpSystolic && !errors.bpDiastolic && v.bpSystolic && v.bpDiastolic && Number(v.bpSystolic) <= Number(v.bpDiastolic)) errors.bpDiastolic = 'v.bp.order';
  return errors;
}
export function vitalsWarnings(v, thresholds) {
  const w = {};
  if (v.spo2 !== '' && v.spo2 != null && Number(v.spo2) < thresholds.spo2Low) w.spo2 = 'w.spo2.low';
  if (v.bpSystolic !== '' && v.bpSystolic != null && Number(v.bpSystolic) >= thresholds.sbpHigh) w.bpSystolic = 'w.bp.high';
  if (v.tempC !== '' && v.tempC != null && Number(v.tempC) >= thresholds.tempHigh) w.tempC = 'w.temp.high';
  return w;
}

// Counter search: what did the clerk type? (§4.4)
export function detectSearchKind(raw) {
  const d = digits(raw);
  if (!String(raw || '').trim()) return 'empty';
  if (/^\d+$/.test(d)) return d.length === 14 ? 'abha' : 'phone';
  return 'name';
}

/** Ant Design Form rule from a validator. `t` translates the key. */
export const rule = (validator, t) => ({
  validator: (_, value) => {
    const key = validator(value);
    return key ? Promise.reject(new Error(t(key))) : Promise.resolve();
  },
});
