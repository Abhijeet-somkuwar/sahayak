/**
 * Web / kiosk adapter over the intake engine (§9.3, §11.2): the same state machine WhatsApp uses.
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import { pick, render } from '../../shared/i18n.js';
import { intakeRepo } from './repo.js';
import { intakeEngine } from './engine.js';

export const intakeService = {
  /** POST /intake/sessions — start a web/kiosk intake and return the first prompt(s). */
  async start(principal, input) {
    const channel = principal.kind === 'device' ? 'kiosk' : 'web';
    const contactPointId = principal.kind === 'patient' ? principal.contactPointId : null;
    if (principal.kind !== 'patient' && principal.kind !== 'device')
      throw new AppError('unauthenticated', 'patient or kiosk authentication required');
    const facilityId = principal.kind === 'device' ? principal.facilityId : (input.facility_id ?? null);
    const conv = await withScope(STATE_SCOPE, (trx) =>
      intakeRepo.findOrCreateConversation(trx, {
        channel,
        external_ref_hash: null,
        contact_point_id: contactPointId,
        facility_id: facilityId,
        language: input.language,
      }),
    );
    const messages = await intakeEngine.handle(
      { conversationId: conv.id, channel, messageId: `start:${conv.id}`, language: input.language },
      { kind: 'start', facilityCode: input.facility_code ?? null },
    );
    return this.snapshot(conv.id, messages);
  },

  /** POST /intake/sessions/{id}/answers — submit an answer → next prompt or outcome. */
  async answer(principal, conversationId, event, messageId) {
    const conv = await this.ownedConversation(principal, conversationId);
    const messages = await intakeEngine.handle(
      { conversationId: conv.id, channel: conv.channel === 'kiosk' ? 'kiosk' : 'web', messageId: messageId ?? newId() },
      event,
    );
    return this.snapshot(conv.id, messages);
  },

  /** GET /intake/sessions/{id} — resume: current state and a re-rendered prompt. */
  async resume(principal, conversationId) {
    const conv = await this.ownedConversation(principal, conversationId);
    const prompt = await render(`intake.resume_${conv.state}`, conv.language, {}, 'web');
    return this.snapshot(conv.id, prompt.text.startsWith('[') ? [] : [{ templateCode: prompt.code, text: prompt.text }]);
  },

  async cancelBooking(principal, encounterId) {
    if (principal.kind !== 'patient') throw new AppError('unauthenticated');
    await withScope(STATE_SCOPE, async (trx) => {
      const e = await intakeRepo.encounterFacts(trx, encounterId);
      if (!e || e.contact_point_id !== principal.contactPointId) throw AppError.notFound('booking');
      if (!['intake', 'triaged', 'booked'].includes(e.status)) throw new AppError('invalid_state', `cannot cancel a ${e.status} visit`);
      await intakeRepo.updateEncounterStatus(trx, e.id, { status: 'cancelled', closed_at: new Date() });
    });
  },

  async ownedConversation(principal, conversationId) {
    const conv = await withScope(STATE_SCOPE, (trx) => intakeRepo.conversationById(trx, conversationId));
    if (!conv) throw AppError.notFound('intake session');
    if (principal.kind === 'patient' && conv.contact_point_id !== principal.contactPointId) throw AppError.notFound('intake session');
    if (principal.kind === 'device' && conv.facility_id !== principal.facilityId) throw AppError.notFound('intake session');
    if (principal.kind !== 'patient' && principal.kind !== 'device') throw new AppError('unauthenticated');
    return conv;
  },

  async snapshot(conversationId, messages) {
    const conv = await withScope(STATE_SCOPE, (trx) => intakeRepo.conversationById(trx, conversationId));
    const assistant = conv ? await this.assistantView(conv, messages).catch(() => null) : null;
    return { session_id: conversationId, state: conv?.state ?? 'idle', encounter_id: conv?.active_encounter_id ?? null, messages, assistant };
  },

  /**
   * What the assistant understood and how the visit was routed, as structured data the patient screen renders:
   * symptom labels from the reviewed catalogue, the urgency level, the department and which method chose it.
   * 🔒 No AI-written text and no diagnosis reaches the patient: everything here is a code, a catalogue label or a
   * rules-engine result.
   */
  async assistantView(conv, messages) {
    const lang = conv.language || 'en';
    const link = messages.find((m) => typeof m.link === 'string' && m.link.startsWith('sahayak:enc:'));
    const outcome = !!link || messages.some((m) => /^(triage\.(emergency|self_harm)|outcome\.self_care)/.test(m.templateCode || ''));
    return withScope(STATE_SCOPE, async (trx) => {
      let session = null;
      if (link) session = await intakeRepo.sessionByEncounter(trx, link.link.slice('sahayak:enc:'.length));
      else if (conv.active_encounter_id) session = await intakeRepo.sessionByEncounter(trx, conv.active_encounter_id);
      else if (outcome) session = await intakeRepo.latestSessionForConversation(trx, conv.id);
      if (!session || (!outcome && session.status !== 'in_progress')) return null;
      const facts = session.facts ?? {};
      const codes = Array.isArray(facts['symptoms']) ? facts['symptoms'] : [];
      const catalog = await intakeRepo.symptomsByCodes(trx, codes);
      const label = (code) => {
        const c = catalog.find((x) => x.code === code);
        return (c && (pick(c.labels, lang) || c.labels['en'])) || String(code).replace(/^SYM_/, '').replace(/_/g, ' ').toLowerCase();
      };
      const view = {
        mode: session.mode,
        understood: codes.length ? { symptoms: codes.map((code) => ({ code, label: label(code) })), duration_hours: facts['duration_hours'] ?? null } : null,
        questions_asked: (session.questions_asked ?? []).length,
        decision: null,
      };
      if (outcome && session.encounter_id) {
        const a = await intakeRepo.latestAssessment(trx, session.encounter_id);
        if (a) {
          const dept = a.routed_department_id ? await intakeRepo.departmentName(trx, a.routed_department_id) : null;
          const flagCodes = (a.red_flags ?? []).filter((f) => /^SYM_/.test(f));
          const flagCatalog = await intakeRepo.symptomsByCodes(trx, flagCodes);
          view.decision = {
            level: a.final_level,
            department: dept ? pick(dept.name_i18n, lang) || dept.name : null,
            routing_method: a.routing_method,
            danger_signs: flagCodes.map((code) => {
              const c = flagCatalog.find((x) => x.code === code);
              return (c && (pick(c.labels, lang) || c.labels['en'])) || code;
            }),
          };
        }
      }
      return view;
    });
  },
};
