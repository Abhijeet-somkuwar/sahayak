/**
 * intake-expiry (every 5 min, §12.2): one reminder after 10 minutes idle; abandoned after 2 hours.
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { intakeRepo } from './repo.js';
import { notify } from '../notifications/service.js';

export async function runIntakeExpiry() {
  let abandoned = 0,
    reminded = 0;
  await withScope(STATE_SCOPE, async (trx) => {
    for (const s of await intakeRepo.expiredSessions(trx)) {
      await intakeRepo.updateSession(trx, s.id, s.version, { status: 'abandoned' });
      await intakeRepo.cancelIntakeEncounter(trx, s.encounter_id);
      if (s.conversation_id) await intakeRepo.resetConversationAfterAbandon(trx, s.conversation_id, s.encounter_id);
      abandoned++;
    }
    for (const s of await intakeRepo.idleSessions(trx, new Date(Date.now() - 10 * 60_000))) {
      const facts = s.facts ?? {};
      if (facts['_reminded']) continue;
      const conv = s.conversation_id ? await intakeRepo.conversationById(trx, s.conversation_id) : null;
      if (conv?.contact_point_id) {
        await notify(conv.contact_point_id, 'intake.reminder', {}, { dedupeKey: `intake-reminder:${s.id}`, encounterId: s.encounter_id });
        reminded++;
      }
      await intakeRepo.updateSession(trx, s.id, s.version, { facts: { ...facts, _reminded: true } });
    }
  });
  return { abandoned, reminded };
}
