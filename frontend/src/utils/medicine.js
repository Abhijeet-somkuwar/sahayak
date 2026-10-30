// Plain-language medicine lines for patients: "1 tablet, three times a day, for 3 days, by mouth".
// Frequencies and routes are the codes the doctor's form uses (utils/validation.js FREQUENCIES / ROUTES).
const FREQ = ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS', 'STAT'];
const ROUTE = ['oral', 'topical', 'inhaled', 'iv', 'im', 'sc'];

/** { name, how, instructions } for one prescription item ({ drug, strength, dose, frequency, days, route, instructions }). */
export function medicineParts(p, t, lng = 'en') {
  const code = String(p.frequency || '').toUpperCase();
  const freq = FREQ.includes(code) ? t(`rx.freq.${code}`) : p.frequency;
  const route = ROUTE.includes(p.route) ? t(`rx.route.${p.route}`) : null;
  const days = p.days ? t('rx.forDays', { count: Number(p.days) }) : null;
  const ins = p.instructions && typeof p.instructions === 'object' ? p.instructions[lng] || p.instructions.en || Object.values(p.instructions)[0] || '' : '';
  return {
    name: [p.drug, p.strength].filter(Boolean).join(' '),
    how: [p.dose, freq, days, route].filter(Boolean).join(', '),
    instructions: ins,
  };
}

/** Doctor-facing short form: "Paracetamol 500 mg · 1 tablet · TDS · 3 d · oral". */
export const medicineShort = (p) => [[p.drug, p.strength].filter(Boolean).join(' '), p.dose, p.frequency, p.days ? `${p.days} d` : null, p.route].filter(Boolean).join(' · ');
