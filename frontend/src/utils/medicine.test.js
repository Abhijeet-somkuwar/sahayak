import { describe, expect, it } from 'vitest';
import { medicineParts, medicineShort } from './medicine';

const t = (key, vars) => (key === 'rx.forDays' ? `for ${vars.count} days` : { 'rx.freq.TDS': 'three times a day', 'rx.route.oral': 'by mouth' }[key] || key);

describe('medicine lines', () => {
  it('turns doctor codes into plain words for the patient', () => {
    const p = { drug: 'Paracetamol 500 mg', dose: '1 tablet', frequency: 'TDS', days: 3, route: 'oral', instructions: { en: 'After food', hi: 'खाने के बाद' } };
    expect(medicineParts(p, t, 'hi')).toEqual({ name: 'Paracetamol 500 mg', how: '1 tablet, three times a day, for 3 days, by mouth', instructions: 'खाने के बाद' });
  });
  it('keeps unknown frequencies as written and skips missing parts', () => {
    expect(medicineParts({ drug: 'ORS', dose: '1 sachet', frequency: 'after each loose stool' }, t).how).toBe('1 sachet, after each loose stool');
  });
  it('has a short form for doctors', () => {
    expect(medicineShort({ drug: 'Paracetamol', strength: '500 mg', dose: '1 tab', frequency: 'TDS', days: 3, route: 'oral' })).toBe('Paracetamol 500 mg · 1 tab · TDS · 3 d · oral');
  });
});
