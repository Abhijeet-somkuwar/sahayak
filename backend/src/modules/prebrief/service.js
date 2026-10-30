/**
 * Doctor pre-brief (§9.6). 🔒 The deterministic block is rendered by code from SQL rows; the narrative comes from the
 * smart model over a de-identified context and is validated before storing. Never shown to the patient.
 */
import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { cacheGet, cacheSet } from '../../infra/cache.js';
import { keys } from '../../infra/redis.js';
import { sha256 } from '../../infra/crypto.js';
import { deidentify, llm, promptVersion } from '../../infra/llm/index.js';
import { modelFor } from '../../infra/llm/routing.js';
import { boundaryMonthsAgo } from '../../shared/ids.js';
import { ageBand, ageYears, relativePhrase } from '../../shared/time.js';
import { AppError } from '../../shared/errors.js';
import { getFacilityConfig } from '../facilities/service.js';
import { patientsService } from '../patients/service.js';
import { publishRealtime } from '../realtime/events.js';
import { prebriefRepo } from './repo.js';
import { prebriefPromptV2 } from './prompts/prebrief.v2.js';
import { enqueuePrebrief } from './jobs.js';

const DRUG_SUFFIX =
  /\b[a-z]{3,}(?:cillin|mycin|cycline|floxacin|azole|pril|sartan|olol|statin|formin|gliptin|zepam|azepam|dipine|prazole|tidine|setron|triptan|mab|nib|vir|ine|one|ide|ol|in)\b/gi;
const COMMON_DRUGS = [
  'paracetamol',
  'acetaminophen',
  'ibuprofen',
  'diclofenac',
  'aspirin',
  'metformin',
  'glimepiride',
  'insulin',
  'amlodipine',
  'atenolol',
  'losartan',
  'telmisartan',
  'enalapril',
  'ramipril',
  'atorvastatin',
  'rosuvastatin',
  'omeprazole',
  'pantoprazole',
  'ranitidine',
  'domperidone',
  'ondansetron',
  'amoxicillin',
  'azithromycin',
  'ciprofloxacin',
  'metronidazole',
  'cefixime',
  'doxycycline',
  'salbutamol',
  'prednisolone',
  'cetirizine',
  'levothyroxine',
  'warfarin',
  'clopidogrel',
  'penicillin',
  'sulfa',
  'sulphonamide',
  'nsaid',
  'morphine',
  'tramadol',
  'ors',
  'iron',
  'folic acid',
  'calcium',
  'vitamin',
];

/**
 * Drop narrative content that mentions a drug/allergen absent from the context; enforce caps and valid refs.
 * Key points must cite at least one known ref ("today" counts); considerations keep only known refs.
 */
export function validateNarrative(out, ctx) {
  const refs = new Set(['today', ...[...ctx.allergies, ...ctx.active_medications, ...ctx.chronic_conditions, ...ctx.recent_visits].map((x) => x.ref)]);
  const dictionary = [
    ...ctx.allergies.map((a) => a.substance),
    ...ctx.active_medications.map((m) => m.drug),
    ...ctx.chronic_conditions.map((c) => c.text),
    ...ctx.recent_visits.flatMap((v) => [...v.diagnoses, ...v.prescriptions]),
    ...ctx.today.complaint_labels,
  ]
    .join(' \n ')
    .toLowerCase();
  const mentionsUnknownDrug = (text) => {
    const lower = text.toLowerCase();
    for (const d of COMMON_DRUGS) if (new RegExp(`\\b${d}\\b`).test(lower) && !dictionary.includes(d)) return true;
    for (const m of lower.matchAll(DRUG_SUFFIX)) {
      const w = m[0];
      if (COMMON_DRUGS.includes(w) && !dictionary.includes(w)) return true;
    }
    return false;
  };
  const key_points = (out.key_points ?? [])
    .map((p) => ({ text: String(p.text ?? '').slice(0, 300), source_refs: p.source_refs ?? [] }))
    .filter((p) => p.text && p.source_refs.length > 0 && p.source_refs.every((r) => refs.has(r)))
    .filter((p) => !mentionsUnknownDrug(p.text))
    .slice(0, 5);
  const headline = mentionsUnknownDrug(out.headline ?? '') ? '' : String(out.headline ?? '').slice(0, 240);
  const history = String(out.history_summary ?? '').trim();
  const history_summary = ctx.recent_visits.length === 0 || mentionsUnknownDrug(history) ? '' : history.slice(0, 600);
  const considerations = (out.considerations ?? [])
    .map((c) => ({
      condition: String(c.condition ?? '').slice(0, 80),
      reasoning: String(c.reasoning ?? '').slice(0, 240),
      source_refs: (c.source_refs ?? []).filter((r) => refs.has(r)),
    }))
    .filter((c) => c.condition && !mentionsUnknownDrug(`${c.condition} ${c.reasoning}`))
    .slice(0, 3);
  return {
    headline,
    history_summary,
    key_points,
    considerations,
    questions_to_consider: (out.questions_to_consider ?? []).filter((q) => !mentionsUnknownDrug(q)).slice(0, 3),
  };
}

export const prebriefService = {
  async cached(encounterId) {
    const hit = await cacheGet(keys.prebrief(encounterId), { phi: true });
    if (hit) return hit;
    const row = await withScope(STATE_SCOPE, (trx) => prebriefRepo.latest(trx, encounterId));
    return row ? { ...row.content, prebrief_id: row.id } : null;
  },

  /** Context assembly (§9.6): 3 queries, no vector search — summary row, Q6 (inside the summary), today's triage + observations. */
  async assemble(trx, encounterId) {
    const e = await prebriefRepo.encounterContext(trx, encounterId);
    if (!e || !e.patient_id) throw AppError.notFound('encounter with patient');
    const [summary, triage, observations, names] = await Promise.all([
      patientsService.clinicalSummary(trx, e.patient_id),
      prebriefRepo.triage(trx, encounterId),
      prebriefRepo.observations(trx, encounterId),
      prebriefRepo.householdNames(trx, e.patient_id),
    ]);
    const complaintCodes = (triage?.symptoms ?? []).map((s) => s.code);
    const pastCodes = summary.recent_encounters.flatMap((v) => v.complaint_codes ?? []);
    const allLabels = await prebriefRepo.symptomLabels(trx, [...new Set([...complaintCodes, ...pastCodes])]);
    const labelOf = (code) => allLabels.find((l) => l.code === code)?.labels['en'] ?? String(code).replace(/^SYM_/, '').replace(/_/g, ' ').toLowerCase();
    const labels = complaintCodes.map((code) => ({ code, labels: { en: labelOf(code) } }));
    const facilityIds = [...new Set(summary.recent_encounters.map((v) => v.facility_id))];
    const [facilities, departments] = await Promise.all([
      prebriefRepo.facilitiesByIds(trx, facilityIds),
      prebriefRepo.departmentsByIds(
        trx,
        summary.recent_encounters.map((v) => v.department_id).filter((d) => !!d),
      ),
    ]);
    const facts = triage?.facts ?? {};
    const age = ageYears(e.birth_date, e.birth_year);
    // the current encounter is never part of its own history
    const recent = summary.recent_encounters.filter((v) => v.id !== encounterId).map((v) => {
      const f = facilities.find((x) => x.id === v.facility_id);
      const where =
        v.facility_id === e.facility_id
          ? 'this hospital'
          : f
            ? `${f.kind.replace(/_/g, ' ')}, district ${f.district_code}`
            : 'another facility';
      return {
        ref: `enc:${v.id}`,
        when: relativePhrase(new Date(`${v.date}T00:00:00Z`)),
        where,
        department: departments.find((d) => d.id === v.department_id)?.name ?? null,
        triage_level: v.triage_level,
        complaint: (v.complaint_codes ?? []).map(labelOf),
        diagnoses: v.diagnoses.map((d) => d.text),
        prescriptions: v.prescriptions.map((p) => `${p.drug} ${p.dose} ${p.frequency}${p.days ? ` × ${p.days}d` : ''}`),
      };
    });
    const ctx = {
      patient: { age_band: ageBand(age), sex: e.sex ?? 'unknown' },
      today: {
        ref: 'today',
        complaint_codes: complaintCodes,
        complaint_labels: labels.map((l) => l.labels['en'] ?? l.code),
        duration_hours: typeof facts['duration_hours'] === 'number' ? facts['duration_hours'] : null,
        triage_level: triage?.final_level ?? e.triage_level,
        red_flags: triage?.red_flags ?? [],
        vitals: observations.map((o) => ({
          code: o.code,
          value: o.value_num !== null ? Number(o.value_num) : (o.value_text ?? ''),
          unit: o.unit,
        })),
      },
      allergies: summary.allergies.map((a, i) => ({
        ref: `allergy:${i}`,
        substance: a.substance,
        reaction: a.reaction,
        severity: a.severity,
      })),
      active_medications: summary.active_medications.map((m, i) => ({
        ref: `rx:${i}`,
        drug: m.drug,
        dose: m.dose,
        frequency: m.frequency,
      })),
      chronic_conditions: summary.active_conditions.filter((c) => c.is_chronic).map((c, i) => ({ ref: `cond:${i}`, text: c.text })),
      risk_flags: summary.risk_flags,
      recent_visits: recent,
    };
    const content = {
      patient: ctx.patient,
      today: {
        complaint_codes: complaintCodes,
        complaint_labels: ctx.today.complaint_labels,
        duration_hours: ctx.today.duration_hours,
        triage_level: ctx.today.triage_level,
        red_flags: ctx.today.red_flags,
        vitals: ctx.today.vitals,
      },
      allergies: summary.allergies,
      active_medications: summary.active_medications.map((m) => ({ drug: m.drug, dose: m.dose, frequency: m.frequency })),
      chronic_conditions: ctx.chronic_conditions.map((c) => c.text),
      risk_flags: summary.risk_flags,
      recent_visits: recent.map(({ ref, when, where, department, complaint, diagnoses, prescriptions }) => ({
        ref,
        when,
        where,
        department,
        complaint,
        diagnoses,
        prescriptions,
      })),
    };
    return {
      ctx,
      content,
      knownNames: [e.display_name ?? '', ...names.map((n) => n.display_name)].filter(Boolean),
      facilityId: e.facility_id,
      doctorId: e.doctor_user_id,
      patientId: e.patient_id,
    };
  },

  /** Generate, validate, store, cache and push (§9.6 rules 1–5). Always produces something (fallback). */
  async generate(encounterId) {
    const started = Date.now();
    const a = await withScope(STATE_SCOPE, (trx) => this.assemble(trx, encounterId));
    const cfg = await getFacilityConfig(a.facilityId);
    let narrative = null;
    let status = 'fallback';
    let model = null;
    const pv = promptVersion(prebriefPromptV2);
    if (cfg.opd.prebrief_ai_enabled) {
      const input = deidentify(a.ctx, { knownNames: a.knownNames });
      const res = await llm.call({ purpose: 'prebrief', prompt: prebriefPromptV2, input, facilityId: a.facilityId, encounterId });
      if (res.ok) {
        narrative = validateNarrative(res.data, a.ctx);
        status = 'ready';
        // eslint-disable-next-line no-constant-condition -- kept as in the original source
        model = modelFor('prebrief' === 'prebrief' ? 'smart' : 'fast');
      }
    }
    const content = {
      deterministic: a.content,
      narrative,
      generated_by: { model, prompt_version: narrative ? pv : null, ai: !!narrative },
      status,
      encounter_id: encounterId,
    };
    const row = await withScope(STATE_SCOPE, (trx) =>
      prebriefRepo.insert(trx, {
        encounter_id: encounterId,
        facility_id: a.facilityId,
        status,
        content,
        model,
        prompt_version: narrative ? pv : null,
        input_digest: sha256(JSON.stringify(a.ctx)),
        latency_ms: Date.now() - started,
      }),
    );
    content.prebrief_id = row.id;
    await cacheSet(keys.prebrief(encounterId), content, { ttlSeconds: 12 * 3600, phi: true });
    const rooms = [];
    if (a.doctorId) rooms.push({ kind: 'doctor', id: a.doctorId });
    if (rooms.length) await publishRealtime({ event: 'prebrief.ready', rooms, payload: { encounter_id: encounterId, status } });
    return content;
  },

  /** Ask the worker for a fresh pre-brief (the doctor's "Try again"); prebrief.ready follows. */
  async regenerate(encounterId) {
    await enqueuePrebrief(encounterId, 0, `regen-${Date.now()}`);
  },

  async view(trx, encounterId, userId) {
    const row = await prebriefRepo.latest(trx, encounterId);
    if (!row) throw AppError.notFound('prebrief (not generated yet)');
    await prebriefRepo.markViewed(trx, encounterId, row.id, userId);
    return { ...row.content, prebrief_id: row.id };
  },

  async feedback(trx, encounterId, feedback, note) {
    const row = await prebriefRepo.latest(trx, encounterId);
    if (!row) throw AppError.notFound('prebrief');
    return prebriefRepo.feedback(trx, encounterId, row.id, feedback, note);
  },

  weeklyDownvotes: (trx) => prebriefRepo.downvotesSince(trx, boundaryMonthsAgo(0, new Date(Date.now() - 7 * 86_400_000))),
};
