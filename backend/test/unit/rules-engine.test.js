import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  combineLevels,
  emergencyPrescreen,
  evalCondition,
  evaluate,
  isLessUrgent,
  moreUrgent,
  ruleSetChecksum,
  ruleSetSchema,
  runTestCases,
  testCaseSchema,
} from '../../src/modules/triage/engine.js';

const demo = JSON.parse(readFileSync(new URL('../../db/seeds/data/rules.json', import.meta.url), 'utf8'));
const rules = ruleSetSchema.parse(demo.rules);
const base = (f) => ({ age_years: 30, sex: 'male', symptoms: [], chronic: [], ...f });

describe('triage rules engine (§9.4)', () => {
  it('runs the demo rule set test cases (clinician-authored cases must all pass)', () => {
    const r = runTestCases(rules, z.array(testCaseSchema).parse(demo.test_cases));
    expect(r.results.filter((x) => !x.passed)).toEqual([]);
    expect(r.passed).toBe(true);
  });
  it('level is the most urgent among fired rules', () => {
    const ev = evaluate(rules, base({ symptoms: ['SYM_FEVER'], fever_days: 6, chest_pain: true, age_years: 45 }));
    expect(ev.level).toBe('emergency');
    expect(ev.firedRules).toContain('PR-FEVER-5D');
    expect(ev.firedRules).toContain('EM-CHEST-PAIN-30');
  });
  it('🔒 unknown facts never lower urgency and are reported as missing when satisfiable', () => {
    const ev = evaluate(rules, base({ symptoms: ['SYM_COUGH'] }));
    expect(ev.level).toBe('routine');
    expect(ev.missingFacts).toContain('breathless_at_rest');
    expect(ev.missingFacts).toContain('chest_pain');
  });
  it('a definitively false sibling condition means nothing is asked for that rule', () => {
    // EM-CHEST-PAIN-30 needs age >= 30; for a 20-year-old chest_pain is still asked via EM-CHEST-PAIN-YOUNG (age < 30 is true)
    const ev = evaluate(rules, base({ age_years: 20, symptoms: ['SYM_ABD_BURN'] }));
    expect(ev.missingFacts).toContain('chest_pain');
    // EM-INFANT-FEVER requires symptom FEVER: with only SYM_BACK_PAIN the baby_age_months fact must NOT be asked
    const ev2 = evaluate(rules, base({ symptoms: ['SYM_BACK_PAIN'] }));
    expect(ev2.missingFacts).not.toContain('baby_age_months');
  });
  it('emergency short-circuits missing facts', () => {
    const ev = evaluate(rules, base({ symptoms: ['SYM_CHEST_PAIN'] }));
    expect(ev.level).toBe('emergency');
    expect(ev.missingFacts).toEqual([]);
  });
  it('self-care requires every exclusion to be known-false and required facts known', () => {
    expect(evaluate(rules, base({ symptoms: ['SYM_COLD'], duration_hours: 24, pregnant: false, pain_score: 1 })).selfCareEligible).toBe(
      true,
    );
    expect(evaluate(rules, base({ symptoms: ['SYM_COLD'], duration_hours: 24, pain_score: 1 })).selfCareEligible).toBe(false); // pregnant unknown → not safe
    expect(evaluate(rules, base({ symptoms: ['SYM_COLD'], duration_hours: 100, pregnant: false, pain_score: 1 })).selfCareEligible).toBe(
      false,
    ); // > 72h
    expect(
      evaluate(rules, base({ symptoms: ['SYM_COLD', 'SYM_FEVER'], duration_hours: 24, pregnant: false, pain_score: 1 })).selfCareEligible,
    ).toBe(false); // fever not allowed
  });
  it('routing rules pick the first match', () => {
    expect(evaluate(rules, base({ sex: 'female', pregnant: true, symptoms: ['SYM_HEADACHE'] })).specialty).toBe('obgyn');
    expect(evaluate(rules, base({ age_years: 5, symptoms: ['SYM_COUGH'] })).specialty).toBe('paediatrics');
    expect(evaluate(rules, base({ symptoms: ['SYM_COUGH'] })).specialty).toBeNull();
  });
  it('operators and combinators', () => {
    const f = { a: 5, list: ['x', 'y'], s: 'q' };
    expect(evalCondition(f, { fact: 'a', op: '>=', value: 5 }).v).toBe(true);
    expect(evalCondition(f, { fact: 'a', op: '<', value: 5 }).v).toBe(false);
    expect(evalCondition(f, { fact: 'list', op: 'contains', value: 'x' }).v).toBe(true);
    expect(evalCondition(f, { fact: 'list', op: 'contains_any', value: ['z', 'y'] }).v).toBe(true);
    expect(evalCondition(f, { fact: 's', op: 'in', value: ['q', 'r'] }).v).toBe(true);
    expect(evalCondition(f, { fact: 'missing', op: 'exists' }).v).toBe(false);
    expect(evalCondition(f, { fact: 'list', op: 'not_empty' }).v).toBe(true);
    expect(evalCondition(f, { not: { fact: 'a', op: '==', value: 5 } }).v).toBe(false);
    expect(
      evalCondition(f, {
        any: [
          { fact: 'a', op: '==', value: 1 },
          { fact: 'missing', op: '==', value: true },
        ],
      }).v,
    ).toBe('unknown');
    expect(
      evalCondition(f, {
        all: [
          { fact: 'a', op: '==', value: 5 },
          { fact: 'missing', op: '==', value: true },
        ],
      }).v,
    ).toBe('unknown');
    expect(
      evalCondition(f, {
        all: [
          { fact: 'a', op: '==', value: 1 },
          { fact: 'missing', op: '==', value: true },
        ],
      }).v,
    ).toBe(false);
  });
  it('🔒 combineLevels returns the more urgent of rules and LLM', () => {
    expect(combineLevels('routine', 'priority')).toBe('priority');
    expect(combineLevels('emergency', 'routine')).toBe('emergency');
    expect(combineLevels('priority', null)).toBe('priority');
    expect(moreUrgent('self_care', 'routine')).toBe('routine');
    expect(isLessUrgent('routine', 'priority')).toBe(true);
  });
  it('emergency pre-screen matches multilingual phrases and self-harm', () => {
    expect(emergencyPrescreen(rules, 'Mujhe seene mein dard ho raha hai').emergency).toBe(true);
    expect(emergencyPrescreen(rules, 'सीने में दर्द और सांस नहीं आ रही').emergency).toBe(true);
    expect(emergencyPrescreen(rules, 'છાતીમાં દુખાવો છે').emergency).toBe(true);
    expect(emergencyPrescreen(rules, 'pet mein jalan hai 3 din se').emergency).toBe(false);
    expect(emergencyPrescreen(rules, 'mujhe jeena nahi hai, aatmahatya karna chahta hoon').selfHarm).toBe(true);
    expect(emergencyPrescreen(rules, 'bukhar hai').selfHarm).toBe(false);
  });
  it('checksum is canonical (key order independent)', () => {
    expect(ruleSetChecksum({ a: 1, b: [1, 2] }).equals(ruleSetChecksum({ b: [1, 2], a: 1 }))).toBe(true);
    expect(ruleSetChecksum({ a: 1 }).equals(ruleSetChecksum({ a: 2 }))).toBe(false);
  });
});
