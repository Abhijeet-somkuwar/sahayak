/**
 * Socket.IO realtime role (§11.3): namespaces /staff (JWT), /display (device key), /patient (publicRef or patient token).
 * Rooms are authorised server-side on `subscribe`; events arrive from redis-core channel rt:events.
 * 🔒 Display and patient payloads never include names or clinical data.
 */
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { env } from '../../config/env.js';
import { logger } from '../../infra/logger.js';
import { newCoreSubscriber, redisCore, keys } from '../../infra/redis.js';
import { verifyAccessToken } from '../../shared/auth.js';
import { db, withScope, STATE_SCOPE } from '../../infra/db.js';
import { sha256 } from '../../infra/crypto.js';
import { resolveTokenRef, laneCounts, getSessionMeta } from '../queue/projection.js';
import { roomName } from './events.js';

const SAFE_FOR_DISPLAYS = new Set(['queue.snapshot', 'queue.updated', 'token.called', 'token.status', 'doctor.status']);

export async function startRealtime() {
  const http = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', role: 'realtime' }));
  });
  const io = new Server(http, {
    cors: { origin: env.NODE_ENV === 'production' ? false : true },
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000, skipMiddlewares: true },
    transports: ['websocket', 'polling'],
  });
  const pub = newCoreSubscriber(),
    sub = newCoreSubscriber();
  io.adapter(createAdapter(pub, sub));

  // ---- /staff ----
  const staff = io.of('/staff');
  staff.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth['token'] ?? '');
      const claims = await verifyAccessToken(token);
      if (claims.typ !== 'staff' || !claims.mfa) return next(new Error('unauthorized'));
      const revoked = await redisCore.get(keys.revoked(claims.sub));
      if (revoked && claims.iat <= Number(revoked)) return next(new Error('revoked'));
      const facilityIds = [...new Set(claims.mem.map((m) => m.f).filter((f) => !!f))];
      socket.data.auth = { kind: 'staff', userId: claims.sub, facilityIds, stateScope: claims.mem.some((m) => m.f === null) };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  staff.on('connection', (socket) => {
    const auth = socket.data.auth;
    socket.join(roomName({ kind: 'doctor', id: auth.userId }));
    socket.on('subscribe', async (room, ack) => {
      const ok = await authoriseStaffRoom(auth, room);
      if (!ok) return ack?.({ ok: false });
      socket.join(`${room.kind}:${room.id}`);
      if (room.kind === 'queue') socket.emit('queue.snapshot', await queueSnapshot(room.id));
      ack?.({ ok: true });
    });
    socket.on('unsubscribe', (room) => socket.leave(`${room.kind}:${room.id}`));
  });

  // ---- /display ----
  const display = io.of('/display');
  display.use(async (socket, next) => {
    const key = String(socket.handshake.auth['deviceKey'] ?? '');
    const row = key
      ? await db
          .selectFrom('devices')
          .select(['id', 'facility_id', 'department_ids'])
          .where('api_key_hash', '=', sha256(key))
          .where('status', '=', 'active')
          .executeTakeFirst()
      : undefined;
    if (!row) return next(new Error('unauthorized'));
    socket.data.auth = { kind: 'device', deviceId: row.id, facilityId: row.facility_id, departmentIds: row.department_ids };
    next();
  });
  display.on('connection', (socket) => {
    const auth = socket.data.auth;
    socket.join(roomName({ kind: 'display', id: auth.deviceId }));
    socket.join(roomName({ kind: 'facility', id: auth.facilityId }));
    socket.on('subscribe', async (room, ack) => {
      if (room.kind !== 'queue') return ack?.({ ok: false });
      // queue_sessions has row-level security: read it in this device's facility scope (no scope = no rows)
      const s = await withScope({ kind: 'facility', facilityIds: [auth.facilityId] }, (trx) =>
        trx.selectFrom('queue_sessions').select(['facility_id', 'department_id']).where('id', '=', room.id).executeTakeFirst(),
      );
      if (!s || s.facility_id !== auth.facilityId || (auth.departmentIds.length && !auth.departmentIds.includes(s.department_id)))
        return ack?.({ ok: false });
      socket.join(`queue:${room.id}`);
      socket.emit('queue.snapshot', await queueSnapshot(room.id));
      ack?.({ ok: true });
    });
  });

  // ---- /patient ----
  const patient = io.of('/patient');
  patient.use(async (socket, next) => {
    const ref = socket.handshake.auth['publicRef'];
    const token = socket.handshake.auth['token'];
    if (ref && /^[a-z2-7]{10}$/.test(ref)) {
      socket.data.auth = { kind: 'patient', contactPointId: null, publicRef: ref };
      return next();
    }
    if (token) {
      try {
        const c = await verifyAccessToken(token);
        if (c.typ === 'patient') {
          socket.data.auth = { kind: 'patient', contactPointId: c.sub, publicRef: null };
          return next();
        }
      } catch {
        /* fall through */
      }
    }
    next(new Error('unauthorized'));
  });
  patient.on('connection', async (socket) => {
    const auth = socket.data.auth;
    if (auth.publicRef) {
      const resolved = await resolveTokenRef(auth.publicRef);
      if (resolved) {
        socket.join(roomName({ kind: 'token', id: resolved.tokenId }));
        socket.join(`queue:${resolved.qs}`);
      }
    }
  });

  // ---- fan-out from redis-core ----
  const events = newCoreSubscriber();
  await events.subscribe(keys.chRealtime);
  events.on('message', (_ch, raw) => {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    for (const room of ev.rooms) {
      const name = roomName(room);
      staff.to(name).emit(ev.event, ev.payload);
      if (SAFE_FOR_DISPLAYS.has(ev.event)) {
        display.to(name).emit(ev.event, ev.payload);
        patient.to(name).emit(ev.event, redactForPatient(ev.payload));
      }
    }
  });

  await new Promise((resolve) => http.listen(env.PORT, resolve));
  logger.info({ port: env.PORT }, 'realtime listening');
  return {
    close: async () => {
      io.close();
      await Promise.allSettled([pub.quit(), sub.quit(), events.quit()]);
      http.close();
    },
  };
}

async function authoriseStaffRoom(auth, room) {
  if (room.kind === 'doctor') return room.id === auth.userId;
  if (room.kind === 'queue') {
    // queue_sessions has row-level security: read it in the staff member's own scope (no scope = no rows, fail closed)
    const scope = auth.stateScope ? STATE_SCOPE : { kind: 'facility', facilityIds: auth.facilityIds };
    const s = await withScope(scope, (trx) => trx.selectFrom('queue_sessions').select('facility_id').where('id', '=', room.id).executeTakeFirst());
    return !!s && (auth.stateScope || auth.facilityIds.includes(s.facility_id));
  }
  if (room.kind === 'ed' || room.kind === 'facility') return auth.stateScope || auth.facilityIds.includes(room.id);
  return false;
}

async function queueSnapshot(qs) {
  const [counts, meta] = await Promise.all([laneCounts(qs), getSessionMeta(qs)]);
  const serving = await redisCore.hgetall(keys.serving(qs)).catch(() => ({}));
  const nowServing = [];
  for (const tokenId of Object.values(serving)) {
    const t = await redisCore.hgetall(keys.tok(qs, tokenId)).catch(() => null);
    if (t?.['code'] && (t['status'] === 'called' || t['status'] === 'in_consult'))
      nowServing.push({ token: t['code'], room: t['room'] ?? '' });
  }
  return {
    queue_session_id: qs,
    lanes: { urgent: counts[0], protected: counts[1], general: counts[2] },
    ewma_consult_sec: meta.ewma_consult_sec,
    active_servers: meta.active_servers,
    status: meta.status,
    now_serving: nowServing,
  };
}

function redactForPatient(p) {
  const { patient_id: _p, encounter_id: _e, doctor_id: _d, ...rest } = p;
  return rest;
}
