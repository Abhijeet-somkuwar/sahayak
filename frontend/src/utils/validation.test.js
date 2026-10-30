import { describe, expect, it } from 'vitest';
import { normalizeIndianMobile, validatePhone, validateAbha, validateName, validateAgeOrYear, validateVitals, vitalsWarnings, detectSearchKind, validateOptionalPhone } from './validation';

describe('phone', () => {
  it('normalises +91, 91, 0, spaces and dashes', () => {
    expect(normalizeIndianMobile('+91 98765-43210')).toBe('9876543210');
    expect(normalizeIndianMobile('09876543210')).toBe('9876543210');
  });
  it('rejects bad numbers with the right key', () => {
    expect(validatePhone('1234567890')).toBe('v.phone.invalid');
    expect(validatePhone('98765')).toBe('v.phone.invalid');
    expect(validatePhone('9876543210')).toBeNull();
    expect(validateOptionalPhone('')).toBeNull();
  });
});

describe('abha and name', () => {
  it('accepts 14 digits with separators', () => expect(validateAbha('12-3456-7890-1234')).toBeNull());
  it('accepts Devanagari and Gujarati names', () => {
    expect(validateName('रमेश पटेल')).toBeNull();
    expect(validateName('રમેશ પટેલ')).toBeNull();
  });
  it('emits the right keys', () => {
    expect(validateName('R')).toBe('v.name.short');
    expect(validateName('R@mesh')).toBe('v.name.chars');
  });
});

describe('age or year', () => {
  it('validates both kinds', () => {
    expect(validateAgeOrYear({ kind: 'age', value: '45' })).toBeNull();
    expect(validateAgeOrYear({ kind: 'age', value: '130' })).toBe('v.age.range');
    expect(validateAgeOrYear({ kind: 'year', value: String(new Date().getFullYear() - 45) })).toBeNull();
  });
});

describe('vitals', () => {
  it('blocks impossible values and bp order', () => {
    expect(validateVitals({ spo2: '20' }).spo2).toBe('v.vital.range');
    expect(validateVitals({ bpSystolic: '90', bpDiastolic: '100' }).bpDiastolic).toBe('v.bp.order');
  });
  it('warns on clinically unusual values', () => {
    expect(vitalsWarnings({ spo2: '86', bpSystolic: '170' }, { spo2Low: 92, sbpHigh: 160, tempHigh: 38.5 })).toEqual({ spo2: 'w.spo2.low', bpSystolic: 'w.bp.high' });
  });
});

describe('detectSearchKind', () => {
  it('detects phone, abha, name', () => {
    expect(detectSearchKind('98765 43210')).toBe('phone');
    expect(detectSearchKind('12-3456-7890-1234')).toBe('abha');
    expect(detectSearchKind('Ramesh')).toBe('name');
    expect(detectSearchKind(' ')).toBe('empty');
  });
});
