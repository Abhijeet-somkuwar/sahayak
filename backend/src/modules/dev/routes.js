/**
 * Development-only demo helpers. Nothing here is registered when NODE_ENV=production.
 *
 *   GET  /api/v1/dev/demo         everything the web "Demo" panel shows: the demo staff logins and password, the
 *                                 kiosk / display device keys, sample patient phone numbers.
 *   POST /api/v1/dev/demo/reset   "Start a fresh demo": cancels today's leftover tokens (through the normal queue
 *                                 transitions, so Redis, displays and slips stay consistent), resets the lane
 *                                 fairness counters and closes casualty pre-alerts.
 *
 * Device keys are only stored hashed in the database; the seed prints them once and they are kept in the git-ignored
 * file backend/.demo-device-keys.json. If a key there is missing or no longer matches, it is rotated here (dev only)
 * and the file is rewritten, so the panel always offers a working key.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { isProd } from '../../config/env.js';
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { redisCore, keys } from '../../infra/redis.js';
import { randomToken, sha256 } from '../../infra/crypto.js';
import { AppError } from '../../shared/errors.js';
import { istDate } from '../../shared/time.js';
import { MFA_REQUIRED_ROLES } from '../../shared/rbac.js';
import { facilitiesRepo } from '../facilities/repo.js';
import { queueRepo } from '../queue/repo.js';
import { queueService } from '../queue/service.js';

const DEMO_FACILITY = 'GJ-DEMO-DH';
const DEMO_DOMAIN = '@demo.sahayak.health';
const DEMO_PASSWORD = 'Demo@12345678'; // the password db/seeds/seed.js gives every demo account
const KEYS_FILE = fileURLToPath(new URL('../../../.demo-device-keys.json', import.meta.url));

const readKeys = () => {
  try {
    return existsSync(KEYS_FILE) ? JSON.parse(readFileSync(KEYS_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
};
const sameHash = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);

async function demoFacility(code) {
  const f = await withScope(STATE_SCOPE, (trx) => facilitiesRepo.byCode(trx, code || DEMO_FACILITY));
  if (!f) throw AppError.notFound('facility');
  return f;
}

/** Working keys for the facility's active devices; rotates (and saves) any key the file does not hold. */
async function deviceKeys(facilityId) {
  const file = readKeys();
  let changed = false;
  const out = await withScope(STATE_SCOPE, async (trx) => {
    const devices = await trx
      .selectFrom('devices')
      .select(['id', 'label', 'kind', 'api_key_hash'])
      .where('facility_id', '=', facilityId)
      .where('status', '=', 'active')
      .orderBy('label')
      .execute();
    const items = [];
    for (const d of devices) {
      let key = file[d.label];
      if (!key || !sameHash(d.api_key_hash, sha256(key))) {
        key = `sk_dev_${randomToken(32)}`;
        await trx.updateTable('devices').set({ api_key_hash: sha256(key) }).where('id', '=', d.id).execute();
        file[d.label] = key;
        changed = true;
      }
      items.push({ label: d.label, kind: d.kind, key });
    }
    return items;
  });
  if (changed) writeFileSync(KEYS_FILE, JSON.stringify(file, null, 2) + '\n');
  return out;
}

export async function devRoutes(app) {
  if (isProd) return;

  app.get(
    '/api/v1/dev/demo',
    {
      config: { public: true, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { tags: ['dev'], querystring: z.object({ facility: z.string().max(32).optional() }) },
    },
    async (req) => {
      const f = await demoFacility(req.query.facility);
      const staff = await withScope(STATE_SCOPE, (trx) =>
        trx
          .selectFrom('users as u')
          .innerJoin('staff_memberships as m', 'm.user_id', 'u.id')
          .leftJoin('departments as d', 'd.id', 'm.department_id')
          .select(['u.email', 'u.display_name', 'm.role', 'd.name as department', 'd.code as department_code'])
          .where('u.email', 'like', `%${DEMO_DOMAIN}`)
          .where('u.status', '=', 'active')
          .where((eb) => eb.or([eb('m.facility_id', '=', f.id), eb('m.facility_id', 'is', null)]))
          .orderBy('u.email')
          .execute(),
      );
      return {
        facility: { code: f.code, name: f.name },
        staff_password: DEMO_PASSWORD,
        staff: staff.map((s) => ({ ...s, mfa: MFA_REQUIRED_ROLES.has(s.role) })),
        devices: await deviceKeys(f.id),
        patient_phones: ['9876543210', '9876543211', '9876543212', '9876543213'],
      };
    },
  );

  app.post(
    '/api/v1/dev/demo/reset',
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['dev'], body: z.object({ facility: z.string().max(32).optional() }).strict().nullish() },
    },
    async (req) => {
      const f = await demoFacility(req.body?.facility);
      const admin = await withScope(STATE_SCOPE, (trx) =>
        trx.selectFrom('users').select('id').where('email', '=', `admin${DEMO_DOMAIN}`).executeTakeFirst(),
      );
      const actor = { userId: admin?.id ?? null };
      const sessions = await withScope(STATE_SCOPE, (trx) => queueRepo.sessionsForDay(trx, f.id, istDate()));
      let cancelled = 0;
      let completed = 0;
      for (const s of sessions) {
        const live = await withScope(STATE_SCOPE, (trx) => queueRepo.tokensByStatus(trx, s.id, ['waiting', 'called', 'skipped', 'in_consult']));
        for (const t of live) {
          try {
            if (t.status === 'in_consult') {
              await queueService.transition(STATE_SCOPE, t.id, t.version, 'complete', actor);
              completed++;
            } else if (t.status === 'called') {
              const skipped = await queueService.transition(STATE_SCOPE, t.id, t.version, 'skip', actor);
              await queueService.transition(STATE_SCOPE, skipped.id, skipped.version, 'cancel', actor, { reason: 'demo_reset' });
              cancelled++;
            } else {
              await queueService.transition(STATE_SCOPE, t.id, t.version, 'cancel', actor, { reason: 'demo_reset' });
              cancelled++;
            }
          } catch (err) {
            req.log.warn({ err, tokenId: t.id }, 'demo reset: token transition failed');
          }
        }
        // lane fairness starts from zero again, and nobody is "with the doctor"
        try {
          if (await redisCore.exists(keys.meta(s.id))) await redisCore.hset(keys.meta(s.id), { served_protected: '0', served_general: '0' });
          await redisCore.del(keys.serving(s.id));
        } catch {
          /* best-effort */
        }
      }
      const closed = await withScope(STATE_SCOPE, (trx) =>
        trx
          .updateTable('emergency_prealerts')
          .set({ status: 'closed' })
          .where('facility_id', '=', f.id)
          .where('status', 'in', ['open', 'acknowledged'])
          .executeTakeFirst(),
      );
      req.audit.record({ action: 'dev.demo_reset', resourceType: 'facility', resourceId: f.id, facilityId: f.id, purpose: 'administration' });
      return { cancelled, completed, prealerts_closed: Number(closed?.numUpdatedRows ?? 0) };
    },
  );
}
