/**
 * Realtime events (§11.3). Published on redis-core channel rt:events by api/worker, fanned out by the realtime role.
 * 🔒 Display and patient payloads never include names or clinical data.
 */
import { redisCore, keys } from '../../infra/redis.js';

export function roomName(r) {
  return `${r.kind}:${r.id}`;
}

export async function publishRealtime(ev) {
  try {
    await redisCore.publish(keys.chRealtime, JSON.stringify(ev));
  } catch {
    /* realtime is best-effort; clients re-sync with queue.snapshot */
  }
}
