/**
 * redis-cache wrapper (§8.1). Keys declared `phi: true` are encrypted with the 'cache' data key
 * before being written, transparently.
 */
import { redisCache } from './redis.js';
import { decryptJson, encryptJson } from './crypto.js';
import { logger } from './logger.js';

export async function cacheGet(key, opts = {}) {
  try {
    if (opts.phi) {
      const buf = await redisCache.getBuffer(key);
      return buf ? decryptJson('cache', buf) : null;
    }
    const raw = await redisCache.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn({ err, key: key.split(':').slice(0, 2).join(':') }, 'cache get failed; reading through');
    return null;
  }
}

export async function cacheSet(key, value, opts) {
  try {
    if (opts.phi) {
      await redisCache.set(key, encryptJson('cache', value).ciphertext, 'EX', opts.ttlSeconds);
    } else {
      await redisCache.set(key, JSON.stringify(value), 'EX', opts.ttlSeconds);
    }
  } catch (err) {
    logger.warn({ err }, 'cache set failed; continuing without cache');
  }
}

export async function cacheDel(...keys) {
  if (keys.length === 0) return;
  try {
    await redisCache.del(...keys);
  } catch {
    /* losing the cache only costs latency */
  }
}

export async function cacheGetOrSet(key, opts, loader) {
  const hit = await cacheGet(key, opts);
  if (hit !== null) return hit;
  const value = await loader();
  if (value !== null && value !== undefined) await cacheSet(key, value, opts);
  return value;
}
