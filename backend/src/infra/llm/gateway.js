/**
 * LLM gateway (§10). Structured output via a single forced tool whose input schema is generated from Zod.
 * The provider (Anthropic, or any OpenAI-compatible API such as Groq) is chosen by LLM_PROVIDER; see providers.js.
 * Never throws for provider failures; callers MUST handle { ok: false }.
 */
import { z } from 'zod';
import { db } from '../db.js';
import { toJson } from '../db.types.js';
import { sha256 } from '../crypto.js';
import { logger } from '../logger.js';
import { llmCallDuration, llmFallbacks, llmTokens } from '../metrics.js';
import { newId } from '../../shared/ids.js';
import { ROUTES, modelFor, providerAllowed } from './routing.js';
import { circuitState, recordOutcome } from './circuit.js';
import { budgetExceeded, consumeBudget } from './budget.js';
import { promptVersion } from './types.js';
import { complete, providerConfigured, providerName } from './providers.js';

const PROVIDER = providerName();

/** Simple in-process semaphore per purpose so a pre-brief backlog cannot starve interactive calls (§10.6). */
class Semaphore {
  active = 0;
  waiters = [];
  constructor(limit) {
    this.limit = limit;
  }
  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active++;
    return () => this.release();
  }
  release() {
    this.active--;
    this.waiters.shift()?.();
  }
}
const semaphores = new Map();
function semaphore(purpose, limit) {
  let s = semaphores.get(purpose);
  if (!s) {
    s = new Semaphore(limit);
    semaphores.set(purpose, s);
  }
  return s;
}

async function logCall(id, a) {
  try {
    await db
      .insertInto('llm_calls')
      .values({
        id,
        purpose: a.purpose,
        provider: PROVIDER,
        model: a.model,
        prompt_version: a.promptVersion,
        facility_id: a.facilityId ?? null,
        encounter_id: a.encounterId ?? null,
        input_tokens: a.inputTokens ?? null,
        output_tokens: a.outputTokens ?? null,
        cache_read_tokens: a.cacheReadTokens ?? null,
        latency_ms: a.latencyMs,
        outcome: a.outcome,
        error_code: a.errorCode ?? null,
        request_digest: a.requestDigest,
        response_redacted: a.response === undefined ? null : toJson(a.response),
      })
      .execute();
  } catch (err) {
    logger.warn({ err }, 'could not write llm_calls row');
  }
  llmCallDuration.observe({ purpose: a.purpose, model: a.model, outcome: a.outcome }, a.latencyMs / 1000);
  if (a.outcome !== 'ok') llmFallbacks.inc({ purpose: a.purpose, reason: a.outcome });
}

export async function call(req) {
  const route = ROUTES[req.purpose];
  const model = modelFor(route.tier);
  const pv = promptVersion(req.prompt);
  const callId = newId();
  const userText = req.prompt.build(req.input.value);
  const requestDigest = sha256(JSON.stringify({ pv, model, userText }));
  const started = Date.now();
  const fail = async (reason, errorCode) => {
    await logCall(callId, {
      purpose: req.purpose,
      model,
      promptVersion: pv,
      facilityId: req.facilityId,
      encounterId: req.encounterId,
      latencyMs: Date.now() - started,
      outcome: reason,
      errorCode,
      requestDigest,
    });
    return { ok: false, reason, callId };
  };

  if (!providerAllowed(req.purpose)) return fail('blocked_by_guardrail', 'residency_policy');
  if (!providerConfigured()) return fail('provider_error', 'no_api_key');
  const state = await circuitState(PROVIDER);
  if (state === 'open') return fail('circuit_open');
  if (await budgetExceeded(req.facilityId)) return fail('budget_exceeded');

  const inputSchema = z.toJSONSchema(req.prompt.schema, { target: 'draft-7', io: 'input' });
  delete inputSchema['$schema'];
  const release = await semaphore(req.purpose, route.concurrency).acquire();
  try {
    let attempt = 0;
    let lastReason = 'provider_error';
    let lastError;
    while (attempt <= route.retries) {
      attempt++;
      try {
        const { toolInput, usage } = await complete({
          model,
          system: req.prompt.system,
          userText,
          toolName: req.prompt.toolName,
          toolDescription: req.prompt.toolDescription,
          inputSchema,
          maxTokens: route.maxOutputTokens,
          timeoutMs: route.timeoutMs,
        });
        llmTokens.inc({ purpose: req.purpose, model, kind: 'input' }, usage.inputTokens);
        llmTokens.inc({ purpose: req.purpose, model, kind: 'output' }, usage.outputTokens);
        await consumeBudget(req.facilityId, usage.inputTokens + usage.outputTokens);
        const parsed = toolInput !== undefined ? req.prompt.schema.safeParse(toolInput) : undefined;
        if (parsed?.success) {
          await recordOutcome(PROVIDER, true);
          await logCall(callId, {
            purpose: req.purpose,
            model,
            promptVersion: pv,
            facilityId: req.facilityId,
            encounterId: req.encounterId,
            ...usage,
            latencyMs: Date.now() - started,
            outcome: 'ok',
            requestDigest,
            response: parsed.data,
          });
          return { ok: true, data: parsed.data, callId };
        }
        lastReason = 'invalid_output';
        lastError =
          parsed && !parsed.success
            ? parsed.error.issues
                .map((i) => i.path.join('.'))
                .join(',')
                .slice(0, 200)
            : 'no_tool_use';
        await recordOutcome(PROVIDER, true); // the provider worked; the output was invalid
      } catch (err) {
        const e = err;
        const timeout = e.name === 'APIConnectionTimeoutError' || /timeout|aborted/i.test(e.message ?? '');
        if (!timeout) logger.warn({ provider: PROVIDER, model, status: e.status, msg: String(e.message ?? '').slice(0, 200) }, 'llm provider error');
        lastReason = timeout ? 'timeout' : 'provider_error';
        lastError = String(e.status ?? e.name ?? 'error').slice(0, 64);
        await recordOutcome(PROVIDER, false);
        if ((e.status === 400 && !e.retryable) || e.status === 401 || e.status === 403) break; // not retryable
        if (e.status === 429 && attempt <= route.retries) {
          // rate limited: honour retry-after (bounded) before the retry; free provider tiers hit this quickly
          lastReason = 'rate_limited';
          await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs ?? 1500, 8000)));
        }
      }
    }
    return fail(lastReason, lastError);
  } finally {
    release();
  }
}

export const llm = { call };
