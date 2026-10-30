/**
 * Two Redis deployments (D13, §8.1): redis-core (noeviction + AOF) and redis-cache (LRU).
 * Lua scripts from src/lua are registered as commands on redis-core.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

function script(name) {
  return readFileSync(fileURLToPath(new URL(`../lua/${name}`, import.meta.url)), 'utf8');
}

function makeClient(url, name) {
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
    connectionName: `${env.SERVICE_NAME}-${name}`,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  client.on('error', (err) => logger.warn({ err: err.message, redis: name }, 'redis error'));
  return client;
}

export const redisCore = makeClient(env.REDIS_CORE_URL, 'core');
export const redisCache = makeClient(env.REDIS_CACHE_URL, 'cache');

redisCore.defineCommand('applyTokenState', { numberOfKeys: 4, lua: script('apply_token_state.lua') });
redisCore.defineCommand('tokenPosition', { numberOfKeys: 4, lua: script('token_position.lua') });
redisCore.defineCommand('releaseLock', { numberOfKeys: 1, lua: script('release_lock.lua') });

/** A fresh connection for subscribers (ioredis cannot mix pub/sub and commands on one connection). */
export function newCoreSubscriber() {
  return makeClient(env.REDIS_CORE_URL, 'sub');
}

/** Connection options for BullMQ (it manages its own connections). */
export function bullConnection() {
  return { url: env.REDIS_CORE_URL, maxRetriesPerRequest: null };
}

export async function checkRedisCore() {
  try {
    return (await redisCore.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis() {
  await Promise.allSettled([redisCore.quit(), redisCache.quit()]);
}

// ---- Key catalogue (§8.2). Keys never contain direct identifiers. ----
export const keys = {
  lane: (qs, lane) => `q:{${qs}}:lane:${lane}`,
  tok: (qs, tokenId) => `q:{${qs}}:tok:${tokenId}`,
  meta: (qs) => `q:{${qs}}:meta`,
  serving: (qs) => `q:{${qs}}:serving`,
  tokref: (ref) => `tokref:${ref}`,
  docStatus: (userId) => `doc:${userId}:status`,
  lockConv: (conversationId) => `lock:conv:${conversationId}`,
  lockLeader: 'lock:leader:scheduler',
  dedupeWa: (id) => `dedupe:wa:${id}`,
  notifOnce: (dedupeKey) => `notif:once:${dedupeKey}`,
  idem: (principalId, key) => `idem:${principalId}:${key}`,
  otp: (contactHash) => `otp:${contactHash}`,
  rl: (scope, id, window) => `rl:${scope}:${id}:${window}`,
  kbver: (facilityId) => (facilityId ? `kbver:${facilityId}` : 'kbver:state'),
  rulesver: 'rulesver',
  llmBudget: (facilityId, yyyymmdd) => `llm:budget:${facilityId}:${yyyymmdd}`,
  cb: (provider) => `cb:${provider}`,
  revoked: (userId) => `revoked:${userId}`,
  breakglass: (userId, patientId) => `bg:${userId}:${patientId}`,
  // redis-cache
  cfgFacility: (facilityId) => `cfg:facility:${facilityId}`,
  ptSummary: (patientId, v) => `pt:summary:${patientId}:${v}`,
  prebrief: (encounterId) => `prebrief:${encounterId}`,
  kbAns: (facilityId, lang, kbver, sha1) => `kb:ans:${facilityId ?? 'state'}:${lang}:${kbver}:${sha1}`,
  kbEmb: (sha1) => `kb:emb:${sha1}`,
  waitboard: (facilityId) => `waitboard:${facilityId}`,
  // pub/sub channels
  chRealtime: 'rt:events',
  chRulesPublished: 'rules:published',
  chConfigInvalidate: 'cfg:invalidate',
};
