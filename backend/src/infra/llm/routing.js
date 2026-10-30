/**
 * Routing table (§10.2). Model ids are configuration (LLM_MODEL_FAST / LLM_MODEL_SMART), not code.
 */
import { env } from '../../config/env.js';

export const ROUTES = {
  intake_extract: { tier: 'fast', timeoutMs: 4_000, maxOutputTokens: 400, retries: 1, concurrency: 16, needsPatientContext: true },
  question_select: { tier: 'fast', timeoutMs: 2_500, maxOutputTokens: 50, retries: 0, concurrency: 16, needsPatientContext: true },
  department_route: { tier: 'fast', timeoutMs: 2_500, maxOutputTokens: 100, retries: 0, concurrency: 16, needsPatientContext: true },
  kb_answer: { tier: 'fast', timeoutMs: 6_000, maxOutputTokens: 500, retries: 1, concurrency: 16, needsPatientContext: false },
  prebrief: { tier: 'smart', timeoutMs: 15_000, maxOutputTokens: 700, retries: 1, concurrency: 6, needsPatientContext: true },
  patient_doc_extract: {
    tier: 'smart',
    timeoutMs: 30_000,
    maxOutputTokens: 1_500,
    retries: 2,
    concurrency: 4,
    vision: true,
    needsPatientContext: true,
  },
  doctor_qa: { tier: 'smart', timeoutMs: 10_000, maxOutputTokens: 500, retries: 1, concurrency: 4, needsPatientContext: true },
};

export function modelFor(tier) {
  return tier === 'fast' ? env.LLM_MODEL_FAST : env.LLM_MODEL_SMART;
}

/**
 * Per-purpose provider configuration (§10.4): purposes that carry de-identified patient context may be
 * restricted to an in-country endpoint. Open decision 1 (§20): LLM_ALLOW_OFFSHORE_PATIENT_CONTEXT=false means
 * such purposes are only sent when ANTHROPIC_BASE_URL (in-country gateway) is configured.
 * Groq, OpenAI and Gemini are offshore: set LLM_ALLOW_OFFSHORE_PATIENT_CONTEXT=true to use them for intake,
 * pre-brief and document extraction (everything sent is de-identified first, see deidentify.js).
 */
export function providerAllowed(purpose) {
  const r = ROUTES[purpose];
  if (!r.needsPatientContext) return true;
  if (env.LLM_ALLOW_OFFSHORE_PATIENT_CONTEXT) return true;
  return !!env.ANTHROPIC_BASE_URL;
}
