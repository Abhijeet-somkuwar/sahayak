/**
 * Circuit breaker per provider+model, state shared in Redis cb:<provider> (§10.6):
 * opens at ≥ 50% failures over the last 20 calls within 30 s; half-opens after 30 s.
 */
import { redisCore, keys } from '../redis.js';

const WINDOW_MS = 30_000;
const SAMPLE = 20;
const MIN_CALLS = 10;

export async function circuitState(provider) {
  try {
    const openedAt = await redisCore.hget(keys.cb(provider), 'opened_at');
    if (!openedAt) return 'closed';
    return Date.now() - Number(openedAt) >= WINDOW_MS ? 'half_open' : 'open';
  } catch {
    return 'closed';
  }
}

export async function recordOutcome(provider, ok) {
  try {
    const listKey = `${keys.cb(provider)}:log`;
    const now = Date.now();
    const multi = redisCore.multi();
    multi.lpush(listKey, `${now}:${ok ? 1 : 0}`);
    multi.ltrim(listKey, 0, SAMPLE - 1);
    multi.expire(listKey, 600);
    multi.lrange(listKey, 0, SAMPLE - 1);
    const res = await multi.exec();
    const entries = res?.[3]?.[1] ?? [];
    const recent = entries.map((e) => e.split(':')).filter(([ts]) => now - Number(ts) <= WINDOW_MS);
    if (ok) {
      const state = await circuitState(provider);
      if (state === 'half_open') await redisCore.del(keys.cb(provider)); // trial call succeeded → close
      return;
    }
    if (recent.length >= MIN_CALLS) {
      const fails = recent.filter(([, r]) => r === '0').length;
      if (fails / recent.length >= 0.5) {
        await redisCore.hset(keys.cb(provider), 'opened_at', String(now));
        await redisCore.expire(keys.cb(provider), 600);
      }
    }
  } catch {
    /* breaker is best-effort */
  }
}
