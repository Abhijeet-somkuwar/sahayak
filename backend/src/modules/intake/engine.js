/**
 * Intake engine (§9.3): one state machine for every channel. Reads happen in short transactions, LLM/embedding calls
 * happen outside any transaction (PgBouncer + idle_in_transaction_session_timeout), and all writes of one step are
 * committed together at the end. Each step is idempotent on the inbound message id.
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { redisCore } from '../../infra/redis.js';
import { embedOne } from '../../infra/embeddings/index.js';
import { toVector } from '../../infra/db.types.js';
import { deidentify, llm } from '../../infra/llm/index.js';
import { intakeSessions as intakeSessionsMetric, intakeStepDuration, triageLevel as triageLevelMetric } from '../../infra/metrics.js';
import { logger } from '../../infra/logger.js';
import { render, pick, detectLanguage } from '../../shared/i18n.js';
import { ageYears, ageBand, istDate, roundTo5Minutes } from '../../shared/time.js';
import { newId } from '../../shared/ids.js';
import { getFacilityConfig, roomLabel } from '../facilities/service.js';
import { patientsService } from '../patients/service.js';
import { patientsRepo } from '../patients/repo.js';
import { queueService, waitboard } from '../queue/service.js';
import { getPublishedRuleSet } from '../triage/service.js';
import { triageRepo } from '../triage/repo.js';
import { combineLevels, emergencyPrescreen, evaluate, normaliseText } from '../triage/engine.js';
import { kbService } from '../kb/service.js';
import { followupsService } from '../followups/service.js';
import { intakeRepo } from './repo.js';
import { extractPromptV1 } from './prompts/extract.v1.js';
import { questionSelectPromptV1 } from './prompts/question_select.v1.js';
import { routePromptV1 } from './prompts/route.v1.js';

// Pregnancy questions only where pregnancy is possible: never for males, under 10 or over 55 (an unknown sex is still asked).
const PREGNANCY_FACTS = new Set(['pregnant', 'pregnancy_weeks', 'pregnancy_bleeding', 'fetal_movement_reduced', 'pregnancy_headache_swelling']);
const canBePregnant = (f) => f['sex'] !== 'male' && !(Number(f['age_years']) < 10) && !(Number(f['age_years']) > 55);

const SESSION_TTL_MS = 2 * 3600_000;
const MAX_QUESTIONS = 5;
const CONSENT_NOTICE_VERSION = 'consent.notice.v1';

async function readTrx(fn) {
  return withScope(STATE_SCOPE, fn);
}

export class IntakeEngine {
  async t(step, code, vars = {}) {
    return (await render(code, step.lang, vars, step.channel === 'kiosk' ? 'kiosk' : step.channel)).text;
  }
  async msg(step, code, vars = {}, extra = {}) {
    step.messages.push({ templateCode: code, text: await this.t(step, code, vars), ...extra });
  }
  async buttons(step, ids) {
    return Promise.all(ids.map(async ([id, code]) => ({ id, title: (await this.t(step, code)).slice(0, 20) })));
  }

  /** Entry point. Returns the outbound messages for this inbound event. */
  async handle(ctx, event) {
    const end = intakeStepDuration.startTimer();
    const idemKey = `intake:processed:${ctx.conversationId}:${ctx.messageId}`;
    if ((await redisCore.set(idemKey, '1', 'EX', 86_400, 'NX')) !== 'OK') return []; // reprocessing a message is a no-op
    const loaded = await readTrx(async (trx) => {
      const conv = await intakeRepo.conversationById(trx, ctx.conversationId);
      if (!conv) throw new Error('conversation not found');
      const session = conv.active_encounter_id ? await intakeRepo.sessionByEncounter(trx, conv.active_encounter_id) : null;
      return { conv, session: session && session.status === 'in_progress' ? session : null };
    });
    const step = {
      conv: loaded.conv,
      data: loaded.conv.state_data ?? {},
      session: loaded.session,
      facts: { ...(loaded.session?.facts ?? {}) },
      lang: ctx.language ?? loaded.conv.language,
      channel: ctx.channel,
      messages: [],
      nextState: loaded.conv.state,
      questionsAsked: [...(loaded.session?.questions_asked ?? [])],
      mode: loaded.session?.mode ?? 'ai_assisted',
      llmCalls: loaded.session?.llm_calls ?? 0,
      convPatch: {},
      writes: [],
      languageExplicit: !!ctx.language,
    };
    try {
      await this.dispatch(step, event);
    } catch (err) {
      logger.error({ err, state: step.conv.state }, 'intake step failed; escalating to staff');
      step.messages = [];
      await this.msg(step, 'intake.error_counter');
      step.nextState = 'idle';
    }
    await withScope(STATE_SCOPE, async (trx) => {
      for (const w of step.writes) await w(trx);
      if (step.session) {
        await intakeRepo.updateSession(trx, step.session.id, step.session.version, {
          step: step.sessionStep ?? step.nextState,
          facts: step.facts,
          questions_asked: step.questionsAsked,
          mode: step.mode,
          llm_calls: step.llmCalls,
        });
      }
      await intakeRepo.updateConversation(trx, step.conv.id, step.conv.version, {
        state: step.nextState,
        state_data: step.data,
        language: step.lang,
        ...step.convPatch,
      });
    });
    end({ step: loaded.conv.state });
    return step.messages;
  }

  async dispatch(step, event) {
    // Follow-up check-in buttons work in any state (§9.10).
    if (event.kind === 'choice' && event.id.startsWith('fu:')) return this.handleFollowupButton(step, event.id);
    if (event.kind === 'text' && step.conv.state === 'followup_checkin') return this.handleFollowupText(step, event.text);
    // 🔒 Self-harm or emergency phrases in any free text are handled before anything else.
    if (
      event.kind === 'text' &&
      step.conv.state !== 'idle' &&
      step.conv.state !== 'language' &&
      !['who_for_name', 'who_for_age', 'kb_answer'].includes(step.conv.state)
    ) {
      const rules = await getPublishedRuleSet();
      const pre = emergencyPrescreen(rules.rules, event.text);
      if (pre.selfHarm) return this.outcomeSelfHarm(step);
      if (pre.emergency && step.session) return this.outcomeEmergency(step, pre.matched);
    }
    const state = step.conv.state;
    switch (state) {
      case 'idle':
        return this.start(step, event);
      case 'language':
        return this.language(step, event);
      case 'facility':
        return this.facility(step, event);
      case 'consent':
        return this.consent(step, event);
      case 'consent_ai':
        return this.consentAi(step, event);
      case 'who_for':
        return this.whoFor(step, event);
      case 'who_for_name':
        return this.whoForName(step, event);
      case 'who_for_sex':
        return this.whoForSex(step, event);
      case 'who_for_age':
        return this.whoForAge(step, event);
      case 'who_for_relationship':
        return this.whoForRelationship(step, event);
      case 'purpose':
        return this.purpose(step, event);
      case 'complaint':
        return this.complaint(step, event);
      case 'complaint_confirm':
        return this.complaintConfirm(step, event);
      case 'extract_system':
        return this.extractSystem(step, event);
      case 'extract_symptom':
        return this.extractSymptom(step, event);
      case 'clarify':
        return this.clarifyAnswer(step, event);
      case 'risk':
        return this.riskAnswer(step, event);
      case 'outcome_self_care':
        return this.selfCareAnswer(step, event);
      case 'kb_answer':
        return this.kbAnswer(step, event);
      case 'kb_followup':
        return this.kbFollowup(step, event);
      default:
        return this.start(step, event);
    }
  }

  // ---------- language & facility ----------
  async start(step, event) {
    const text = event.kind === 'text' ? event.text.trim() : event.kind === 'start' ? (event.facilityCode ?? '') : '';
    if (text) {
      const fac = await readTrx((trx) => intakeRepo.facilityByCode(trx, text.replace(/^(start|hi|hello|namaste)\s+/i, '').trim()));
      if (fac) step.convPatch['facility_id'] = fac.id;
    }
    const detected = text ? detectLanguage(text) : null;
    if (step.conv.language && step.conv.last_inbound_at && step.conv.language !== 'hi') {
      /* keep known language */
    } else if (detected && detected !== 'en') step.lang = detected;
    else if (detected === 'en' && /^[a-z\s]+$/i.test(text) && !/\b(hai|hain|mujhe|mera|meri|dard|bukhar|se|ka|ki|ke)\b/i.test(text))
      step.lang = 'en';
    if (!detected && !step.conv.last_inbound_at && !step.languageExplicit) {
      await this.msg(
        step,
        'intake.ask_language',
        {},
        {
          buttons: [
            { id: 'lang:hi', title: 'हिन्दी' },
            { id: 'lang:gu', title: 'ગુજરાતી' },
            { id: 'lang:en', title: 'English' },
          ],
        },
      );
      step.nextState = 'language';
      return;
    }
    return this.facility(step, { kind: 'start', facilityCode: null });
  }

  async language(step, event) {
    if (event.kind === 'choice' && event.id.startsWith('lang:')) step.lang = event.id.slice(5);
    else if (event.kind === 'text') step.lang = detectLanguage(event.text) ?? 'hi';
    return this.facility(step, { kind: 'start', facilityCode: null });
  }

  async facility(step, event) {
    let facilityId = step.convPatch['facility_id'] ?? step.conv.facility_id ?? null;
    if (!facilityId && event.kind === 'choice' && event.id.startsWith('fac:')) facilityId = event.id.slice(4);
    if (!facilityId && event.kind === 'location') {
      const { facilitiesRepo } = await import('../facilities/repo.js');
      const near = await readTrx((trx) => facilitiesRepo.nearby(trx, event.latitude, event.longitude, 5));
      if (near.length === 1) facilityId = near[0].id;
      else if (near.length > 1) {
        await this.msg(
          step,
          'intake.facility_options',
          {},
          {
            list: {
              button: await this.t(step, 'btn.choose'),
              rows: near.map((f) => ({
                id: `fac:${f.id}`,
                title: pick(f.name_i18n, step.lang, f.name).slice(0, 24),
                description: `${Math.round(f.distance_km)} km`,
              })),
            },
          },
        );
        step.nextState = 'facility';
        return;
      }
    }
    if (!facilityId && event.kind === 'text' && step.conv.state === 'facility') {
      const byCode = await readTrx((trx) => intakeRepo.facilityByCode(trx, event.text.trim()));
      if (byCode) facilityId = byCode.id;
      else {
        const matches = await readTrx((trx) => intakeRepo.facilitiesByName(trx, event.text.trim()));
        if (matches.length === 1) facilityId = matches[0].id;
        else if (matches.length > 1) {
          await this.msg(
            step,
            'intake.facility_options',
            {},
            {
              list: {
                button: await this.t(step, 'btn.choose'),
                rows: matches.map((f) => ({ id: `fac:${f.id}`, title: pick(f.name_i18n, step.lang, f.name).slice(0, 24) })),
              },
            },
          );
          step.nextState = 'facility';
          return;
        }
      }
    }
    if (!facilityId && step.conv.contact_point_id)
      facilityId = await readTrx((trx) => intakeRepo.recentFacilityForContact(trx, step.conv.contact_point_id));
    if (!facilityId) {
      await this.msg(step, 'intake.ask_facility', {}, { requestLocation: step.channel === 'whatsapp' });
      step.nextState = 'facility';
      return;
    }
    step.convPatch['facility_id'] = facilityId;
    step.conv = { ...step.conv, facility_id: facilityId };
    return this.consent(step, { kind: 'start', facilityCode: null });
  }

  // ---------- consent (§9.2) ----------
  async consent(step, event) {
    const cp = step.conv.contact_point_id;
    const consent = step.data.consent ?? (cp ? await readTrx((trx) => patientsService.consentState(trx, cp, null)) : {});
    if (event.kind === 'choice' && (event.id === 'consent:yes' || event.id === 'consent:no')) {
      const granted = event.id === 'consent:yes';
      consent['care_coordination'] = granted;
      if (cp)
        step.writes.push((trx) =>
          patientsService
            .recordConsent(trx, {
              contactPointId: cp,
              patientId: null,
              purpose: 'care_coordination',
              granted,
              noticeVersion: CONSENT_NOTICE_VERSION,
              language: step.lang,
              channel: step.channel,
              capturedBy: null,
              evidence: {},
            })
            .then(() => undefined),
        );
      if (!granted) {
        await this.msg(step, 'intake.consent_refused');
        step.data.consent = consent;
        step.nextState = 'idle';
        return;
      }
    }
    step.data.consent = consent;
    if (consent['care_coordination'] !== true) {
      await this.msg(
        step,
        'consent.notice',
        {},
        {
          buttons: await this.buttons(step, [
            ['consent:yes', 'btn.yes'],
            ['consent:no', 'btn.no'],
          ]),
        },
      );
      step.nextState = 'consent';
      return;
    }
    if (consent['ai_assisted_intake'] === undefined) {
      const cfg = await getFacilityConfig(step.conv.facility_id);
      if (!cfg.opd.ai_intake_enabled) {
        consent['ai_assisted_intake'] = false;
      } else {
        await this.msg(
          step,
          'consent.ai_notice',
          {},
          {
            buttons: await this.buttons(step, [
              ['consent_ai:yes', 'btn.yes'],
              ['consent_ai:no', 'btn.no'],
            ]),
          },
        );
        step.nextState = 'consent_ai';
        return;
      }
    }
    return this.whoFor(step, { kind: 'start', facilityCode: null });
  }

  async consentAi(step, event) {
    if (event.kind !== 'choice' || !event.id.startsWith('consent_ai:')) return this.consent(step, { kind: 'start', facilityCode: null });
    const granted = event.id === 'consent_ai:yes';
    const cp = step.conv.contact_point_id;
    step.data.consent = { ...(step.data.consent ?? {}), ai_assisted_intake: granted };
    if (cp)
      step.writes.push((trx) =>
        patientsService
          .recordConsent(trx, {
            contactPointId: cp,
            patientId: null,
            purpose: 'ai_assisted_intake',
            granted,
            noticeVersion: CONSENT_NOTICE_VERSION,
            language: step.lang,
            channel: step.channel,
            capturedBy: null,
          })
          .then(() => undefined),
      );
    if (!granted) {
      step.mode = 'structured_fallback';
      await this.msg(step, 'intake.ai_refused_ack');
    }
    return this.whoFor(step, { kind: 'start', facilityCode: null });
  }

  // ---------- who is this visit for (household, D15) ----------
  async whoFor(step, event) {
    const cp = step.conv.contact_point_id;
    if (event.kind === 'choice' && event.id.startsWith('pt:')) {
      const patientId = event.id.slice(3);
      if (patientId === 'new') {
        await this.msg(step, 'intake.ask_name');
        step.data.newPatient = {};
        step.nextState = 'who_for_name';
        return;
      }
      return this.openEncounter(step, patientId);
    }
    const household = cp ? await readTrx((trx) => patientsRepo.householdByContactPointId(trx, cp)) : [];
    if (household.length === 0) {
      await this.msg(step, 'intake.ask_name');
      step.data.newPatient = {};
      step.nextState = 'who_for_name';
      return;
    }
    const rows = household
      .slice(0, 9)
      .map((m) => ({
        id: `pt:${m.id}`,
        title: m.display_name.slice(0, 24),
        description: `${m.sex}, ${ageYears(m.birth_date, m.birth_year)} ${step.lang === 'hi' ? 'साल' : step.lang === 'gu' ? 'વર્ષ' : 'yrs'}`,
      }));
    rows.push({ id: 'pt:new', title: (await this.t(step, 'btn.someone_else')).slice(0, 24) });
    await this.msg(
      step,
      'intake.who_for',
      {},
      rows.length <= 3
        ? { buttons: rows.map((r) => ({ id: r.id, title: r.title.slice(0, 20) })) }
        : { list: { button: await this.t(step, 'btn.choose'), rows } },
    );
    step.nextState = 'who_for';
  }
  async whoForName(step, event) {
    if (event.kind !== 'text' || event.text.trim().length < 2) {
      await this.msg(step, 'intake.ask_name');
      return;
    }
    step.data.newPatient = { ...(step.data.newPatient ?? {}), name: event.text.trim().slice(0, 100) };
    await this.msg(
      step,
      'intake.ask_sex',
      {},
      {
        buttons: await this.buttons(step, [
          ['sex:female', 'btn.female'],
          ['sex:male', 'btn.male'],
          ['sex:other', 'btn.other'],
        ]),
      },
    );
    step.nextState = 'who_for_sex';
  }
  async whoForSex(step, event) {
    const sex =
      event.kind === 'choice' && event.id.startsWith('sex:')
        ? event.id.slice(4)
        : event.kind === 'text'
          ? /^(f|female|mahila|stri|औरत|महिला|સ્ત્રી)/i.test(event.text)
            ? 'female'
            : /^(m|male|purush|aadmi|पुरुष|પુરુષ)/i.test(event.text)
              ? 'male'
              : null
          : null;
    if (!sex) {
      await this.msg(
        step,
        'intake.ask_sex',
        {},
        {
          buttons: await this.buttons(step, [
            ['sex:female', 'btn.female'],
            ['sex:male', 'btn.male'],
            ['sex:other', 'btn.other'],
          ]),
        },
      );
      return;
    }
    step.data.newPatient = { ...(step.data.newPatient ?? {}), sex: sex };
    await this.msg(step, 'intake.ask_age');
    step.nextState = 'who_for_age';
  }
  async whoForAge(step, event) {
    const n = event.kind === 'text' ? parseInt(event.text.replace(/[^\d]/g, ''), 10) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 120) {
      await this.msg(step, 'intake.ask_age');
      return;
    }
    step.data.newPatient = { ...(step.data.newPatient ?? {}), ageYears: n };
    if (!step.conv.contact_point_id) return this.createNewPatient(step, 'self');
    await this.msg(
      step,
      'intake.ask_relationship',
      {},
      {
        list: {
          button: await this.t(step, 'btn.choose'),
          rows: await Promise.all(
            ['self', 'parent', 'child', 'spouse', 'sibling', 'other_family', 'caregiver', 'asha_worker'].map(async (r) => ({
              id: `rel:${r}`,
              title: (await this.t(step, `rel.${r}`)).slice(0, 24),
            })),
          ),
        },
      },
    );
    step.nextState = 'who_for_relationship';
  }
  async whoForRelationship(step, event) {
    const rel = event.kind === 'choice' && event.id.startsWith('rel:') ? event.id.slice(4) : 'other_family';
    return this.createNewPatient(step, rel);
  }
  async createNewPatient(step, relationship) {
    const np = step.data.newPatient;
    const patientId = newId();
    const cfg = await getFacilityConfig(step.conv.facility_id);
    step.writes.push(async (trx) => {
      if (step.conv.contact_point_id)
        await patientsService.createFromIntake(trx, step.conv.contact_point_id, {
          name: np.name,
          sex: np.sex ?? 'unknown',
          ageYears: np.ageYears ?? 0,
          language: step.lang,
          relationship,
          districtCode: cfg.facility.district_code,
        });
      else
        await patientsRepo.insertPatient(trx, {
          id: patientId,
          display_name: np.name,
          name_search: np.name.toLowerCase(),
          sex: np.sex ?? 'unknown',
          birth_year: parseInt(istDate().slice(0, 4), 10) - (np.ageYears ?? 0),
          birth_date_is_estimated: true,
          preferred_language: step.lang,
          district_code: cfg.facility.district_code,
        });
    });
    // createFromIntake generates its own id; re-read by name is fragile, so for linked contacts we insert with a known id instead.
    if (step.conv.contact_point_id) {
      step.writes.pop();
      step.writes.push(async (trx) => {
        await patientsRepo.insertPatient(trx, {
          id: patientId,
          display_name: np.name,
          name_search: np.name.toLowerCase(),
          sex: np.sex ?? 'unknown',
          birth_year: parseInt(istDate().slice(0, 4), 10) - (np.ageYears ?? 0),
          birth_date_is_estimated: true,
          preferred_language: step.lang,
          district_code: cfg.facility.district_code,
        });
        await patientsRepo.linkContact(trx, step.conv.contact_point_id, patientId, relationship, relationship === 'self');
      });
    }
    step.data.newPatient = null;
    return this.openEncounter(step, patientId, { name: np.name, sex: np.sex ?? 'unknown', ageYears: np.ageYears ?? 0 });
  }

  /** Creates the encounter + intake session and asks for the purpose. */
  async openEncounter(step, patientId, basics) {
    const encounterId = newId();
    const facilityId = step.conv.facility_id;
    const p =
      basics ??
      (await readTrx(async (trx) => {
        const r = await patientsRepo.byId(trx, patientId);
        return r ? { name: r.display_name, sex: r.sex, ageYears: ageYears(r.birth_date, r.birth_year) } : null;
      }));
    if (!p) throw new Error('patient not found');
    const summary = basics ? null : await readTrx((trx) => patientsService.clinicalSummary(trx, patientId)).catch(() => null);
    const chronic = summary ? summary.risk_flags.filter((f) => !['age_60_plus', 'under_5'].includes(f)) : [];
    step.facts = { age_years: p.ageYears, sex: p.sex, symptoms: [], chronic, ...(chronic.includes('pregnant') ? { pregnant: true } : {}) };
    const aiAllowed = step.data.consent?.ai_assisted_intake === true;
    step.mode = aiAllowed ? 'ai_assisted' : 'structured_fallback';
    step.writes.push(async (trx) => {
      await queueService.createEncounter(trx, {
        id: encounterId,
        facilityId,
        patientId,
        contactPointId: step.conv.contact_point_id,
        channel: step.channel,
        status: 'intake',
      });
      const s = await intakeRepo.insertSession(trx, {
        encounter_id: encounterId,
        conversation_id: step.conv.id,
        mode: step.mode,
        step: 'purpose',
        facts: step.facts,
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
      });
      step.session = s;
    });
    step.convPatch['active_encounter_id'] = encounterId;
    step.conv = { ...step.conv, active_encounter_id: encounterId };
    await this.msg(
      step,
      'intake.ask_purpose',
      { name: p.name },
      {
        list: {
          button: await this.t(step, 'btn.choose'),
          rows: await Promise.all(
            ['new_problem', 'followup', 'report', 'question', 'emergency'].map(async (k) => ({
              id: `purpose:${k}`,
              title: (await this.t(step, `btn.purpose_${k}`)).slice(0, 24),
            })),
          ),
        },
      },
    );
    step.nextState = 'purpose';
  }

  // ---------- purpose ----------
  async purpose(step, event) {
    const id =
      event.kind === 'choice'
        ? event.id
        : event.kind === 'text'
          ? `purpose:${/emergenc|casualty|108|emergency/i.test(event.text) ? 'emergency' : /report|रिपोर्ट|રિપોર્ટ/i.test(event.text) ? 'report' : /follow|dobara|फिर|ફરી/i.test(event.text) ? 'followup' : /\?|kya|kab|kahan|timing|time|कब|कहाँ|ક્યાં|ક્યારે/i.test(event.text) ? 'question' : 'new_problem'}`
          : '';
    if (!id.startsWith('purpose:')) {
      await this.msg(step, 'intake.ask_purpose');
      return;
    }
    const purpose = id.slice(8);
    step.data.purpose = purpose;
    if (purpose === 'emergency') return this.outcomeEmergency(step, ['patient_declared']);
    if (purpose === 'question') {
      await this.msg(step, 'kb.ask_question');
      step.nextState = 'kb_answer';
      return;
    }
    if (purpose === 'report') {
      const cfg = await getFacilityConfig(step.conv.facility_id);
      await this.msg(step, 'intake.report_collect', { help_desk: cfg.opd.help_desk_phone });
      step.writes.push(async (trx) => {
        await intakeRepo.updateEncounterStatus(trx, step.conv.active_encounter_id, {
          kind: 'info_only',
          status: 'completed',
          closed_at: new Date(),
        });
      });
      step.nextState = 'idle';
      return;
    }
    if (purpose === 'followup')
      step.writes.push(async (trx) => {
        await intakeRepo.updateEncounterStatus(trx, step.conv.active_encounter_id, { kind: 'opd_followup' });
      });
    await this.msg(step, 'intake.ask_complaint');
    step.nextState = 'complaint';
  }

  // ---------- complaint → extraction ----------
  async complaint(step, event) {
    if (event.kind === 'audio') {
      const { asr, LOW_CONFIDENCE } = await import('../../infra/asr/index.js');
      const { getObject } = await import('../../infra/storage.js');
      const audio = await getObject(event.storageKey).catch(() => Buffer.alloc(0));
      const tr = audio.length ? await asr().transcribe(audio, event.mimeType, step.lang) : null;
      if (!tr) return this.extractSystem(step, { kind: 'start', facilityCode: null });
      if (tr.confidence < LOW_CONFIDENCE) {
        step.data.pendingTranscript = tr.text;
        await this.msg(
          step,
          'intake.confirm_transcript',
          { text: tr.text },
          {
            buttons: await this.buttons(step, [
              ['tr:yes', 'btn.yes'],
              ['tr:no', 'btn.no'],
            ]),
          },
        );
        step.nextState = 'complaint_confirm';
        return;
      }
      return this.runExtraction(step, tr.text);
    }
    if (event.kind !== 'text') {
      await this.msg(step, 'intake.ask_complaint');
      return;
    }
    return this.runExtraction(step, event.text);
  }
  async complaintConfirm(step, event) {
    if (event.kind === 'choice' && event.id === 'tr:yes' && step.data.pendingTranscript)
      return this.runExtraction(step, step.data.pendingTranscript);
    step.data.pendingTranscript = null;
    return this.extractSystem(step, { kind: 'start', facilityCode: null });
  }

  async runExtraction(step, text) {
    const norm = normaliseText(text);
    step.facts['complaint_redacted'] = '[complaint]';
    // Deterministic path first: exact synonym hits on word n-grams.
    const words = norm.split(' ');
    const phrases = [];
    for (let n = 1; n <= 4; n++) for (let i = 0; i + n <= words.length; i++) phrases.push(words.slice(i, i + n).join(' '));
    const exact = await readTrx((trx) => intakeRepo.symptomsBySynonyms(trx, phrases));
    const codes = new Set(exact.map((s) => s.code));
    const cfg = await getFacilityConfig(step.conv.facility_id);
    if (step.mode === 'ai_assisted' && cfg.opd.ai_intake_enabled) {
      // Q9 candidates (synonyms + 5 nearest by embedding), then the LLM picks codes from the candidates only.
      let candidates = exact.map((s) => ({ code: s.code, label: s.labels['en'] ?? s.code, red_flag: s.is_red_flag }));
      try {
        const emb = await embedOne(norm);
        const q9 = await readTrx((trx) => intakeRepo.symptomCandidates(trx, norm, toVector(emb)));
        for (const c of q9)
          if (!candidates.some((x) => x.code === c.code))
            candidates.push({ code: c.code, label: c.labels['en'] ?? c.code, red_flag: c.is_red_flag });
      } catch (err) {
        logger.warn({ err }, 'embedding unavailable; using synonym candidates only');
      }
      if (candidates.length === 0) {
        const { symptomsForSystem, bodySystems } = intakeRepo;
        void symptomsForSystem;
        const systems = await readTrx((trx) => bodySystems(trx));
        const sample = await readTrx(async (trx) =>
          (await Promise.all(systems.slice(0, 6).map((s) => intakeRepo.symptomsForSystem(trx, s.body_system)))).flat().slice(0, 30),
        );
        candidates = sample.map((s) => ({ code: s.code, label: s.labels['en'] ?? s.code, red_flag: s.is_red_flag }));
      }
      step.llmCalls++;
      const res = await llm.call({
        purpose: 'intake_extract',
        prompt: extractPromptV1,
        input: deidentify({ complaint: text, language: step.lang, candidates }),
        facilityId: step.conv.facility_id,
        encounterId: step.conv.active_encounter_id,
      });
      if (res.ok) {
        const allowed = new Set(candidates.map((c) => c.code));
        for (const s of res.data.symptoms)
          if (allowed.has(s.code)) {
            // anything outside the candidates is discarded (§10.5)
            codes.add(s.code);
            if (s.duration_hours != null && step.facts['duration_hours'] === undefined) step.facts['duration_hours'] = s.duration_hours;
            if (s.severity) step.facts[`severity_${s.code}`] = s.severity;
          }
        if (res.data.possible_emergency) step.facts['llm_possible_emergency'] = true;
        if (codes.size === 0 && res.data.unmatched_mentions.length) return this.extractSystem(step, { kind: 'start', facilityCode: null });
      } else {
        step.mode = 'structured_fallback'; // provider down / budget / circuit: continue deterministically (§2.1)
      }
    }
    if (codes.size === 0) return this.extractSystem(step, { kind: 'start', facilityCode: null });
    step.facts['symptoms'] = [...codes];
    const dur = parseDuration(norm);
    if (dur !== null && step.facts['duration_hours'] === undefined) step.facts['duration_hours'] = dur;
    return this.clarifyNext(step);
  }

  /** Structured fallback: body-system menu → symptom list (§9.3). */
  async extractSystem(step, event) {
    if (event.kind === 'choice' && event.id.startsWith('sys:')) {
      step.data.bodySystem = event.id.slice(4);
      const symptoms = await readTrx((trx) => intakeRepo.symptomsForSystem(trx, step.data.bodySystem));
      await this.msg(
        step,
        'intake.symptom_menu',
        {},
        {
          list: {
            button: await this.t(step, 'btn.choose'),
            rows: symptoms.map((s) => ({ id: `sym:${s.code}`, title: pick(s.labels, step.lang, s.code).slice(0, 24) })),
          },
        },
      );
      step.nextState = 'extract_symptom';
      return;
    }
    const systems = await readTrx((trx) => intakeRepo.bodySystems(trx));
    await this.msg(
      step,
      'intake.body_system_menu',
      {},
      {
        list: {
          button: await this.t(step, 'btn.choose'),
          rows: await Promise.all(
            systems
              .slice(0, 10)
              .map(async (s) => ({ id: `sys:${s.body_system}`, title: (await this.t(step, `system.${s.body_system}`)).slice(0, 24) })),
          ),
        },
      },
    );
    step.nextState = 'extract_system';
  }
  async extractSymptom(step, event) {
    if (event.kind !== 'choice' || !event.id.startsWith('sym:')) return this.extractSystem(step, { kind: 'start', facilityCode: null });
    const existing = step.facts['symptoms'] ?? [];
    step.facts['symptoms'] = [...new Set([...existing, event.id.slice(4)])];
    return this.clarifyNext(step);
  }

  // ---------- clarify (vetted questions only, D8) ----------
  async clarifyNext(step) {
    const rules = await getPublishedRuleSet();
    const facts = step.facts;
    const ev = evaluate(rules.rules, facts);
    if (ev.level === 'emergency') return this.triage(step);
    if (ev.missingFacts.length === 0 || step.questionsAsked.length >= MAX_QUESTIONS) return this.risk(step);
    const symptoms = step.facts['symptoms'] ?? [];
    const all = await readTrx((trx) => intakeRepo.activeQuestions(trx));
    let candidates = all.filter(
      (q) =>
        (q.applies_to_symptoms.length === 0 || q.applies_to_symptoms.some((s) => symptoms.includes(s))) &&
        !step.questionsAsked.includes(q.code) &&
        ev.missingFacts.includes(q.sets_fact) &&
        step.facts[q.sets_fact] === undefined &&
        (!PREGNANCY_FACTS.has(q.sets_fact) || canBePregnant(step.facts)),
    );
    if (candidates.length === 0) return this.risk(step);
    // 🔒 possible_emergency from the LLM → red-flag questions first (more cautious, never less).
    const redFlagFacts = new Set(['breathless_at_rest', 'chest_pain', 'unconscious_or_confused', 'seizure_now', 'heavy_bleeding']);
    if (step.facts['llm_possible_emergency'] === true) {
      const rf = candidates.filter((q) => redFlagFacts.has(q.sets_fact));
      if (rf.length) candidates = rf;
    }
    let chosen = candidates[0]; // deterministic priority order
    if (step.mode === 'ai_assisted' && candidates.length > 1 && !step.facts['llm_possible_emergency']) {
      step.llmCalls++;
      const res = await llm.call({
        purpose: 'question_select',
        prompt: questionSelectPromptV1,
        input: deidentify({
          symptoms,
          known_facts: publicFacts(step.facts),
          missing_facts: ev.missingFacts,
          candidates: candidates.map((q) => ({ code: q.code, sets_fact: q.sets_fact, prompt: q.prompts['en'] ?? q.code })),
        }),
        facilityId: step.conv.facility_id,
        encounterId: step.conv.active_encounter_id,
      });
      if (res.ok) {
        const pick_ = candidates.find((q) => q.code === res.data.code);
        if (pick_) chosen = pick_;
      }
    }
    step.questionsAsked.push(chosen.code);
    step.data.pendingQuestion = { code: chosen.code, setsFact: chosen.sets_fact, answerType: chosen.answer_type, options: chosen.options };
    const prompt = pick(chosen.prompts, step.lang, chosen.code);
    let extra = {};
    if (chosen.answer_type === 'yes_no')
      extra = {
        buttons: await this.buttons(step, [
          [`q:${chosen.code}:yes`, 'btn.yes'],
          [`q:${chosen.code}:no`, 'btn.no'],
          [`q:${chosen.code}:unknown`, 'btn.dont_know'],
        ]),
      };
    else if ((chosen.answer_type === 'single_choice' || chosen.answer_type === 'multi_choice') && chosen.options.length) {
      const rows = chosen.options
        .slice(0, 10)
        .map((o) => ({ id: `q:${chosen.code}:${o.code}`, title: pick(o.labels, step.lang, o.code).slice(0, 24) }));
      extra =
        rows.length <= 3
          ? { buttons: rows.map((r) => ({ id: r.id, title: r.title.slice(0, 20) })) }
          : { list: { button: await this.t(step, 'btn.choose'), rows } };
    }
    step.messages.push({ templateCode: `question.${chosen.code}`, text: prompt, ...extra });
    step.nextState = 'clarify';
    step.sessionStep = 'clarify';
  }

  async clarifyAnswer(step, event) {
    const q = step.data.pendingQuestion;
    if (!q) return this.clarifyNext(step);
    const value = parseAnswer(q, event);
    if (value === undefined) {
      await this.msg(step, 'intake.invalid_answer');
      step.questionsAsked = step.questionsAsked.filter((c) => c !== q.code);
      return this.clarifyNext(step);
    }
    if (value !== null) step.facts[q.setsFact] = value;
    else step.facts[`${q.setsFact}_unknown`] = true;
    step.data.pendingQuestion = null;
    return this.clarifyNext(step);
  }

  // ---------- risk: pregnancy, chronic, disability ----------
  async risk(step) {
    const age = Number(step.facts['age_years'] ?? 0);
    if (step.facts['sex'] === 'female' && age >= 12 && age <= 50 && step.facts['pregnant'] === undefined) {
      step.data.pendingQuestion = { code: 'RISK_PREGNANT', setsFact: 'pregnant', answerType: 'yes_no' };
      await this.msg(
        step,
        'intake.ask_risk_pregnancy',
        {},
        {
          buttons: await this.buttons(step, [
            ['q:RISK_PREGNANT:yes', 'btn.yes'],
            ['q:RISK_PREGNANT:no', 'btn.no'],
          ]),
        },
      );
      step.nextState = 'risk';
      return;
    }
    if (step.facts['chronic_confirmed'] === undefined) {
      const opts = ['diabetes', 'hypertension', 'asthma_copd', 'heart_disease', 'kidney_disease', 'tb', 'none'];
      step.data.pendingQuestion = {
        code: 'RISK_CHRONIC',
        setsFact: 'chronic_pick',
        answerType: 'single_choice',
        options: opts.map((o) => ({ code: o, labels: {} })),
      };
      const known = step.facts['chronic'] ?? [];
      await this.msg(
        step,
        known.length ? 'intake.ask_chronic_confirm' : 'intake.ask_chronic',
        { known: known.join(', ') },
        {
          list: {
            button: await this.t(step, 'btn.choose'),
            rows: await Promise.all(
              opts.map(async (o) => ({ id: `q:RISK_CHRONIC:${o}`, title: (await this.t(step, `chronic.${o}`)).slice(0, 24) })),
            ),
          },
        },
      );
      step.nextState = 'risk';
      return;
    }
    if (step.facts['disability'] === undefined) {
      step.data.pendingQuestion = { code: 'RISK_DISABILITY', setsFact: 'disability', answerType: 'yes_no' };
      await this.msg(
        step,
        'intake.ask_disability',
        {},
        {
          buttons: await this.buttons(step, [
            ['q:RISK_DISABILITY:yes', 'btn.yes'],
            ['q:RISK_DISABILITY:no', 'btn.no'],
          ]),
        },
      );
      step.nextState = 'risk';
      return;
    }
    return this.triage(step);
  }
  async riskAnswer(step, event) {
    const q = step.data.pendingQuestion;
    if (!q) return this.risk(step);
    const value = parseAnswer(q, event);
    if (value === undefined) {
      await this.msg(step, 'intake.invalid_answer');
      return this.risk(step);
    }
    if (q.code === 'RISK_CHRONIC') {
      const existing = new Set(step.facts['chronic'] ?? []);
      if (value !== 'none' && typeof value === 'string') existing.add(value);
      step.facts['chronic'] = [...existing];
      step.facts['chronic_confirmed'] = true;
    } else if (value !== null) step.facts[q.setsFact] = value;
    else step.facts[q.setsFact] = false;
    step.data.pendingQuestion = null;
    return this.risk(step);
  }

  // ---------- triage + routing + outcome ----------
  async triage(step) {
    const rules = await getPublishedRuleSet();
    const facts = step.facts;
    const ev = evaluate(rules.rules, facts);
    const llmLevel = step.facts['llm_possible_emergency'] === true && ev.level !== 'emergency' ? 'priority' : null;
    const finalLevel = combineLevels(ev.level, llmLevel);
    const cfg = await getFacilityConfig(step.conv.facility_id);
    const symptoms = step.facts['symptoms'] ?? [];
    const catalog = await readTrx((trx) => intakeRepo.symptomsByCodes(trx, symptoms));
    // Routing (§9.4 step 4)
    let specialty = ev.specialty;
    let method = 'rule';
    let confidence = null;
    const open = cfg.departments.filter((d) => d.accepts_routing && !d.is_emergency).map((d) => d.specialty_code);
    if (!specialty && step.mode === 'ai_assisted' && finalLevel !== 'emergency' && open.length) {
      step.llmCalls++;
      const res = await llm.call({
        purpose: 'department_route',
        prompt: routePromptV1,
        input: deidentify({
          symptoms: catalog.map((c) => ({ code: c.code, label: c.labels['en'] ?? c.code })),
          facts: publicFacts(step.facts),
          specialties: open,
        }),
        facilityId: step.conv.facility_id,
        encounterId: step.conv.active_encounter_id,
      });
      if (res.ok && res.data.confidence >= 0.6 && open.includes(res.data.specialty_code)) {
        specialty = res.data.specialty_code;
        method = 'llm';
        confidence = res.data.confidence;
      }
    }
    if (!specialty) {
      const primary = catalog.find((c) => c.code === symptoms[0]);
      if (primary) {
        specialty = primary.default_specialty_code;
        method = 'catalog_default';
      }
    }
    if (!specialty) {
      specialty = 'general_medicine';
      method = 'fallback_default';
    }
    const dept =
      cfg.departments.find((d) => d.specialty_code === specialty && d.accepts_routing && d.status === 'active') ??
      cfg.departments.find((d) => d.specialty_code === 'general_medicine') ??
      cfg.departments.find((d) => d.accepts_routing && !d.is_emergency) ??
      null;
    const redFlags = catalog.filter((c) => c.is_red_flag && symptoms.includes(c.code)).map((c) => c.code);
    const encounterId = step.conv.active_encounter_id;
    const facilityId = step.conv.facility_id;
    const riskFactors = [
      ...(step.facts['chronic'] ?? []),
      ...(step.facts['pregnant'] === true ? ['pregnant'] : []),
      ...(Number(step.facts['age_years']) >= 60 ? ['age_60_plus'] : []),
      ...(Number(step.facts['age_years']) < 5 ? ['under_5'] : []),
    ];
    step.writes.push(async (trx) => {
      await triageRepo.insertAssessment(trx, {
        encounter_id: encounterId,
        facility_id: facilityId,
        rule_set_id: rules.id,
        rule_level: ev.level,
        rules_fired: ev.firedRules,
        llm_level: llmLevel,
        final_level: finalLevel,
        symptoms: symptoms.map((code) => ({
          code,
          severity: step.facts[`severity_${code}`] ?? null,
          duration_hours: step.facts['duration_hours'] ?? null,
        })),
        facts: publicFacts(step.facts),
        red_flags: redFlags,
        risk_factors: riskFactors,
        routed_specialty_code: specialty,
        routed_department_id: finalLevel === 'emergency' ? null : (dept?.id ?? null),
        routing_confidence: confidence,
        routing_method: method,
        mode: step.mode,
      });
      await intakeRepo.updateEncounterStatus(trx, encounterId, {
        status: 'triaged',
        triage_level: finalLevel,
        department_id: finalLevel === 'emergency' ? null : (dept?.id ?? null),
      });
      if (step.session)
        await intakeRepo
          .updateSession(trx, step.session.id, step.session.version, {
            status: 'completed',
            completed_at: new Date(),
            step: `outcome_${finalLevel}`,
            facts: step.facts,
            questions_asked: step.questionsAsked,
            mode: step.mode,
            llm_calls: step.llmCalls,
          })
          .then((r) => {
            if (r) step.session = r;
          });
    });
    triageLevelMetric.inc({ level: finalLevel, routing_method: method });
    intakeSessionsMetric.inc({ channel: step.channel, mode: step.mode, outcome: finalLevel });
    if (finalLevel === 'emergency') return this.outcomeEmergency(step, [...ev.firedRules, ...redFlags], true);
    if (finalLevel === 'self_care') return this.outcomeSelfCare(step, symptoms, dept);
    return this.outcomeOpd(step, dept, finalLevel, cfg);
  }

  async outcomeEmergency(step, matched, assessmentWritten = false) {
    const cfg = await getFacilityConfig(step.conv.facility_id);
    const casualty = cfg.departments.find((d) => d.is_emergency);
    const sp = cfg.servicePoints.find((s) => s.kind === 'emergency_bay');
    const encounterId = step.conv.active_encounter_id;
    if (encounterId) {
      const facts = step.facts;
      step.writes.push(async (trx) => {
        await intakeRepo.updateEncounterStatus(trx, encounterId, {
          status: 'emergency_redirected',
          triage_level: 'emergency',
          kind: 'emergency',
          closed_at: new Date(),
        });
        // 🔒 no direct identifiers in the pre-alert summary
        await queueService.createPrealert(trx, step.conv.facility_id, encounterId, {
          age_band: ageBand(Number(facts['age_years'] ?? 0)),
          sex: facts['sex'] ?? 'unknown',
          complaint_codes: facts['symptoms'] ?? [],
          red_flags: matched,
          channel: step.channel,
        });
        if (step.session && !assessmentWritten)
          await intakeRepo
            .updateSession(trx, step.session.id, step.session.version, {
              status: 'completed',
              completed_at: new Date(),
              step: 'outcome_emergency',
              facts,
              questions_asked: step.questionsAsked,
              mode: step.mode,
              llm_calls: step.llmCalls,
            })
            .then((r) => {
              if (r) step.session = r;
            });
      });
    }
    await this.msg(step, 'triage.emergency_go_now', {
      casualty: casualty ? pick(casualty.name_i18n, step.lang, casualty.name) : 'Casualty',
      where: sp ? pick(sp.wayfinding_i18n, step.lang, sp.label) : '',
    });
    step.convPatch['active_encounter_id'] = null;
    step.nextState = 'idle';
  }

  async outcomeSelfHarm(step) {
    await this.msg(step, 'triage.self_harm'); // Tele-MANAS 14416, emergency 112, go to casualty
    const encounterId = step.conv.active_encounter_id;
    if (encounterId)
      step.writes.push(async (trx) => {
        await queueService.createPrealert(trx, step.conv.facility_id, encounterId, { self_harm: true, channel: step.channel });
      });
    else
      step.writes.push(async (trx) => {
        if (step.conv.facility_id) {
          const e = await queueService.createEncounter(trx, {
            facilityId: step.conv.facility_id,
            patientId: null,
            contactPointId: step.conv.contact_point_id,
            channel: step.channel,
            kind: 'emergency',
            status: 'emergency_redirected',
            triageLevel: 'emergency',
          });
          await queueService.createPrealert(trx, step.conv.facility_id, e.id, { self_harm: true, channel: step.channel });
        }
      });
    step.convPatch['active_encounter_id'] = null;
    step.nextState = 'idle';
  }

  async outcomeSelfCare(step, symptoms, dept) {
    const leaflet = await kbService.leafletFor(step.conv.facility_id, symptoms, step.lang);
    if (leaflet) {
      await this.msg(step, 'outcome.self_care_intro');
      step.messages.push({ templateCode: `leaflet.${leaflet.documentId}`, text: leaflet.text });
    }
    await this.msg(
      step,
      'outcome.self_care_warning',
      {},
      {
        buttons: await this.buttons(step, [
          ['selfcare:book', 'btn.book_anyway'],
          ['selfcare:done', 'btn.done'],
        ]),
      },
    );
    step.data['selfCareDept'] = dept?.id ?? null;
    step.writes.push(async (trx) => {
      await intakeRepo.updateEncounterStatus(trx, step.conv.active_encounter_id, { status: 'self_care_advised' });
    });
    step.nextState = 'outcome_self_care';
  }
  async selfCareAnswer(step, event) {
    if (event.kind === 'choice' && event.id === 'selfcare:book') {
      const cfg = await getFacilityConfig(step.conv.facility_id);
      const dept =
        cfg.departments.find((d) => d.id === step.data['selfCareDept']) ??
        cfg.departments.find((d) => d.specialty_code === 'general_medicine') ??
        null;
      return this.outcomeOpd(step, dept, 'routine', cfg);
    }
    await this.msg(step, 'intake.done');
    step.convPatch['active_encounter_id'] = null;
    step.nextState = 'idle';
  }

  /** Remote booking: reporting window + ETA range + QR check-in code; the token is allocated at physical check-in (§9.5.1). */
  async outcomeOpd(step, dept, level, cfg) {
    const encounterId = step.conv.active_encounter_id;
    if (!dept) {
      await this.msg(step, 'intake.error_counter');
      step.nextState = 'idle';
      return;
    }
    const now = new Date();
    const today = istDate(now);
    const shift = (now.getTime() + 5.5 * 3600_000) % 86_400_000 < 14 * 3600_000 ? 'morning' : 'evening';
    const session = await withScope(STATE_SCOPE, (trx) => queueService.ensureSession(trx, cfg.facility.id, dept.id, today, shift));
    const windowMs = cfg.opd.reporting_window_minutes * 60_000;
    const base = Math.max(now.getTime() + 10 * 60_000, session.starts_at.getTime());
    const windowStart = new Date(Math.ceil(base / windowMs) * windowMs);
    const windowEnd = new Date(windowStart.getTime() + windowMs);
    step.facts['reporting_window_start'] = windowStart.toISOString();
    const board = await waitboard(cfg.facility.id).catch(() => ({ departments: [] }));
    const eta = board.departments.find((d) => d.department_id === dept.id)?.eta ?? {
      min_minutes: 0,
      max_minutes: roundTo5Minutes(cfg.opd.default_eta_seconds * 3),
      doctor_unavailable: false,
    };
    const room = roomLabel(
      cfg,
      cfg.servicePoints.find((s) => s.department_id === dept.id && s.kind === 'consult_room')?.id ?? null,
      step.lang,
    );
    step.writes.push(async (trx) => {
      await intakeRepo.updateEncounterStatus(trx, encounterId, { status: 'booked', department_id: dept.id, triage_level: level });
      const s = step.session ?? (await intakeRepo.sessionByEncounter(trx, encounterId));
      if (s)
        await intakeRepo
          .updateSession(trx, s.id, s.version, {
            facts: step.facts,
            status: 'completed',
            completed_at: s.completed_at ?? new Date(),
            step: 'outcome_opd',
          })
          .then((r) => {
            if (r) step.session = r;
          });
    });
    const fmt = (d) => new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(d);
    await this.msg(
      step,
      'outcome.opd_booking',
      {
        department: pick(dept.name_i18n, step.lang, dept.name),
        room,
        window_start: fmt(windowStart),
        window_end: fmt(windowEnd),
        eta_min: eta.min_minutes,
        eta_max: eta.max_minutes,
        checkin_code: encounterId,
        facility: pick(cfg.facility.name_i18n, step.lang, cfg.facility.name),
        lane_note: level === 'priority' ? await this.t(step, 'outcome.priority_lane_note') : '',
      },
      { link: `sahayak:enc:${encounterId}` },
    );
    step.convPatch['active_encounter_id'] = null;
    step.nextState = 'idle';
  }

  // ---------- knowledge bot ----------
  async kbAnswer(step, event) {
    if (event.kind !== 'text') {
      await this.msg(step, 'kb.ask_question');
      return;
    }
    const ans = await kbService.ask({
      question: event.text,
      facilityId: step.conv.facility_id,
      language: step.lang,
      channel: step.channel,
    });
    step.messages.push({ templateCode: ans.templateCode ?? 'kb.answer', text: ans.answer });
    await this.msg(
      step,
      'kb.answer_followup',
      {},
      {
        buttons: await this.buttons(step, [
          ['kb:another', 'btn.ask_another'],
          ['kb:intake', 'btn.start_intake'],
          ['kb:done', 'btn.done'],
        ]),
      },
    );
    step.nextState = 'kb_followup';
  }
  async kbFollowup(step, event) {
    if (event.kind === 'choice' && event.id === 'kb:intake') {
      await this.msg(step, 'intake.ask_complaint');
      step.nextState = 'complaint';
      return;
    }
    if (event.kind === 'choice' && event.id === 'kb:done') {
      await this.msg(step, 'intake.done');
      step.nextState = step.conv.active_encounter_id ? 'purpose' : 'idle';
      return;
    }
    if (event.kind === 'text') return this.kbAnswer(step, event);
    await this.msg(step, 'kb.ask_question');
    step.nextState = 'kb_answer';
  }

  // ---------- follow-up check-in replies ----------
  async handleFollowupButton(step, id) {
    const [, encounterId, followupId, answer] = id.split(':');
    if (!encounterId || !followupId || !answer) return;
    if (answer === 'worse') {
      step.data['pendingFollowup'] = { encounterId, followupId };
      await this.msg(step, 'followup.worse_describe');
      step.nextState = 'followup_checkin';
      return;
    }
    const res = await followupsService.respond(encounterId, followupId, answer);
    await this.msg(
      step,
      res.outcome === 'closed' ? 'followup.thanks_better' : 'followup.offer_revisit',
      {},
      res.outcome === 'offer_revisit'
        ? {
            buttons: await this.buttons(step, [
              ['kb:intake', 'btn.start_intake'],
              ['kb:done', 'btn.done'],
            ]),
          }
        : {},
    );
    step.nextState = res.outcome === 'offer_revisit' ? 'kb_followup' : 'idle';
  }
  async handleFollowupText(step, text) {
    const pf = step.data['pendingFollowup'];
    if (!pf) {
      step.nextState = 'idle';
      return;
    }
    const res = await followupsService.respond(pf.encounterId, pf.followupId, 'worse', text);
    step.data['pendingFollowup'] = null;
    if (res.outcome === 'emergency') return this.outcomeEmergency(step, ['followup_worse']);
    await this.msg(step, 'followup.priority_booked');
    step.nextState = 'idle';
  }
}

/** Facts safe to persist/send: the complaint text itself is never stored in facts. */
export function publicFacts(facts) {
  const out = {};
  for (const [k, v] of Object.entries(facts)) if (!['complaint_redacted', 'reporting_window_start'].includes(k)) out[k] = v;
  return out;
}

/** "3 din se", "2 days", "1 hafte", "5 ghante", "2 mahine" → hours. */
export function parseDuration(norm) {
  const m = norm.match(
    /(\d+)\s*(din|day|days|dino|दिन|દિવસ|hafte|hafta|week|weeks|सप्ताह|हफ्ते|અઠવાડિય|ghante|ghanta|hour|hours|घंटे|કલાક|mahine|mahina|month|months|महीने|મહિન|saal|year|years|साल|વર્ષ)/,
  );
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u = m[2];
  if (/din|day|दिन|દિવસ/.test(u)) return n * 24;
  if (/haft|week|सप्ताह|हफ्ते|અઠવાડિય/.test(u)) return n * 24 * 7;
  if (/ghant|hour|घंटे|કલાક/.test(u)) return n;
  if (/mahin|month|महीने|મહિન/.test(u)) return n * 24 * 30;
  if (/saal|year|साल|વર્ષ/.test(u)) return n * 24 * 365;
  return null;
}

/** Parse an answer to a vetted question. undefined = invalid, null = "don't know". */
export function parseAnswer(q, event) {
  if (event.kind === 'choice') {
    const prefix = `q:${q.code}:`;
    if (!event.id.startsWith(prefix)) return undefined;
    const v = event.id.slice(prefix.length);
    if (q.answerType === 'yes_no') return v === 'yes' ? true : v === 'no' ? false : null;
    return v;
  }
  if (event.kind !== 'text') return undefined;
  const t = normaliseText(event.text);
  switch (q.answerType) {
    case 'yes_no':
      if (/^(yes|y|haan|ha|han|ji|हाँ|हां|હા)(?:\s|$)/.test(t)) return true;
      if (/^(no|n|nahi|nahin|na|नहीं|ना|ના|નહીં)(?:\s|$)/.test(t)) return false;
      if (/pata nahi|don.?t know|नहीं पता|ખબર નથી/.test(t)) return null;
      return undefined;
    case 'number': {
      const n = parseFloat(t.replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'duration': {
      const h = parseDuration(t);
      if (h !== null) return h;
      const n = parseFloat(t.replace(/[^\d.]/g, ''));
      return Number.isFinite(n) ? n * 24 : undefined;
    }
    case 'single_choice':
    case 'multi_choice': {
      const opt = q.options?.find((o) => o.code === t || Object.values(o.labels).some((l) => normaliseText(l) === t));
      return opt ? opt.code : undefined;
    }
    default:
      return event.text.slice(0, 500);
  }
}

export const intakeEngine = new IntakeEngine();
