import { toJson } from '../../infra/db.types.js';
import { newId } from '../../shared/ids.js';

export const notificationsRepo = {
  insert: (trx, row) =>
    trx
      .insertInto('notifications')
      .values({ ...row, id: newId(), variables: toJson(row.variables) })
      .returningAll()
      .executeTakeFirstOrThrow(),
  byId: (trx, id) => trx.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirst(),
  setStatus: (trx, id, status, extra = {}) =>
    trx
      .updateTable('notifications')
      .set((eb) => ({
        status,
        attempts: eb('attempts', '+', 1),
        provider_message_id: extra.providerMessageId ?? null,
        last_error: extra.error ?? null,
        sent_at: status === 'sent' ? new Date() : null,
      }))
      .where('id', '=', id)
      .execute(),
  conversationForContact: (trx, contactPointId) =>
    trx
      .selectFrom('conversations')
      .select(['id', 'last_inbound_at', 'language'])
      .where('contact_point_id', '=', contactPointId)
      .where('channel', '=', 'whatsapp')
      .orderBy('updated_at', 'desc')
      .executeTakeFirst(),
  touchOutbound: (trx, conversationId) =>
    trx.updateTable('conversations').set({ last_outbound_at: new Date() }).where('id', '=', conversationId).execute(),
  insertMessage: (trx, row) =>
    trx
      .insertInto('messages')
      .values({ ...row, id: newId() })
      .execute(),
  primaryLanguage: async (trx, contactPointId) => {
    const r = await trx
      .selectFrom('patient_contacts as pc')
      .innerJoin('patients as p', 'p.id', 'pc.patient_id')
      .select('p.preferred_language')
      .where('pc.contact_point_id', '=', contactPointId)
      .orderBy('pc.is_primary', 'desc')
      .limit(1)
      .executeTakeFirst();
    return r?.preferred_language ?? null;
  },
  /** Tokens → contact points for threshold alerts (worker, state scope). */
  contactsForTokens: (trx, tokenIds) =>
    trx
      .selectFrom('opd_tokens as t')
      .innerJoin('encounters as e', 'e.id', 't.encounter_id')
      .select([
        't.id as token_id',
        't.encounter_id',
        't.display_code',
        't.lane',
        't.service_point_id',
        'e.contact_point_id',
        'e.facility_id',
      ])
      .where('t.id', 'in', tokenIds)
      .execute(),
};
