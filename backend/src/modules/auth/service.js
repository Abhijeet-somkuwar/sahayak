/**
 * Identity and authentication (§9.1).
 */
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { env, isProd } from '../../config/env.js';
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { blindIndex, decryptText, encrypt, randomDigits, randomToken, sha256 } from '../../infra/crypto.js';
import { redisCore, keys } from '../../infra/redis.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { MFA_REQUIRED_ROLES } from '../../shared/rbac.js';
import { signAccessToken, verifyAccessToken, revokeUser } from '../../shared/auth.js';
import { normalisePhone } from '../../shared/phone.js';
import { hmacSha256Hex } from '../../infra/crypto.js';

import { authRepo } from './repo.js';
import { patientsService } from '../patients/service.js';
import { notify } from '../notifications/service.js';

// argon2id: at least 19 MiB memory, 2 iterations, parallelism 1 (§9.1)
export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw) => argon2.hash(pw, ARGON2_OPTIONS);

const REFRESH_IDLE_MS = 12 * 3600 * 1000;
const REFRESH_ABSOLUTE_MS = 7 * 86_400 * 1000;
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

function toClaims(memberships) {
  return memberships.map((m) => ({ f: m.facility_id, r: m.role, d: m.department_id }));
}

async function issueTokens(userId, mem, ctx) {
  const sid = newId();
  const access_token = await signAccessToken({ typ: 'staff', sub: userId, sid, mem, mfa: true });
  const refreshRaw = randomToken(32);
  const familyId = ctx.familyId ?? newId();
  await withScope(STATE_SCOPE, async (trx) => {
    const familyStart = ctx.familyId ? await authRepo.familyCreatedAt(trx, familyId) : new Date();
    const expiresAt = new Date(Math.min(Date.now() + REFRESH_IDLE_MS, familyStart.getTime() + REFRESH_ABSOLUTE_MS));
    await authRepo.insertRefresh(trx, {
      userId,
      familyId,
      tokenHash: sha256(refreshRaw),
      deviceLabel: ctx.deviceLabel ?? null,
      ip: ctx.ip ?? null,
      expiresAt,
    });
  });
  return { access_token, refresh_token: refreshRaw, token_type: 'Bearer', expires_in: env.ACCESS_TOKEN_TTL_SECONDS, session_id: sid };
}

export const authService = {
  async staffLogin(identifier, password, ctx) {
    const user = await withScope(STATE_SCOPE, async (trx) => {
      if (identifier.includes('@')) return authRepo.userByEmail(trx, identifier);
      try {
        return await authRepo.userByPhoneHash(trx, blindIndex('phone', normalisePhone(identifier)));
      } catch {
        return undefined;
      }
    });
    const fail = async () => {
      ctx.audit.record({ action: 'auth.login_failed', resourceType: 'user', resourceId: user?.id ?? null, purpose: 'authentication' });
      if (user) {
        await withScope(STATE_SCOPE, async (trx) => {
          const lock = user.failed_login_count + 1 >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
          await authRepo.recordFailedLogin(trx, user.id, lock);
        });
      }
      throw new AppError('invalid_credentials', 'invalid credentials');
    };
    if (!user || user.status !== 'active' || !user.password_hash) return fail();
    if (user.locked_until && user.locked_until.getTime() > Date.now())
      throw new AppError('account_locked', `account locked; try again in ${LOCK_MINUTES} minutes`);
    if (!(await argon2.verify(user.password_hash, password))) return fail();

    const memberships = await withScope(STATE_SCOPE, (trx) => authRepo.activeMemberships(trx, user.id));
    if (memberships.length === 0) throw AppError.forbidden('no active staff memberships');
    const mem = toClaims(memberships);
    await withScope(STATE_SCOPE, (trx) => authRepo.recordLogin(trx, user.id));
    ctx.audit.record({ action: 'auth.login', resourceType: 'user', resourceId: user.id, purpose: 'authentication' });

    const needsMfa = memberships.some((m) => MFA_REQUIRED_ROLES.has(m.role));
    if (needsMfa) {
      const mfa_token = await signAccessToken({ typ: 'staff', sub: user.id, sid: newId(), mem, mfa: false }, 300);
      return { mfa_required: true, mfa_token, enrol_required: !user.mfa_secret_enc };
    }
    return issueTokens(user.id, mem, { ip: ctx.ip, deviceLabel: ctx.deviceLabel });
  },

  /** Returns the otpauth URI for a user who has not enrolled TOTP yet. Enrolment completes on the first successful verify. */
  async mfaEnrol(mfaToken) {
    const claims = await verifyAccessToken(mfaToken).catch(() => {
      throw new AppError('unauthenticated', 'invalid mfa token');
    });
    if (claims.typ !== 'staff' || claims.mfa) throw new AppError('unauthenticated', 'not an MFA pending token');
    const enrolled = await withScope(STATE_SCOPE, (trx) => authRepo.userById(trx, claims.sub));
    if (enrolled?.mfa_secret_enc) throw new AppError('invalid_state', 'MFA is already enrolled for this account; an admin must reset it');
    const secret = authenticator.generateSecret(20);
    await redisCore.set(`mfa:enrol:${claims.sub}`, encrypt('pii', secret).ciphertext.toString('base64'), 'EX', 600);
    const user = await withScope(STATE_SCOPE, (trx) => authRepo.userById(trx, claims.sub));
    return { otpauth_url: authenticator.keyuri(user?.email ?? claims.sub, 'Sahayak', secret) };
  },

  async mfaVerify(mfaToken, code, ctx) {
    const claims = await verifyAccessToken(mfaToken).catch(() => {
      throw new AppError('unauthenticated', 'invalid mfa token');
    });
    if (claims.typ !== 'staff' || claims.mfa) throw new AppError('unauthenticated', 'not an MFA pending token');
    const user = await withScope(STATE_SCOPE, (trx) => authRepo.userById(trx, claims.sub));
    if (!user || user.status !== 'active') throw new AppError('unauthenticated');
    let secret;
    let enrolling = false;
    if (user.mfa_secret_enc) {
      secret = decryptText('pii', user.mfa_secret_enc);
    } else {
      const pending = await redisCore.get(`mfa:enrol:${user.id}`);
      if (!pending) throw new AppError('mfa_required', 'MFA enrolment required: call /auth/staff/mfa/enrol first');
      secret = decryptText('pii', Buffer.from(pending, 'base64'));
      enrolling = true;
    }
    if (!authenticator.verify({ token: code, secret })) {
      ctx.audit.record({ action: 'auth.mfa_failed', resourceType: 'user', resourceId: user.id, purpose: 'authentication' });
      throw new AppError('invalid_credentials', 'invalid MFA code');
    }
    if (enrolling) {
      await withScope(STATE_SCOPE, (trx) => authRepo.setMfaSecret(trx, user.id, encrypt('pii', secret).ciphertext));
      await redisCore.del(`mfa:enrol:${user.id}`);
      ctx.audit.record({ action: 'auth.mfa_enrolled', resourceType: 'user', resourceId: user.id, purpose: 'authentication' });
    }
    ctx.audit.record({ action: 'auth.mfa_verified', resourceType: 'user', resourceId: user.id, purpose: 'authentication' });
    return issueTokens(user.id, claims.mem, { ip: ctx.ip, deviceLabel: ctx.deviceLabel });
  },

  /**
   * Development only (mirrors dev_code on the patient OTP): the current authenticator code for the account behind
   * an MFA-pending token, so a developer can sign in without an authenticator app. The route is not registered in
   * production and this method refuses there too. The token proves the password was already accepted.
   */
  async mfaDevCode(mfaToken) {
    if (isProd) throw AppError.notFound('route');
    const claims = await verifyAccessToken(mfaToken).catch(() => {
      throw new AppError('unauthenticated', 'invalid mfa token');
    });
    if (claims.typ !== 'staff' || claims.mfa) throw new AppError('unauthenticated', 'not an MFA pending token');
    const user = await withScope(STATE_SCOPE, (trx) => authRepo.userById(trx, claims.sub));
    if (!user || user.status !== 'active') throw new AppError('unauthenticated');
    let secret;
    if (user.mfa_secret_enc) {
      secret = decryptText('pii', user.mfa_secret_enc);
    } else {
      const pending = await redisCore.get(`mfa:enrol:${user.id}`);
      if (!pending) throw new AppError('mfa_required', 'MFA enrolment required: call /auth/staff/mfa/enrol first');
      secret = decryptText('pii', Buffer.from(pending, 'base64'));
    }
    return { code: authenticator.generate(secret), seconds_left: authenticator.timeRemaining() };
  },

  /** Rotation with reuse detection: presenting an already-rotated token revokes the whole family. */
  async refresh(rawToken, ctx) {
    const hash = sha256(rawToken);
    const outcome = await withScope(STATE_SCOPE, async (trx) => {
      const row = await authRepo.refreshByHash(trx, hash);
      if (!row) return { kind: 'invalid' };
      if (row.revoked_at) return { kind: 'revoked' }; // family already revoked: plain 401
      if (row.rotated_at) {
        // presenting an already-rotated token = reuse
        await authRepo.revokeFamily(trx, row.family_id);
        return { kind: 'reused', userId: row.user_id };
      }
      if (row.expires_at.getTime() < Date.now()) return { kind: 'expired' };
      const familyStart = await authRepo.familyCreatedAt(trx, row.family_id);
      if (Date.now() - familyStart.getTime() > REFRESH_ABSOLUTE_MS) {
        await authRepo.revokeFamily(trx, row.family_id);
        return { kind: 'expired' };
      }
      await authRepo.markRotated(trx, row.id);
      const memberships = await authRepo.activeMemberships(trx, row.user_id);
      return { kind: 'ok', userId: row.user_id, familyId: row.family_id, mem: toClaims(memberships) };
    });
    if (outcome.kind === 'reused') {
      ctx.audit.record({
        action: 'auth.refresh_reuse_detected',
        resourceType: 'user',
        resourceId: outcome.userId,
        purpose: 'authentication',
      });
      throw new AppError('token_revoked', 'refresh token reuse detected; all sessions of this login were revoked');
    }
    if (outcome.kind === 'revoked') throw new AppError('token_revoked', 'refresh token was revoked');
    if (outcome.kind !== 'ok') throw new AppError('unauthenticated', 'invalid or expired refresh token');
    if (outcome.mem.length === 0) throw AppError.forbidden('no active staff memberships');
    return issueTokens(outcome.userId, outcome.mem, { ip: ctx.ip, familyId: outcome.familyId });
  },

  async logout(userId, rawToken, audit) {
    if (rawToken) {
      await withScope(STATE_SCOPE, async (trx) => {
        const row = await authRepo.refreshByHash(trx, sha256(rawToken));
        if (row && row.user_id === userId) await authRepo.revokeFamily(trx, row.family_id);
      });
    }
    audit.record({ action: 'auth.logout', resourceType: 'user', resourceId: userId, purpose: 'authentication' });
  },

  async deactivateUser(userId) {
    await revokeUser(userId);
  },

  async me(userId) {
    return withScope(STATE_SCOPE, async (trx) => {
      const user = await authRepo.userById(trx, userId);
      if (!user) throw AppError.notFound('user');
      const memberships = await authRepo.activeMemberships(trx, userId);
      return {
        id: user.id,
        display_name: user.display_name,
        email: user.email,
        hpr_id: user.hpr_id,
        mfa_enrolled: !!user.mfa_secret_enc,
        memberships,
      };
    });
  },

  // ---- Patients: OTP via WhatsApp authentication template (SMS fallback) ----
  async requestPatientOtp(rawPhone, language) {
    const phone = normalisePhone(rawPhone);
    const contactHash = blindIndex('phone', phone).toString('hex');
    const rlKey = keys.rl('otp', contactHash, '10m');
    const count = await redisCore.incr(rlKey);
    if (count === 1) await redisCore.expire(rlKey, 600);
    if (count > 3) throw new AppError('rate_limited', 'too many OTP requests for this number; try again later');
    const code = randomDigits(6);
    await redisCore.hset(keys.otp(contactHash), { code_hash: hmacSha256Hex(env.BLIND_INDEX_KEY, code), attempts: 0 });
    await redisCore.expire(keys.otp(contactHash), 300);
    const cp = await patientsService.findOrCreateContactPoint(phone);
    await notify(cp.id, 'auth.otp', { code }, { dedupeKey: `otp:${contactHash}:${code}`, critical: true, language, authentication: true });
    return isProd ? { sent: true } : { sent: true, dev_code: code };
  },

  async verifyPatientOtp(rawPhone, code, language) {
    const phone = normalisePhone(rawPhone);
    const contactHash = blindIndex('phone', phone).toString('hex');
    const key = keys.otp(contactHash);
    const stored = await redisCore.hgetall(key);
    if (!stored || !stored['code_hash']) throw new AppError('invalid_credentials', 'OTP expired or not requested');
    const attempts = await redisCore.hincrby(key, 'attempts', 1);
    if (attempts > 5) {
      await redisCore.del(key);
      throw new AppError('invalid_credentials', 'too many attempts; request a new OTP');
    }
    if (hmacSha256Hex(env.BLIND_INDEX_KEY, code) !== stored['code_hash']) throw new AppError('invalid_credentials', 'incorrect OTP');
    await redisCore.del(key);
    const cp = await patientsService.findOrCreateContactPoint(phone, { verified: true });
    const sid = newId();
    const access_token = await signAccessToken({ typ: 'patient', sub: cp.id, sid, lang: language });
    return { access_token, token_type: 'Bearer', expires_in: 24 * 3600, contact_point_id: cp.id };
  },
};
