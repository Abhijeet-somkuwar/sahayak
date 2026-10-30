/**
 * Daily LLM token budget per facility (§10.6): llm:budget:<facilityId>:<yyyymmdd>, 48 h TTL.
 */
import { env } from '../../config/env.js';
import { redisCore, keys } from '../redis.js';
import { istDate } from '../../shared/time.js';

function key(facilityId) {
  return keys.llmBudget(facilityId, istDate().replace(/-/g, ''));
}

export async function budgetExceeded(facilityId) {
  if (!facilityId) return false;
  try {
    const used = Number((await redisCore.get(key(facilityId))) ?? 0);
    return used >= env.LLM_DAILY_TOKEN_BUDGET_PER_FACILITY;
  } catch {
    return false;
  }
}

export async function consumeBudget(facilityId, tokens) {
  if (!facilityId || tokens <= 0) return;
  try {
    const k = key(facilityId);
    await redisCore
      .multi()
      .incrby(k, tokens)
      .expire(k, 48 * 3600)
      .exec();
  } catch {
    /* best-effort */
  }
}
