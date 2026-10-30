import { redisCore, keys } from '../infra/redis.js';
import { sha256 } from '../infra/crypto.js';
import { AppError, toProblem } from './errors.js';
import { principalId } from './http.js';

const PENDING = '__pending__';

export function registerIdempotencyHooks(app) {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.routeOptions.config.idempotent) return;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
      throw new AppError('idempotency_key_required', 'Idempotency-Key header (8-128 chars) is required on this endpoint');
    }
    const redisKey = keys.idem(principalId(req.principal), key);
    const bodyHash = sha256(JSON.stringify(req.body ?? null)).toString('hex');
    const set = await redisCore.set(redisKey, PENDING, 'EX', 30, 'NX');
    if (set === 'OK') {
      req._idem = { redisKey, bodyHash };
      return;
    }
    const existing = await redisCore.get(redisKey);
    if (!existing || existing === PENDING) throw new AppError('conflict', 'a request with this Idempotency-Key is still in progress');
    const stored = JSON.parse(existing);
    if (stored.bodyHash !== bodyHash)
      throw new AppError('idempotency_key_reused', 'Idempotency-Key was already used with a different request body');
    reply.code(stored.status).header('content-type', stored.contentType).header('idempotent-replayed', 'true');
    return reply.send(stored.body);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const idem = req._idem;
    if (!idem) return payload;
    const body = typeof payload === 'string' ? payload : payload == null ? '' : JSON.stringify(payload);
    if (reply.statusCode >= 500) {
      await redisCore.del(idem.redisKey); // let the client retry
      return payload;
    }
    const stored = {
      status: reply.statusCode,
      body,
      bodyHash: idem.bodyHash,
      contentType: String(reply.getHeader('content-type') ?? 'application/json'),
    };
    await redisCore.set(idem.redisKey, JSON.stringify(stored), 'EX', 24 * 3600);
    return payload;
  });
}

export { toProblem };
