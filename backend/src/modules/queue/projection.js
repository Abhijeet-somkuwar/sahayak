/**
 * Redis queue read model (§8.2–§8.4). All mutations happen in Postgres first; after commit the API applies the change
 * with apply_token_state.lua (version-guarded, idempotent). The outbox relay replays the same call if the API crashed.
 */
import { redisCore, keys } from '../../infra/redis.js';
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { queueProjectionRebuilds, queueWaitingTokens } from '../../infra/metrics.js';
import { logger } from '../../infra/logger.js';
import { queueRepo } from './repo.js';
import { etaRange, updateEwma } from './lanes.js';

export async function projectToken(p) {
  const qs = p.queueSessionId;
  try {
    const applied = await redisCore.applyTokenState(
      keys.tok(qs, p.tokenId),
      keys.lane(qs, 0),
      keys.lane(qs, 1),
      keys.lane(qs, 2),
      p.tokenId,
      p.version,
      p.status,
      p.lane,
      p.score,
      p.code,
      p.room ?? '',
    );
    return applied === 1;
  } catch (err) {
    logger.warn({ err }, 'token projection failed (will be replayed by the outbox relay)');
    return false;
  }
}

export async function setSessionMeta(qs, fields, ttlSeconds) {
  try {
    const flat = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) flat[k] = String(v);
    const multi = redisCore.multi().hset(keys.meta(qs), flat).expire(keys.meta(qs), ttlSeconds);
    for (const l of [0, 1, 2]) multi.expire(keys.lane(qs, l), ttlSeconds);
    multi.expire(keys.serving(qs), ttlSeconds);
    await multi.exec();
  } catch (err) {
    logger.warn({ err }, 'session meta update failed');
  }
}

export async function getSessionMeta(qs) {
  const m = await redisCore.hgetall(keys.meta(qs)).catch(() => ({}));
  return {
    status: m['status'] ?? 'unknown',
    ewma_consult_sec: Number(m['ewma_consult_sec'] ?? 300),
    active_servers: Number(m['active_servers'] ?? 0),
    ratio_protected: Number(m['ratio_protected'] ?? 1),
    ratio_general: Number(m['ratio_general'] ?? 2),
    served_protected: Number(m['served_protected'] ?? 0),
    served_general: Number(m['served_general'] ?? 0),
    starts_at: Number(m['starts_at'] ?? 0),
  };
}

export async function incrServed(qs, lane) {
  if (lane === 1) await redisCore.hincrby(keys.meta(qs), 'served_protected', 1).catch(() => {});
  if (lane === 2) await redisCore.hincrby(keys.meta(qs), 'served_general', 1).catch(() => {});
}

export async function recordConsult(qs, consultSeconds) {
  try {
    const cur = Number((await redisCore.hget(keys.meta(qs), 'ewma_consult_sec')) ?? 300);
    await redisCore.hset(keys.meta(qs), 'ewma_consult_sec', String(updateEwma(cur, consultSeconds)));
  } catch {
    /* best-effort */
  }
}

export async function setServing(qs, doctorId, tokenId) {
  try {
    if (tokenId) await redisCore.hset(keys.serving(qs), doctorId, tokenId);
    else await redisCore.hdel(keys.serving(qs), doctorId);
  } catch {
    /* best-effort */
  }
}

export async function laneHeads(qs) {
  const out = [];
  for (const lane of [0, 1, 2]) {
    const r = await redisCore.zrange(keys.lane(qs, lane), 0, 0, 'WITHSCORES');
    if (r.length >= 2) out.push({ lane, tokenId: r[0], queueEntryAt: Number(r[1]) });
  }
  return out;
}

export async function laneCounts(qs) {
  const [a, b, c] = await Promise.all([0, 1, 2].map((l) => redisCore.zcard(keys.lane(qs, l))));
  return [a ?? 0, b ?? 0, c ?? 0];
}

/** Position, people ahead and ETA for a token (O(log n) in Redis). Returns null when the token is not waiting. */
export async function tokenPosition(qs, tokenId, sessionStartsAt) {
  const tok = await redisCore.hgetall(keys.tok(qs, tokenId));
  if (!tok || !tok['status']) return null;
  const lane = Number(tok['lane']);
  const meta = await getSessionMeta(qs);
  const base = { status: tok['status'], code: tok['code'] ?? '', room: tok['room'] ?? '', lane };
  if (tok['status'] !== 'waiting')
    return { ...base, rank: 0, ahead: 0, eta_seconds: 0, eta: { min_minutes: 0, max_minutes: 0, doctor_unavailable: false } };
  const pos = await redisCore.tokenPosition(keys.lane(qs, 0), keys.lane(qs, 1), keys.lane(qs, 2), keys.meta(qs), tokenId, lane);
  if (!pos) return { ...base, rank: 0, ahead: 0, eta_seconds: 0, eta: { min_minutes: 0, max_minutes: 0, doctor_unavailable: false } };
  const [rank, ahead, etaSeconds] = pos;
  return { ...base, rank, ahead, eta_seconds: etaSeconds, eta: etaRange(etaSeconds, meta.active_servers, sessionStartsAt) };
}

/** Rebuild one session's read model from Q15 (§8.4). Milliseconds per session. */
export async function rebuildSession(qs, ttlSeconds = 6 * 3600) {
  const rows = await withScope(STATE_SCOPE, (trx) => queueRepo.snapshot(trx, qs));
  const multi = redisCore.multi();
  for (const l of [0, 1, 2]) multi.del(keys.lane(qs, l));
  await multi.exec();
  let applied = 0;
  for (const t of rows) {
    // Force re-apply even if the hash already holds this version: delete the hash first so the version guard passes.
    await redisCore.del(keys.tok(qs, t.id));
    if (
      await projectToken({
        queueSessionId: qs,
        tokenId: t.id,
        version: t.version,
        status: t.status,
        lane: t.lane,
        score: t.queue_entry_at.getTime(),
        code: t.display_code,
        room: '',
      })
    )
      applied++;
  }
  for (const l of [0, 1, 2]) await redisCore.expire(keys.lane(qs, l), ttlSeconds);
  queueProjectionRebuilds.inc();
  return applied;
}

/** Compare ZCARD per lane with SQL counts; rebuild on mismatch (§8.4). Returns true when a rebuild happened. */
export async function reconcileSession(qs, facilityId, departmentId) {
  const [counts, sqlCounts] = await Promise.all([laneCounts(qs), withScope(STATE_SCOPE, (trx) => queueRepo.waitingCounts(trx, qs))]);
  const expected = [0, 0, 0];
  for (const r of sqlCounts) expected[r.lane] = Number(r.n);
  for (const l of [0, 1, 2]) queueWaitingTokens.set({ facility: facilityId, department: departmentId, lane: String(l) }, expected[l]);
  const mismatch = counts.some((c, i) => c !== expected[i]);
  if (mismatch) {
    logger.warn({ qs, redis: counts, sql: expected }, 'queue projection mismatch; rebuilding');
    await rebuildSession(qs);
  }
  return mismatch;
}

export async function storeTokenRef(ref, qs, tokenId) {
  await redisCore
    .multi()
    .set(keys.tokref(ref), `${qs}:${tokenId}`, 'EX', 36 * 3600)
    .set(`${keys.tokref('rev')}:${tokenId}`, ref, 'EX', 36 * 3600)
    .exec();
}
export async function resolveTokenRef(ref) {
  const v = await redisCore.get(keys.tokref(ref));
  if (!v) return null;
  const [qs, tokenId] = v.split(':');
  return qs && tokenId ? { qs, tokenId } : null;
}
export async function tokenRefOf(tokenId) {
  return redisCore.get(`${keys.tokref('rev')}:${tokenId}`);
}

/** Doctor availability heartbeat (doc:<userId>:status, 15 min TTL). */
export async function setDoctorStatus(userId, status, qs) {
  await redisCore
    .multi()
    .hset(keys.docStatus(userId), { status, qs: qs ?? '', since: String(Date.now()) })
    .expire(keys.docStatus(userId), 900)
    .exec();
}
export async function getDoctorStatus(userId) {
  const h = await redisCore.hgetall(keys.docStatus(userId));
  return h && h['status'] ? { status: h['status'], qs: h['qs'] || null } : null;
}
/** Count doctors in_opd for this session and store it in meta.active_servers. */
export async function refreshActiveServers(qs, doctorIds) {
  let n = 0;
  for (const id of doctorIds) {
    const s = await getDoctorStatus(id);
    if (s?.status === 'in_opd' && (s.qs === qs || !s.qs)) n++;
  }
  await redisCore.hset(keys.meta(qs), 'active_servers', String(n)).catch(() => {});
  return n;
}
