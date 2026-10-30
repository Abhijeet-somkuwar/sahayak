import { sql } from 'kysely';

import { newId } from '../../shared/ids.js';

export const authRepo = {
  userByEmail: (trx, email) =>
    trx
      .selectFrom('users')
      .selectAll()
      .where(sql`lower(email)`, '=', email.toLowerCase())
      .executeTakeFirst(),
  userByPhoneHash: (trx, hash) => trx.selectFrom('users').selectAll().where('phone_hash', '=', hash).executeTakeFirst(),
  userById: (trx, id) => trx.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst(),
  activeMemberships: (trx, userId) =>
    trx
      .selectFrom('staff_memberships')
      .select(['id', 'facility_id', 'role', 'department_id'])
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>=', sql`current_date`)]))
      .execute(),
  recordFailedLogin: (trx, userId, lockUntil) =>
    trx
      .updateTable('users')
      .set((eb) => ({ failed_login_count: eb('failed_login_count', '+', 1), locked_until: lockUntil }))
      .where('id', '=', userId)
      .execute(),
  recordLogin: (trx, userId) =>
    trx
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null, last_login_at: new Date() })
      .where('id', '=', userId)
      .execute(),
  setMfaSecret: (trx, userId, enc) => trx.updateTable('users').set({ mfa_secret_enc: enc }).where('id', '=', userId).execute(),

  insertRefresh: (trx, row) =>
    trx
      .insertInto('refresh_tokens')
      .values({
        id: newId(),
        user_id: row.userId,
        family_id: row.familyId,
        token_hash: row.tokenHash,
        device_label: row.deviceLabel,
        ip: row.ip,
        expires_at: row.expiresAt,
      })
      .execute(),
  refreshByHash: (trx, hash) => trx.selectFrom('refresh_tokens').selectAll().where('token_hash', '=', hash).executeTakeFirst(),
  markRotated: (trx, id) => trx.updateTable('refresh_tokens').set({ rotated_at: new Date() }).where('id', '=', id).execute(),
  revokeFamily: (trx, familyId) =>
    trx
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute(),
  familyCreatedAt: async (trx, familyId) => {
    const r = await trx
      .selectFrom('refresh_tokens')
      .select((eb) => eb.fn.min('created_at').as('c'))
      .where('family_id', '=', familyId)
      .executeTakeFirst();
    return r?.c ?? new Date();
  },
  deleteExpiredRefreshTokens: (trx) =>
    trx
      .deleteFrom('refresh_tokens')
      .where((eb) => eb.or([eb('expires_at', '<', new Date()), eb('revoked_at', '<', new Date(Date.now() - 7 * 86_400_000))]))
      .executeTakeFirst(),
};
