/**
 * 🔒 Clinical safety regression suite (§16): multilingual red-flag scenarios that MUST end in 'emergency'.
 * CI-blocking: run on every change to rules, prompts or models.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { emergencyPrescreen, evaluate, ruleSetSchema } from '../../src/modules/triage/engine.js';

const rules = ruleSetSchema.parse(JSON.parse(readFileSync(new URL('../../db/seeds/data/rules.json', import.meta.url), 'utf8')).rules);

const redFlagFacts = [
  ['chest pain over 30', { age_years: 52, symptoms: ['SYM_CHEST_PAIN'] }],
  ['breathless at rest', { symptoms: ['SYM_COUGH'], breathless_at_rest: true }],
  ['unconscious', { symptoms: ['SYM_FEVER'], unconscious_or_confused: true }],
  ['seizure now', { symptoms: ['SYM_HIGH_FEVER'], seizure_now: true }],
  ['heavy bleeding', { symptoms: ['SYM_CUT_WOUND'], heavy_bleeding: true }],
  ['stroke signs', { symptoms: ['SYM_HEADACHE'], weakness_one_side: true }],
  ['worst headache', { symptoms: ['SYM_HEADACHE'], headache_sudden_severe: true }],
  ['infant under 3 months with fever', { age_years: 0, symptoms: ['SYM_FEVER'], baby_age_months: 1 }],
  ['child fast breathing', { age_years: 2, symptoms: ['SYM_CHILD_COUGH'], child_fast_breathing: true }],
  ['pregnancy bleeding', { sex: 'female', age_years: 28, pregnant: true, symptoms: ['SYM_ANC_CHECKUP'], pregnancy_bleeding: true }],
  ['reduced fetal movement', { sex: 'female', age_years: 28, pregnant: true, symptoms: ['SYM_ANC_CHECKUP'], fetal_movement_reduced: true }],
  ['pre-eclampsia signs', { sex: 'female', age_years: 30, pregnant: true, symptoms: ['SYM_HEADACHE'], pregnancy_headache_swelling: true }],
  ['diabetic hypoglycaemia', { symptoms: ['SYM_DIZZINESS'], hypo_symptoms: true, chronic: ['diabetes'] }],
  ['dehydration', { symptoms: ['SYM_DIARRHOEA'], dehydration_signs: true }],
  ['snake bite', { symptoms: ['SYM_SNAKE_BITE'] }],
  ['poisoning', { symptoms: ['SYM_POISONING'] }],
  ['large burn', { symptoms: ['SYM_BURN'], burn_extent: 'large' }],
  ['head injury red flags', { symptoms: ['SYM_FALL_INJURY'], head_injury_red_flags: true }],
  ['airway compromise', { symptoms: ['SYM_SORE_THROAT'], cannot_swallow_saliva: true }],
  ['self-harm thoughts', { symptoms: ['SYM_DEPRESSION'], self_harm_thoughts: true }],
  ['anaphylaxis', { symptoms: ['SYM_RASH'], rash_spreading_fast: true }],
  ['no urine 12h', { symptoms: ['SYM_KIDNEY_PAIN'], no_urine_12h: true }],
];

const redFlagPhrases = [
  'seene mein dard ho raha hai aur pasina aa raha hai',
  'saans nahi aa rahi',
  'papa behosh ho gaye',
  'bachche ko daure pad rahe hain',
  'सीने में दर्द है',
  'सांस नहीं आ रही',
  'बेहोश हो गया',
  'बहुत खून बह रहा है',
  'છાતીમાં દુખાવો થાય છે',
  'શ્વાસ નથી આવતો',
  'બેભાન થઈ ગયા',
  'बेहोश हो गया',
  'chest pain since morning',
  "my mother can't breathe",
  'snake bite on the leg',
  'he is not responding',
  'heart attack jaisa lag raha hai',
];

describe('🔒 clinical safety: red flags must be emergency', () => {
  for (const [name, facts] of redFlagFacts) {
    it(`facts: ${name}`, () => {
      const ev = evaluate(rules, { age_years: 40, sex: 'male', symptoms: [], chronic: [], ...facts });
      expect(ev.level).toBe('emergency');
    });
  }
  for (const phrase of redFlagPhrases) {
    it(`phrase: ${phrase}`, () => {
      expect(emergencyPrescreen(rules, phrase).emergency).toBe(true);
    });
  }
  it('no self-care for under-5, 60+, pregnant or chronic patients even with trivial symptoms', () => {
    for (const f of [{ age_years: 3 }, { age_years: 70 }, { sex: 'female', pregnant: true }, { chronic: ['hypertension'] }]) {
      const ev = evaluate(rules, {
        age_years: 30,
        sex: 'male',
        symptoms: ['SYM_COLD'],
        duration_hours: 24,
        pregnant: false,
        pain_score: 1,
        chronic: [],
        ...f,
      });
      expect(ev.selfCareEligible).toBe(false);
      expect(ev.level).not.toBe('self_care');
    }
  });
});
