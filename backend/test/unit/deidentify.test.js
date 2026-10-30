import { describe, expect, it } from 'vitest';
import { deidentify, deidentifyText } from '../../src/infra/llm/deidentify.js';

describe('🔒 deidentify (§10.4)', () => {
  it('removes Indian mobile numbers in all common formats', () => {
    for (const s of ['call 9876543210', '+91 98765 43210', '+919876543210', '0 98765-43210 nahi', 'mera number 91 9876543210 hai']) {
      const out = deidentifyText(s);
      expect(out).not.toMatch(/\d{10}/);
      expect(out).toContain('[PHONE]');
    }
  });
  it('removes 12/14-digit identifiers (Aadhaar / ABHA-like) and ABHA addresses', () => {
    expect(deidentifyText('aadhaar 1234 5678 9012')).toContain('[ID]');
    expect(deidentifyText('abha 12345678901234')).toContain('[ID]');
    expect(deidentifyText('ramesh.p@abdm')).toContain('[ABHA]');
    expect(deidentifyText('abha 12345678901234')).not.toMatch(/\d{14}/);
  });
  it('removes emails, PIN codes and addresses', () => {
    const out = deidentifyText('mail ramesh@example.com, pin 382001, House No 12 Shanti Nagar near bus stand');
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[PIN]');
    expect(out).toContain('[ADDRESS]');
    expect(out).not.toContain('382001');
    expect(out).not.toContain('Shanti Nagar');
  });
  it('keeps clinical durations (not PIN codes)', () => {
    expect(deidentifyText('3 din se bukhar, 102 degree')).toBe('3 din se bukhar, 102 degree');
  });
  it('removes known household names and honorific names', () => {
    const out = deidentifyText('Ramesh Patel ko bukhar hai, Dr. Mehta ne dekha, my name is Sunita', {
      knownNames: ['Ramesh Patel', 'Sunita Patel'],
    });
    expect(out).not.toContain('Ramesh');
    expect(out).not.toContain('Sunita');
    expect(out).not.toContain('Mehta');
  });
  it('replaces other facility names and brands nested structures', () => {
    const out = deidentify(
      { note: 'treated at Civil Hospital Ahmedabad', phone: '9876543210', nested: { list: ['9876543210'] } },
      { otherFacilityNames: [{ name: 'Civil Hospital Ahmedabad', replacement: 'district hospital, district 474' }] },
    );
    expect(out.__deidentified).toBe(true);
    expect(out.value.note).toContain('district hospital');
    expect(out.value.phone).toBe('[PHONE]');
    expect(out.value.nested.list[0]).toBe('[PHONE]');
  });
  it('fuzz: random Indian phone / ABHA / PIN patterns never survive', () => {
    for (let i = 0; i < 500; i++) {
      const phone = `${[6, 7, 8, 9][i % 4]}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
      const abha = String(Math.floor(Math.random() * 1e14)).padStart(14, '0');
      const pin = `${1 + (i % 9)}${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;
      const out = deidentifyText(`patient ${phone} abha ${abha} pin ${pin} fever`);
      expect(out).not.toContain(phone);
      expect(out).not.toContain(abha);
      expect(out).not.toContain(pin);
    }
  });
});
