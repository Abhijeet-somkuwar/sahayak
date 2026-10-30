import { describe, expect, it } from 'vitest';
import { parseAnswer, parseDuration, publicFacts } from '../../src/modules/intake/engine.js';
import { detectLanguage, interpolate } from '../../src/shared/i18n.js';
import { normalisePhone, normaliseAbha, nameSearchKey, maskPhone } from '../../src/shared/phone.js';
import { ageBand, ageYears, istDate, istDateTime, relativePhrase, roundTo5Minutes, isQuietHours } from '../../src/shared/time.js';
import { boundaryMonthsAgo, newId, uuid7Boundary, uuid7Time } from '../../src/shared/ids.js';
import { blindIndex, decryptText, encrypt, randomBase32 } from '../../src/infra/crypto.js';
import { validateNarrative } from '../../src/modules/prebrief/service.js';

describe('intake parsing', () => {
  it('parses durations in Hindi/Hinglish/English/Gujarati', () => {
    expect(parseDuration('pet mein jalan 3 din se')).toBe(72);
    expect(parseDuration('2 hafte se khansi')).toBe(336);
    expect(parseDuration('since 5 hours')).toBe(5);
    expect(parseDuration('2 महीने से')).toBe(1440);
    expect(parseDuration('4 દિવસ')).toBe(96);
    expect(parseDuration('no duration here')).toBeNull();
  });
  it('parses answers by type', () => {
    const yn = { code: 'Q', setsFact: 'f', answerType: 'yes_no' };
    expect(parseAnswer(yn, { kind: 'choice', id: 'q:Q:yes' })).toBe(true);
    expect(parseAnswer(yn, { kind: 'choice', id: 'q:OTHER:yes' })).toBeUndefined();
    expect(parseAnswer(yn, { kind: 'text', text: 'haan' })).toBe(true);
    expect(parseAnswer(yn, { kind: 'text', text: 'नहीं' })).toBe(false);
    expect(parseAnswer(yn, { kind: 'text', text: 'pata nahi' })).toBeNull();
    expect(parseAnswer({ code: 'Q', setsFact: 'f', answerType: 'number' }, { kind: 'text', text: '5 din' })).toBe(5);
    expect(parseAnswer({ code: 'Q', setsFact: 'f', answerType: 'duration' }, { kind: 'text', text: '3' })).toBe(72);
    expect(
      parseAnswer(
        { code: 'Q', setsFact: 'f', answerType: 'single_choice', options: [{ code: 'a', labels: { hi: 'हल्का' } }] },
        { kind: 'text', text: 'हल्का' },
      ),
    ).toBe('a');
  });
  it('publicFacts strips complaint text and reporting window', () => {
    expect(publicFacts({ a: 1, complaint_redacted: 'x', reporting_window_start: 'y' })).toEqual({ a: 1 });
  });
});

describe('i18n / phone / time helpers', () => {
  it('detects script and interpolates', () => {
    expect(detectLanguage('पेट में दर्द')).toBe('hi');
    expect(detectLanguage('પેટમાં દુખાવો')).toBe('gu');
    expect(detectLanguage('pet mein dard')).toBe('en');
    expect(detectLanguage('123')).toBeNull();
    expect(interpolate('Token {{token}} at {{ room }}', { token: 'MED-001', room: 'Room 1' })).toBe('Token MED-001 at Room 1');
  });
  it('normalises phones and ABHA', () => {
    expect(normalisePhone('98765 43210')).toBe('+919876543210');
    expect(normalisePhone('09876543210')).toBe('+919876543210');
    expect(normalisePhone('919876543210')).toBe('+919876543210');
    expect(() => normalisePhone('12345')).toThrow();
    expect(normaliseAbha('12-3456-7890-1234')).toBe('12345678901234');
    expect(nameSearchKey('Rámesh  Patél!')).toBe('ramesh patel');
    expect(maskPhone('+919876543210')).toBe('+91******3210');
  });
  it('IST business dates and age bands', () => {
    expect(istDate(new Date('2026-10-06T20:00:00Z'))).toBe('2026-10-07'); // 01:30 IST next day
    expect(istDateTime('2026-10-07', '09:00').toISOString()).toBe('2026-10-07T03:30:00.000Z');
    expect(ageBand(47)).toBe('45-49');
    expect(ageBand(2)).toBe('0-4');
    expect(ageBand(90)).toBe('85+');
    expect(ageYears(null, 1980, new Date('2026-10-06T12:00:00Z'))).toBe(46);
    expect(relativePhrase(new Date(Date.now() - 150 * 86_400_000))).toBe('5 months ago');
    expect(roundTo5Minutes(1800 * 0.8)).toBe(25);
    expect(isQuietHours(new Date('2026-10-06T17:00:00Z'))).toBe(true); // 22:30 IST
    expect(isQuietHours(new Date('2026-10-06T05:00:00Z'))).toBe(false); // 10:30 IST
  });
});

describe('ids & crypto', () => {
  it('UUIDv7 ids are time-ordered and boundaries match the SQL function layout', () => {
    const a = newId();
    const b = newId();
    expect(a < b || a === b).toBe(true);
    expect(uuid7Boundary(new Date('2026-10-01T00:00:00Z'))).toBe('01a0f4c2-c400-0000-0000-000000000000');
    expect(uuid7Boundary(new Date('2026-11-01T00:00:00Z'))).toBe('01a19467-e800-0000-0000-000000000000');
    expect(Math.abs(uuid7Time(a).getTime() - Date.now())).toBeLessThan(5000);
    expect(boundaryMonthsAgo(24) < a).toBe(true);
  });
  it('envelope encryption round-trips and blind indexes are deterministic', () => {
    const { ciphertext, keyVersion } = encrypt('pii', '+919876543210');
    expect(keyVersion).toBe(1);
    expect(ciphertext.readUInt8(0)).toBe(1);
    expect(ciphertext.readUInt16BE(1)).toBe(1);
    expect(decryptText('pii', ciphertext)).toBe('+919876543210');
    expect(blindIndex('phone', '+919876543210').equals(blindIndex('phone', '+919876543210'))).toBe(true);
    expect(blindIndex('phone', '+919876543210').equals(blindIndex('abha_number', '+919876543210'))).toBe(false);
    expect(randomBase32(10)).toMatch(/^[a-z2-7]{10}$/);
  });
});

describe('🔒 pre-brief narrative validator (§9.6 rule 3)', () => {
  const ctx = {
    patient: { age_band: '45-49', sex: 'male' },
    today: {
      complaint_codes: ['SYM_ABD_BURN'],
      complaint_labels: ['Burning in stomach'],
      duration_hours: 72,
      triage_level: 'routine',
      red_flags: [],
      vitals: [],
    },
    allergies: [{ ref: 'allergy:0', substance: 'Penicillin', reaction: 'rash', severity: 'moderate' }],
    active_medications: [{ ref: 'rx:0', drug: 'Metformin 500 mg', dose: '1 tab', frequency: 'BD' }],
    chronic_conditions: [{ ref: 'cond:0', text: 'Type 2 diabetes' }],
    risk_flags: ['diabetes'],
    recent_visits: [
      {
        ref: 'enc:1',
        when: '5 months ago',
        where: 'this hospital',
        department: 'Medicine',
        triage_level: 'routine',
        diagnoses: ['Gastritis'],
        prescriptions: ['Pantoprazole 40 mg OD'],
      },
    ],
  };
  it('drops points with unknown refs, fabricated drugs/allergens, and caps counts', () => {
    const out = validateNarrative(
      {
        headline: '45-49M, burning; on metformin',
        key_points: [
          { text: 'Known diabetic on metformin.', source_refs: ['rx:0'] },
          { text: 'Allergic to sulfa drugs.', source_refs: ['allergy:0'] }, // sulfa not in context → dropped
          { text: 'Was on amoxicillin last visit.', source_refs: ['enc:1'] }, // fabricated drug → dropped
          { text: 'Invented reference.', source_refs: ['enc:999'] }, // bad ref → dropped
          { text: 'Same complaint 5 months ago, gastritis.', source_refs: ['enc:1'] },
          { text: 'p6', source_refs: ['enc:1'] },
          { text: 'p7', source_refs: ['enc:1'] },
          { text: 'p8', source_refs: ['enc:1'] },
          { text: 'p9', source_refs: ['enc:1'] },
        ],
        questions_to_consider: ['Black stools?', 'Any aspirin use?', 'q3', 'q4'],
      },
      ctx,
    );
    expect(out.key_points.map((p) => p.text)).toEqual([
      'Known diabetic on metformin.',
      'Same complaint 5 months ago, gastritis.',
      'p6',
      'p7',
      'p8',
    ]);
    expect(out.questions_to_consider).toEqual(['Black stools?', 'q3', 'q4']); // aspirin not in context → dropped; cap 3
    expect(out.headline).toContain('metformin');
  });
});

describe('pre-brief v2 validation', () => {
  const ctx = {
    patient: { age_band: '55-59', sex: 'female' },
    today: { ref: 'today', complaint_codes: ['SYM_HEADACHE'], complaint_labels: ['Headache'], duration_hours: null, triage_level: 'routine', red_flags: [], vitals: [] },
    allergies: [],
    active_medications: [{ ref: 'rx:0', drug: 'Paracetamol 500 mg', dose: '1 tablet', frequency: 'OD' }],
    chronic_conditions: [],
    risk_flags: [],
    recent_visits: [
      { ref: 'enc:1', when: '3 days ago', where: 'this hospital', department: 'Medicine OPD', triage_level: 'routine', complaint: ['fever'], diagnoses: ['Viral fever'], prescriptions: ['Paracetamol 500 mg 1 tablet TDS × 3d'] },
    ],
  };
  it('keeps the history summary and considerations, drops fabricated drugs, accepts the "today" ref', () => {
    const out = validateNarrative(
      {
        headline: '55-59F, headache today; viral fever 3 days ago',
        history_summary: 'Seen 3 days ago for fever, diagnosed viral fever, given paracetamol 500 mg.',
        key_points: [
          { text: 'Headache follows a febrile illness.', source_refs: ['today', 'enc:1'] },
          { text: 'Uncited point.', source_refs: [] },
        ],
        considerations: [
          { condition: 'Post-viral headache', reasoning: 'Recent viral fever.', source_refs: ['enc:1', 'enc:999'] },
          { condition: 'Sinusitis', reasoning: 'Consider if facial pain; treat with amoxicillin.', source_refs: [] }, // drug not in context
          { condition: 'Migraine', reasoning: 'Primary headache.' },
          { condition: 'Tension headache', reasoning: 'Common.' },
        ],
        questions_to_consider: ['Fever now?'],
      },
      ctx,
    );
    expect(out.history_summary).toContain('3 days ago');
    expect(out.key_points.map((p) => p.text)).toEqual(['Headache follows a febrile illness.']);
    expect(out.considerations.map((c) => c.condition)).toEqual(['Post-viral headache', 'Migraine', 'Tension headache']);
    expect(out.considerations[0].source_refs).toEqual(['enc:1']);
  });
  it('blanks the history summary when there is no history', () => {
    const out = validateNarrative({ headline: 'h', history_summary: 'Invented past visit.' }, { ...ctx, recent_visits: [] });
    expect(out.history_summary).toBe('');
    expect(out.key_points).toEqual([]);
    expect(out.considerations).toEqual([]);
  });
});
