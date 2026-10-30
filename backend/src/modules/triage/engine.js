/**
 * 🔒 Triage rules engine (§9.4): a pure function with no I/O.
 * evaluate(ruleSet, facts) → { level, firedRules, missingFacts, specialty, selfCareEligible }.
 * Unknown facts never make the outcome less urgent: a comparison with a missing fact is UNKNOWN (never true),
 * and the fact is reported as missing when the rule's other conditions are satisfiable.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TRIAGE_ORDER = ['emergency', 'priority', 'routine', 'self_care']; // most → least urgent
export function moreUrgent(a, b) {
  return TRIAGE_ORDER.indexOf(a) <= TRIAGE_ORDER.indexOf(b) ? a : b;
}
export function isLessUrgent(a, b) {
  return TRIAGE_ORDER.indexOf(a) > TRIAGE_ORDER.indexOf(b);
}

export const factsSchema = z
  .object({
    age_years: z.number().min(0).max(130),
    sex: z.enum(['female', 'male', 'other', 'unknown']),
    symptoms: z.array(z.string()).default([]),
    duration_hours: z.number().nonnegative().optional(),
    fever_days: z.number().nonnegative().optional(),
    pain_score: z.number().min(0).max(10).optional(),
    breathless_at_rest: z.boolean().optional(),
    chest_pain: z.boolean().optional(),
    unconscious_or_confused: z.boolean().optional(),
    seizure_now: z.boolean().optional(),
    heavy_bleeding: z.boolean().optional(),
    pregnant: z.boolean().optional(),
    pregnancy_weeks: z.number().nonnegative().optional(),
    injury_mechanism: z.enum(['fall', 'road_traffic', 'assault', 'burn', 'bite', 'other']).optional(),
    chronic: z.array(z.string()).default([]),
    disability: z.boolean().optional(),
  })
  .passthrough(); // clinician-authored rule sets may introduce new facts collected by new questions

const OPERATORS = ['==', '!=', '<', '<=', '>', '>=', 'contains', 'contains_any', 'in', 'exists', 'not_empty'];

const conditionSchema = z.lazy(() =>
  z.union([
    z.object({ fact: z.string(), op: z.enum(OPERATORS), value: z.unknown().optional() }).strict(),
    z.object({ all: z.array(conditionSchema).min(1) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1) }).strict(),
    z.object({ not: conditionSchema }).strict(),
  ]),
);

export const levelSchema = z.enum(['emergency', 'priority', 'routine', 'self_care']);

export const ruleSetSchema = z.object({
  emergency_phrases: z.record(z.string(), z.array(z.string())).default({}),
  self_harm_phrases: z.record(z.string(), z.array(z.string())).default({}),
  rules: z.array(z.object({ id: z.string().min(1), level: levelSchema, when: conditionSchema, description: z.string().optional() })),
  self_care: z
    .object({
      allowed_symptoms: z.array(z.string()),
      max_duration_hours: z.number().positive(),
      exclude_if_any: z.array(conditionSchema).default([]),
      required_facts: z.array(z.string()).default([]),
    })
    .optional(),
  routing: z.array(z.object({ when: conditionSchema, specialty: z.string() })).default([]),
  default_level: levelSchema.default('routine'),
});

export const testCaseSchema = z.object({
  name: z.string(),
  facts: factsSchema,
  expect: z.object({
    level: levelSchema.optional(),
    specialty: z.string().optional(),
    fired: z.array(z.string()).optional(),
    self_care_eligible: z.boolean().optional(),
  }),
});

const T = { v: true };
const F = { v: false };

function cmp(facts, c) {
  const has = Object.prototype.hasOwnProperty.call(facts, c.fact) && facts[c.fact] !== undefined && facts[c.fact] !== null;
  const val = facts[c.fact];
  if (c.op === 'exists') return has ? T : F;
  if (!has) return { v: 'unknown', missing: [c.fact] };
  switch (c.op) {
    case '==':
      return val === c.value ? T : F;
    case '!=':
      return val !== c.value ? T : F;
    case '<':
      return typeof val === 'number' && typeof c.value === 'number' && val < c.value ? T : F;
    case '<=':
      return typeof val === 'number' && typeof c.value === 'number' && val <= c.value ? T : F;
    case '>':
      return typeof val === 'number' && typeof c.value === 'number' && val > c.value ? T : F;
    case '>=':
      return typeof val === 'number' && typeof c.value === 'number' && val >= c.value ? T : F;
    case 'contains':
      return Array.isArray(val) && val.includes(c.value) ? T : F;
    case 'contains_any':
      return Array.isArray(val) && Array.isArray(c.value) && c.value.some((x) => val.includes(x)) ? T : F;
    case 'in':
      return Array.isArray(c.value) && c.value.includes(val) ? T : F;
    case 'not_empty':
      return Array.isArray(val) ? (val.length > 0 ? T : F) : val !== '' ? T : F;
    default:
      return F;
  }
}

export function evalCondition(facts, cond) {
  if ('all' in cond) {
    let missing = [];
    for (const c of cond.all) {
      const r = evalCondition(facts, c);
      if (r.v === false) return F; // definitively false → not satisfiable, nothing to ask
      if (r.v === 'unknown') missing = missing.concat(r.missing);
    }
    return missing.length ? { v: 'unknown', missing } : T;
  }
  if ('any' in cond) {
    let missing = [];
    for (const c of cond.any) {
      const r = evalCondition(facts, c);
      if (r.v === true) return T;
      if (r.v === 'unknown') missing = missing.concat(r.missing);
    }
    return missing.length ? { v: 'unknown', missing } : F;
  }
  if ('not' in cond) {
    const r = evalCondition(facts, cond.not);
    return r.v === 'unknown' ? r : r.v ? F : T;
  }
  return cmp(facts, cond);
}

export function evaluate(ruleSet, rawFacts) {
  const facts = rawFacts;
  const fired = [];
  const missing = new Set();
  let level = null;
  for (const rule of ruleSet.rules) {
    const r = evalCondition(facts, rule.when);
    if (r.v === true) {
      fired.push(rule.id);
      level = level ? moreUrgent(level, rule.level) : rule.level;
    } else if (r.v === 'unknown') r.missing.forEach((m) => missing.add(m));
  }

  let selfCareEligible = false;
  if (!level) {
    const sc = ruleSet.self_care;
    if (sc) {
      const symptoms = facts['symptoms'] ?? [];
      const allAllowed = symptoms.length > 0 && symptoms.every((s) => sc.allowed_symptoms.includes(s));
      const requiredKnown = sc.required_facts.every((f) => facts[f] !== undefined && facts[f] !== null);
      if (allAllowed && !requiredKnown)
        sc.required_facts.filter((f) => facts[f] === undefined || facts[f] === null).forEach((f) => missing.add(f));
      const duration = facts['duration_hours'];
      const durationOk = typeof duration === 'number' && duration <= sc.max_duration_hours;
      // exclusions: every exclusion must be definitively false; UNKNOWN is not safe
      let excluded = false;
      for (const ex of sc.exclude_if_any) {
        const r = evalCondition(facts, ex);
        if (r.v !== false) {
          excluded = true;
          if (r.v === 'unknown' && allAllowed) r.missing.forEach((m) => missing.add(m));
        }
      }
      selfCareEligible = allAllowed && requiredKnown && durationOk && !excluded;
    }
    level = selfCareEligible ? 'self_care' : ruleSet.default_level;
  }

  let specialty = null;
  for (const r of ruleSet.routing) {
    if (evalCondition(facts, r.when).v === true) {
      specialty = r.specialty;
      break;
    }
  }
  // An emergency needs no more questions.
  const missingFacts = level === 'emergency' ? [] : [...missing].sort();
  return { level, firedRules: fired, missingFacts, specialty, selfCareEligible };
}

/** Combine rules with the LLM: the more urgent of the two (§9.4). The DB CHECK constraint enforces the same invariant. */
export function combineLevels(ruleLevel, llmLevel) {
  return llmLevel ? moreUrgent(ruleLevel, llmLevel) : ruleLevel;
}

// ---- Emergency pre-screen (§9.3) ----
export function normaliseText(text) {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[।॥.,!?;:()\-_/\\"']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 🔒 Built-in self-harm phrases (multilingual). Clinician-maintained phrases in the rule set extend this list. */
export const BUILTIN_SELF_HARM_PHRASES = [
  'suicide',
  'kill myself',
  'end my life',
  'want to die',
  'self harm',
  'hurt myself',
  'marna chahta',
  'marna chahti',
  'jaan dena',
  'jaan de dun',
  'khudkushi',
  'aatmahatya',
  'आत्महत्या',
  'खुदकुशी',
  'मरना चाहता',
  'मरना चाहती',
  'जान देना',
  'આત્મહત્યા',
  'મરવું છે',
  'જીવ આપી દેવો',
];

export function emergencyPrescreen(ruleSet, text) {
  const norm = ` ${normaliseText(text)} `;
  const matched = [];
  for (const phrases of Object.values(ruleSet.emergency_phrases)) {
    for (const p of phrases) {
      const np = normaliseText(p);
      if ((np && norm.includes(` ${np} `)) || (np.length >= 4 && norm.includes(np))) matched.push(p);
    }
  }
  const selfHarmPhrases = [...BUILTIN_SELF_HARM_PHRASES, ...Object.values(ruleSet.self_harm_phrases).flat()];
  const selfHarm = selfHarmPhrases.some((p) => {
    const np = normaliseText(p);
    return np && norm.includes(np);
  });
  return { emergency: matched.length > 0, selfHarm, matched };
}

// ---- Test runner (§9.4 publishing) ----

export function runTestCases(ruleSet, cases) {
  const results = cases.map((tc) => {
    const actual = evaluate(ruleSet, tc.facts);
    const reasons = [];
    if (tc.expect.level && actual.level !== tc.expect.level) reasons.push(`level ${actual.level} != ${tc.expect.level}`);
    if (tc.expect.specialty && actual.specialty !== tc.expect.specialty)
      reasons.push(`specialty ${actual.specialty} != ${tc.expect.specialty}`);
    if (tc.expect.fired && !tc.expect.fired.every((f) => actual.firedRules.includes(f)))
      reasons.push(`fired ${actual.firedRules.join(',')} lacks ${tc.expect.fired.join(',')}`);
    if (tc.expect.self_care_eligible !== undefined && actual.selfCareEligible !== tc.expect.self_care_eligible)
      reasons.push(`self_care_eligible ${actual.selfCareEligible}`);
    return { name: tc.name, passed: reasons.length === 0, actual, expected: tc.expect, reasons };
  });
  return { passed: results.every((r) => r.passed), results };
}

/** sha256 of the canonical JSON (sorted keys) of the rules. */
export function ruleSetChecksum(rules) {
  const canon = (v) =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon(v[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canon(rules)))
    .digest();
}
