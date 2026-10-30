import { SignJWT, jwtVerify, importPKCS8, importSPKI } from 'jose';

import { env } from '../config/env.js';
import { db } from '../infra/db.js';
import { redisCore, keys as rkeys } from '../infra/redis.js';
import { sha256 } from '../infra/crypto.js';

import { AppError } from './errors.js';
import { hasPermission } from './rbac.js';

function pem(raw) {
  return raw.includes('-----BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8');
}

let privateKey;
let publicKey;
async function keys() {
  privateKey ??= await importPKCS8(pem(env.JWT_PRIVATE_KEY), 'EdDSA');
  publicKey ??= await importSPKI(pem(env.JWT_PUBLIC_KEY), 'EdDSA');
  return { priv: privateKey, pub: publicKey };
}

export async function signAccessToken(claims, ttlSeconds) {
  const { priv } = await keys();
  const ttl = ttlSeconds ?? (claims.typ === 'staff' ? env.ACCESS_TOKEN_TTL_SECONDS : 24 * 3600);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setIssuer('sahayak')
    .setAudience('sahayak')
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(priv);
}

export async function verifyAccessToken(token) {
  const { pub } = await keys();
  const { payload } = await jwtVerify(token, pub, { issuer: 'sahayak', audience: 'sahayak', algorithms: ['EdDSA'] });
  return payload;
}

/** Deactivating a user writes revoked:<userId> = now for 15 minutes; tokens issued before it are rejected. */
export async function revokeUser(userId) {
  await redisCore.set(rkeys.revoked(userId), String(Math.floor(Date.now() / 1000)), 'EX', env.ACCESS_TOKEN_TTL_SECONDS);
}

const deviceCache = new Map();

async function resolveDevice(apiKey) {
  const hashHex = sha256(apiKey).toString('hex');
  const cached = deviceCache.get(hashHex);
  if (cached && Date.now() - cached.at < 60_000) return { kind: 'device', ...cached };
  const row = await db
    .selectFrom('devices')
    .select(['id', 'facility_id', 'kind', 'department_ids', 'service_point_ids'])
    .where('api_key_hash', '=', sha256(apiKey))
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!row) return null;
  const d = {
    deviceId: row.id,
    facilityId: row.facility_id,
    deviceKind: row.kind,
    departmentIds: row.department_ids,
    servicePointIds: row.service_point_ids,
    at: Date.now(),
  };
  deviceCache.set(hashHex, d);
  void db
    .updateTable('devices')
    .set({ last_seen_at: new Date() })
    .where('id', '=', row.id)
    .execute()
    .catch(() => {});
  return { kind: 'device', ...d };
}

export async function principalFromRequest(req) {
  const deviceKey = req.headers['x-device-key'];
  if (typeof deviceKey === 'string' && deviceKey.length > 0) {
    const p = await resolveDevice(deviceKey);
    if (!p) throw new AppError('unauthenticated', 'invalid device key');
    return p;
  }
  const auth = req.headers.authorization;
  if (!auth) return { kind: 'anonymous' };
  const [scheme, token] = auth.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) throw new AppError('unauthenticated', 'malformed Authorization header');
  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    throw new AppError('unauthenticated', 'invalid or expired token');
  }
  if (claims.typ === 'patient') {
    return { kind: 'patient', contactPointId: claims.sub, sessionId: claims.sid, language: claims.lang };
  }
  const revokedAt = await redisCore.get(rkeys.revoked(claims.sub));
  if (revokedAt && claims.iat <= Number(revokedAt)) throw new AppError('token_revoked', 'session was revoked');
  const facilityIds = [...new Set(claims.mem.map((m) => m.f).filter((f) => !!f))];
  const stateScope = claims.mem.some((m) => m.f === null && ['state_admin', 'auditor', 'dpo'].includes(m.r));
  return {
    kind: 'staff',
    userId: claims.sub,
    sessionId: claims.sid,
    memberships: claims.mem,
    facilityIds,
    stateScope,
    issuedAt: claims.iat,
    mfaVerified: claims.mfa,
  };
}

export function registerAuthHooks(app) {
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req) => {
    req.principal = await principalFromRequest(req);
  });
  // Route-declared permission (§9.1 layer 1).
  app.addHook('preHandler', async (req) => {
    const perm = req.routeOptions.config.permission;
    if (!perm) return;
    assertPermission(req, perm);
  });
}

export function assertPermission(req, permission, facilityId) {
  const p = req.principal;
  if (p.kind === 'device') {
    if (permission === 'queue.checkin' && (p.deviceKind === 'kiosk' || p.deviceKind === 'counter_terminal')) return;
    if (permission === 'queue.read') return;
    throw AppError.forbidden('device is not allowed to perform this action');
  }
  if (p.kind !== 'staff') throw new AppError('unauthenticated', 'staff authentication required');
  if (!p.mfaVerified) throw new AppError('mfa_required', 'complete MFA verification first');
  if (!hasPermission(p.memberships, permission, facilityId)) throw AppError.forbidden(`missing permission ${permission}`);
}

export function requireStaff(req) {
  if (req.principal.kind !== 'staff') throw new AppError('unauthenticated', 'staff authentication required');
  if (!req.principal.mfaVerified) throw new AppError('mfa_required', 'complete MFA verification first');
  return req.principal;
}
export function requirePatient(req) {
  if (req.principal.kind !== 'patient') throw new AppError('unauthenticated', 'patient sign-in required');
  return req.principal;
}
export function requireDevice(req, kinds) {
  if (req.principal.kind !== 'device') throw new AppError('unauthenticated', 'device key required');
  if (kinds && !kinds.includes(req.principal.deviceKind)) throw AppError.forbidden('device kind not allowed');
  return req.principal;
}
export function requirePatientOrDevice(req) {
  if (req.principal.kind === 'patient' || req.principal.kind === 'device') return req.principal;
  throw new AppError('unauthenticated', 'patient or kiosk authentication required');
}
/** Staff must have access to this facility (state scope or a membership there). */
export function assertFacilityAccess(req, facilityId) {
  const p = req.principal;
  if (p.kind === 'device') {
    if (p.facilityId !== facilityId) throw new AppError('facility_scope_violation', 'device belongs to another facility');
    return;
  }
  if (p.kind !== 'staff') throw new AppError('unauthenticated');
  if (p.stateScope) return;
  if (!p.facilityIds.includes(facilityId)) throw new AppError('facility_scope_violation', 'no membership at this facility');
}

export const noopPreHandler = (_req, _reply, done) => done();
