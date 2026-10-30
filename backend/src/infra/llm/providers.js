/**
 * LLM providers behind the gateway (§10). The gateway asks for one structured answer (a forced tool /
 * function call whose arguments must match a Zod schema); each provider turns that into its own protocol.
 *
 *   LLM_PROVIDER=anthropic  Claude through @anthropic-ai/sdk (ANTHROPIC_API_KEY, optional ANTHROPIC_BASE_URL)
 *   LLM_PROVIDER=openai     any OpenAI-compatible chat-completions API: Groq, OpenAI, Gemini's OpenAI endpoint,
 *                           vLLM, Ollama … (OPENAI_API_KEY, OPENAI_BASE_URL)
 *
 * Model ids stay configuration (LLM_MODEL_FAST / LLM_MODEL_SMART). Both providers return the same shape:
 *   { toolInput: object | undefined, usage: { inputTokens, outputTokens, cacheReadTokens } }
 * and throw on transport/provider errors (with `status` when the provider answered with an HTTP error).
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';

export const providerName = () => env.LLM_PROVIDER;

export function providerConfigured() {
  return env.LLM_PROVIDER === 'anthropic' ? !!env.ANTHROPIC_API_KEY : !!env.OPENAI_API_KEY;
}

export async function complete(request) {
  return env.LLM_PROVIDER === 'anthropic' ? completeAnthropic(request) : completeOpenAI(request);
}

/* ---------------- Anthropic ---------------- */

let anthropicClient;
function anthropic() {
  anthropicClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL, maxRetries: 0 });
  return anthropicClient;
}

async function completeAnthropic({ model, system, userText, toolName, toolDescription, inputSchema, maxTokens, timeoutMs }) {
  const res = await anthropic().messages.create(
    {
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: [{ name: toolName, description: toolDescription, input_schema: { type: 'object', ...inputSchema } }],
      tool_choice: { type: 'tool', name: toolName },
      messages: [{ role: 'user', content: userText }],
    },
    { timeout: timeoutMs },
  );
  const toolUse = res.content.find((c) => c.type === 'tool_use');
  return {
    toolInput: toolUse ? toolUse.input : undefined,
    usage: {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    },
  };
}

/* ---------------- OpenAI-compatible (Groq, OpenAI, Gemini, vLLM, Ollama …) ---------------- */

// Reasoning models spend completion tokens on thinking before the tool call, so the output cap gets a floor.
const REASONING_MODEL = /gpt-oss|qwen3|deepseek-r1|^o[1-4]\b/i;

async function completeOpenAI({ model, system, userText, toolName, toolDescription, inputSchema, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const reasoning = REASONING_MODEL.test(model);
  const body = {
    model,
    max_tokens: reasoning ? Math.max(maxTokens, 1024) : maxTokens,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ],
    tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: { type: 'object', ...inputSchema } } }],
    tool_choice: { type: 'function', function: { name: toolName } },
    ...(/gpt-oss/i.test(model) && env.OPENAI_REASONING_EFFORT ? { reasoning_effort: env.OPENAI_REASONING_EFFORT } : {}),
  };
  try {
    const res = await fetch(`${env.OPENAI_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`provider responded ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      // Groq answers 400 "tool_use_failed" when the model's tool call misses the schema: a model slip, retryable once.
      if (res.status === 400 && /tool_use_failed|tool call validation failed/i.test(text)) err.retryable = true;
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
      throw err;
    }
    const data = await res.json();
    const message = data.choices?.[0]?.message;
    const call = message?.tool_calls?.find((c) => c.function?.name === toolName) ?? message?.tool_calls?.[0];
    let toolInput;
    if (call?.function?.arguments) {
      try {
        toolInput = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
      } catch {
        toolInput = undefined;
      }
    } else if (typeof message?.content === 'string' && message.content.trim().startsWith('{')) {
      // some models answer with the JSON inline instead of a tool call
      try {
        toolInput = JSON.parse(message.content);
      } catch {
        toolInput = undefined;
      }
    }
    const u = data.usage ?? {};
    return {
      toolInput,
      usage: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`timeout after ${timeoutMs} ms`);
      e.name = 'APIConnectionTimeoutError';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
