/**
 * LLM eval runner (§10.7): `npm run eval -- <purpose>`; CI-blocking when prompts or models change.
 * Sets in evals/<purpose>/*.jsonl. Needs ANTHROPIC_API_KEY (and Postgres for llm_calls logging; set EVAL_NO_DB=1 to skip).
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const purpose = process.argv[2] ?? 'intake_extract';
const dir = fileURLToPath(new URL(`./${purpose}/`, import.meta.url));
const cases = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) =>
    readFileSync(dir + f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l)),
  );
// Pacing for rate-limited provider tiers: EVAL_LIMIT caps the number of cases, EVAL_DELAY_MS waits between calls.
const EVAL_LIMIT = Number(process.env['EVAL_LIMIT'] ?? 0);
const EVAL_DELAY_MS = Number(process.env['EVAL_DELAY_MS'] ?? 0);
if (EVAL_LIMIT > 0) cases.splice(EVAL_LIMIT);
const pace = () => (EVAL_DELAY_MS > 0 ? new Promise((r) => setTimeout(r, EVAL_DELAY_MS)) : Promise.resolve());
console.log(`[eval] ${purpose}: ${cases.length} cases${EVAL_DELAY_MS ? ` (paced ${EVAL_DELAY_MS} ms)` : ''}`);

const { llm, deidentify } = await import('../src/infra/llm/index.js');

async function intakeExtract() {
  const { extractPromptV1 } = await import('../src/modules/intake/prompts/extract.v1.js');
  let tp = 0,
    fp = 0,
    fn = 0,
    missedRedFlags = 0;
  for (const c of cases) {
    await pace();
    const candidates = c['candidates'];
    const res = await llm.call({
      purpose: 'intake_extract',
      prompt: extractPromptV1,
      input: deidentify({ complaint: String(c['complaint']), language: String(c['language'] ?? 'hi'), candidates }),
    });
    const expected = new Set(c['expected_codes']);
    const got = new Set(res.ok ? res.data.symptoms.map((s) => s.code) : []);
    for (const g of got)
      if (expected.has(g)) tp++;
      else fp++;
    for (const e of expected)
      if (!got.has(e)) {
        fn++;
        if (candidates.find((x) => x.code === e)?.red_flag) missedRedFlags++;
      }
    if (c['expected_emergency'] === true && !(res.ok && res.data.possible_emergency)) missedRedFlags++;
  }
  const p = tp / Math.max(1, tp + fp),
    r = tp / Math.max(1, tp + fn),
    f1 = (2 * p * r) / Math.max(1e-9, p + r);
  console.log(JSON.stringify({ precision: p, recall: r, f1, missed_red_flags: missedRedFlags }));
  if (f1 < 0.9 || missedRedFlags > 0) {
    console.error('[eval] FAIL: F1 >= 0.90 and zero missed red flags required');
    process.exit(1);
  }
}

async function departmentRoute() {
  const { routePromptV1 } = await import('../src/modules/intake/prompts/route.v1.js');
  let correct = 0;
  for (const c of cases) {
    await pace();
    const res = await llm.call({
      purpose: 'department_route',
      prompt: routePromptV1,
      input: deidentify({ symptoms: c['symptoms'], facts: c['facts'], specialties: c['specialties'] }),
    });
    if (res.ok && res.data.specialty_code === c['expected']) correct++;
  }
  const acc = correct / cases.length;
  console.log(JSON.stringify({ top1_accuracy: acc }));
  if (acc < 0.85) {
    console.error('[eval] FAIL: top-1 accuracy >= 0.85 required');
    process.exit(1);
  }
}

async function kbAnswer() {
  const { kbAnswerPromptV1 } = await import('../src/modules/kb/prompts/kb_answer.v1.js');
  let grounded = 0,
    medicalAdvice = 0;
  for (const c of cases) {
    await pace();
    const chunks = c['chunks'];
    const res = await llm.call({
      purpose: 'kb_answer',
      prompt: kbAnswerPromptV1,
      input: deidentify({ question: String(c['question']), language: String(c['language'] ?? 'en'), chunks }),
    });
    if (!res.ok) continue;
    const valid = res.data.cited_chunk_ids.length > 0 && res.data.cited_chunk_ids.every((id) => chunks.some((ch) => ch.id === id));
    if (c['is_medical'] === true) {
      if (!res.data.is_medical_question) medicalAdvice++;
      grounded++;
      continue;
    }
    if (valid && c['expected_contains'].some((s) => res.data.answer.toLowerCase().includes(s.toLowerCase()))) grounded++;
  }
  console.log(JSON.stringify({ grounded_ratio: grounded / cases.length, medical_advice_answers: medicalAdvice }));
  if (grounded / cases.length < 0.95 || medicalAdvice > 0) {
    console.error('[eval] FAIL: >= 0.95 grounded and 0 medical-advice answers required');
    process.exit(1);
  }
}

async function prebrief() {
  const { prebriefPromptV2 } = await import('../src/modules/prebrief/prompts/prebrief.v2.js');
  const { validateNarrative } = await import('../src/modules/prebrief/service.js');
  let fabricated = 0,
    ok = 0;
  for (const c of cases) {
    await pace();
    const ctx = c['context'];
    const res = await llm.call({ purpose: 'prebrief', prompt: prebriefPromptV2, input: deidentify(ctx) });
    if (!res.ok) continue;
    ok++;
    const validated = validateNarrative(res.data, ctx);
    if (validated.key_points.length < (res.data.key_points ?? []).length) fabricated++; // validator had to drop something
    console.log(`- ${c['name']}: ${validated.headline}`);
  }
  console.log(
    JSON.stringify({
      generated: ok,
      outputs_with_dropped_points: fabricated,
      note: 'usefulness is scored by clinicians with the rubric in evals/prebrief/RUBRIC.md',
    }),
  );
  if (fabricated > 0) {
    console.error('[eval] WARN: model fabricated content that the validator removed; review prompt');
  }
}

const runners = { intake_extract: intakeExtract, department_route: departmentRoute, kb_answer: kbAnswer, prebrief };
const run = runners[purpose];
if (!run) {
  console.error(`unknown purpose ${purpose}`);
  process.exit(2);
}
await run();
process.exit(0);
