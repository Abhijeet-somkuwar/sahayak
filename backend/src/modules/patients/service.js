import { withScope, STATE_SCOPE } from '../../infra/db.js';
import { blindIndex, decryptText, encrypt } from '../../infra/crypto.js';
import { cacheGet, cacheSet } from '../../infra/cache.js';
import { keys } from '../../infra/redis.js';

import { AppError } from '../../shared/errors.js';
import { boundaryMonthsAgo, newId } from '../../shared/ids.js';
import { ageYears, istDate } from '../../shared/time.js';
import { maskPhone, nameSearchKey, normaliseAbha, normalisePhone } from '../../shared/phone.js';
import { writeOutbox } from '../../shared/outbox.js';
import { toJson } from '../../infra/db.types.js';
import { patientsRepo } from './repo.js';

const CHRONIC_FLAGS = {
  diabetes: /diabet|madhumeh|sugar/i,
  hypertension: /hypertens|blood pressure|\bbp\b|high bp/i,
  ckd: /kidney|renal|ckd/i,
  copd: /copd|asthma|bronch/i,
  heart_disease: /heart|cardiac|ihd|cad\b/i,
  tb: /tubercul|\btb\b/i,
  epilepsy: /epilep|seizure|fits/i,
  pregnant: /pregnan|garbh/i,
  hiv: /\bhiv\b/i,
  thyroid: /thyroid/i,
};

export function riskFlagsFrom(age, conditions) {
  const flags = new Set();
  if (age >= 60) flags.add('age_60_plus');
  if (age < 5) flags.add('under_5');
  for (const c of conditions)
    for (const [flag, re] of Object.entries(CHRONIC_FLAGS)) if (re.test(c.display_text) || (c.code && re.test(c.code))) flags.add(flag);
  return [...flags].sort();
}

export const patientsService = {
  async findOrCreateContactPoint(phoneE164, opts = {}) {
    const hash = blindIndex('phone', phoneE164);
    return withScope(STATE_SCOPE, async (trx) => {
      const existing = await patientsRepo.contactPointByHash(trx, hash);
      if (existing) {
        if (opts.verified && !existing.verified_at) await patientsRepo.markVerified(trx, existing.id);
        return existing;
      }
      const enc = encrypt('pii', phoneE164);
      return patientsRepo.insertContactPoint(trx, {
        value_hash: hash,
        value_enc: enc.ciphertext,
        key_version: enc.keyVersion,
        verified_at: opts.verified ? new Date() : null,
      });
    });
  },

  async contactPointPhone(trx, contactPointId) {
    const cp = await patientsRepo.contactPointById(trx, contactPointId);
    return cp ? decryptText('pii', cp.value_enc) : null;
  },

  /** Q1 by raw phone. */
  async householdByPhone(trx, rawPhone) {
    return patientsRepo.household(trx, blindIndex('phone', normalisePhone(rawPhone)));
  },

  async search(trx, q) {
    if (q.phone) return { kind: 'household', items: await this.householdByPhone(trx, q.phone) };
    if (q.abha)
      return {
        kind: 'abha',
        items: await patientsRepo.byIdentifier(trx, 'abha_number', blindIndex('abha_number', normaliseAbha(q.abha)), null),
      };
    if (q.mrn && q.facility_id)
      return {
        kind: 'mrn',
        items: await patientsRepo.byIdentifier(trx, 'facility_mrn', blindIndex('facility_mrn', q.mrn.trim().toUpperCase()), q.facility_id),
      };
    if (q.name && q.district && q.birth_year)
      return { kind: 'fuzzy', items: await patientsRepo.fuzzySearch(trx, nameSearchKey(q.name), q.district, q.birth_year) };
    throw AppError.validation('provide phone, abha, mrn+facility_id, or name+district+birth_year');
  },

  /** Counter registration: duplicate check (Q1 + Q3) → 409 possible_duplicates unless force. */
  async create(trx, input, createdBy) {
    const birthYear = input.birth_date
      ? parseInt(input.birth_date.slice(0, 4), 10)
      : parseInt(istDate().slice(0, 4), 10) - (input.age_years ?? 0);
    if (!input.force) {
      const candidates = [];
      if (input.phone) {
        const hh = await this.householdByPhone(trx, input.phone);
        candidates.push(...hh.filter((m) => nameSearchKey(m.display_name) === nameSearchKey(input.display_name)));
      }
      if (input.district_code) {
        const fz = await patientsRepo.fuzzySearch(trx, nameSearchKey(input.display_name), input.district_code, birthYear);
        candidates.push(...fz.filter((c) => c.score >= 0.6));
      }
      if (candidates.length > 0)
        throw new AppError('possible_duplicates', 'possible duplicate patients found; review and retry with force=true', { candidates });
    }
    const address = input.address ? encrypt('pii', input.address) : null;
    const patient = await patientsRepo.insertPatient(trx, {
      display_name: input.display_name.trim(),
      name_search: nameSearchKey(input.display_name),
      sex: input.sex,
      birth_date: input.birth_date ?? null,
      birth_year: birthYear,
      birth_date_is_estimated: !input.birth_date,
      preferred_language: input.preferred_language,
      district_code: input.district_code ?? null,
      pincode: input.pincode ?? null,
      address_enc: address?.ciphertext ?? null,
      key_version: address?.keyVersion ?? null,
    });
    if (input.phone) {
      const phone = normalisePhone(input.phone);
      const hash = blindIndex('phone', phone);
      let cp = await patientsRepo.contactPointByHash(trx, hash);
      if (!cp) {
        const enc = encrypt('pii', phone);
        cp = await patientsRepo.insertContactPoint(trx, {
          value_hash: hash,
          value_enc: enc.ciphertext,
          key_version: enc.keyVersion,
          verified_at: null,
        });
      }
      await patientsRepo.linkContact(trx, cp.id, patient.id, input.relationship, input.relationship === 'self');
    }
    if (input.abha_number) {
      const abha = normaliseAbha(input.abha_number);
      const enc = encrypt('pii', abha);
      await patientsRepo.insertIdentifier(trx, {
        patient_id: patient.id,
        kind: 'abha_number',
        facility_id: null,
        value_hash: blindIndex('abha_number', abha),
        value_enc: enc.ciphertext,
        key_version: enc.keyVersion,
        verified_at: null,
      });
      await patientsRepo.updatePatient(trx, patient.id, patient.version, { abha_linked: true });
    }
    if (input.facility_mrn && createdBy) {
      // facility id is resolved by the route (staff's facility) and passed through input.facility_mrn as 'FACILITY|MRN'
      const [facilityId, mrn] = input.facility_mrn.split('|');
      if (facilityId && mrn) {
        const enc = encrypt('pii', mrn);
        await patientsRepo.insertIdentifier(trx, {
          patient_id: patient.id,
          kind: 'facility_mrn',
          facility_id: facilityId,
          value_hash: blindIndex('facility_mrn', mrn.trim().toUpperCase()),
          value_enc: enc.ciphertext,
          key_version: enc.keyVersion,
          verified_at: new Date(),
        });
      }
    }
    return patient;
  },

  /** Intake "someone else": create a minimal patient linked to the contact point. */
  async createFromIntake(trx, contactPointId, data) {
    const patient = await patientsRepo.insertPatient(trx, {
      display_name: data.name.trim(),
      name_search: nameSearchKey(data.name),
      sex: data.sex,
      birth_year: parseInt(istDate().slice(0, 4), 10) - data.ageYears,
      birth_date_is_estimated: true,
      preferred_language: data.language,
      district_code: data.districtCode ?? null,
    });
    await patientsRepo.linkContact(trx, contactPointId, patient.id, data.relationship, data.relationship === 'self');
    return patient;
  },

  async linkContact(trx, patientId, input) {
    const cp = await this.findOrCreateContactPoint(normalisePhone(input.phone));
    await patientsRepo.linkContact(trx, cp.id, patientId, input.relationship, input.is_primary);
  },

  async demographics(trx, patientId) {
    const p = await patientsRepo.byId(trx, patientId);
    if (!p) throw AppError.notFound('patient');
    const contacts = await patientsRepo.contactsOfPatient(trx, patientId);
    const identifiers = await patientsRepo.identifiersOf(trx, patientId);
    return {
      id: p.id,
      display_name: p.display_name,
      sex: p.sex,
      birth_date: p.birth_date,
      birth_year: p.birth_year,
      birth_date_is_estimated: p.birth_date_is_estimated,
      age_years: ageYears(p.birth_date, p.birth_year),
      preferred_language: p.preferred_language,
      district_code: p.district_code,
      pincode: p.pincode,
      address: p.address_enc ? decryptText('pii', p.address_enc) : null,
      abha_linked: p.abha_linked,
      merged_into_id: p.merged_into_id,
      status: p.status,
      version: p.version,
      contacts: contacts.map((c) => ({
        contact_point_id: c.id,
        phone_masked: maskPhone(decryptText('pii', c.value_enc)),
        relationship: c.relationship,
        is_primary: c.is_primary,
        whatsapp_capable: c.whatsapp_capable,
      })),
      identifiers: identifiers.map((i) => ({ kind: i.kind, facility_id: i.facility_id, verified: !!i.verified_at })),
    };
  },

  // ---- consent ----
  async recordConsent(trx, input) {
    return patientsRepo.insertConsent(trx, {
      contact_point_id: input.contactPointId,
      patient_id: input.patientId,
      purpose: input.purpose,
      granted: input.granted,
      notice_version: input.noticeVersion,
      language: input.language,
      channel: input.channel,
      captured_by: input.capturedBy,
      evidence: toJson(input.evidence ?? {}),
    });
  },
  async consentState(trx, contactPointId, patientId) {
    const rows = await patientsRepo.currentConsents(trx, contactPointId, patientId);
    const householdRows = patientId ? await patientsRepo.currentConsents(trx, contactPointId, null) : [];
    const state = {};
    for (const r of householdRows) state[r.purpose] = r.granted; // contact-level consent applies to the household
    for (const r of rows) state[r.purpose] = r.granted; // patient-specific rows override
    return state;
  },

  // ---- clinical facts (write an outbox event so the summary is rebuilt) ----
  async addAllergy(trx, patientId, input, recordedBy, source = 'clinician_recorded') {
    const row = await patientsRepo.insertAllergy(trx, { patient_id: patientId, ...input, source, recorded_by: recordedBy });
    await writeOutbox(trx, { aggregateType: 'patient', aggregateId: patientId, eventType: 'allergy.changed', payload: { patientId } });
    return row;
  },
  async addCondition(trx, patientId, input, recordedBy, source = 'clinician_recorded') {
    const row = await patientsRepo.insertCondition(trx, { patient_id: patientId, ...input, source, recorded_by: recordedBy });
    await writeOutbox(trx, { aggregateType: 'patient', aggregateId: patientId, eventType: 'condition.changed', payload: { patientId } });
    return row;
  },

  /** Clinical summary read model: cache pt:summary:<patientId>:<sourceVersion>, 15 min, encrypted. */
  async clinicalSummary(trx, patientId) {
    let row = await patientsRepo.summary(trx, patientId);
    if (!row) {
      await this.rebuildSummary(trx, patientId);
      row = await patientsRepo.summary(trx, patientId);
    }
    if (!row) throw AppError.notFound('patient');
    const key = keys.ptSummary(patientId, row.source_version);
    const hit = await cacheGet(key, { phi: true });
    if (hit) return hit;
    const summary = {
      patient_id: patientId,
      allergies: row.allergies,
      active_conditions: row.active_conditions,
      active_medications: row.active_medications,
      recent_encounters: row.recent_encounters,
      risk_flags: row.risk_flags,
      last_encounter_at: row.last_encounter_at?.toISOString() ?? null,
      source_version: Number(row.source_version),
    };
    await cacheSet(key, summary, { ttlSeconds: 900, phi: true });
    return summary;
  },

  /** Rebuild from SQL (D9): allergies and medicines come from rows, never from similarity search. */
  async rebuildSummary(trx, patientId) {
    const p = await patientsRepo.byId(trx, patientId);
    if (!p) throw AppError.notFound('patient');
    const [allergies, conditions, meds, visits] = await Promise.all([
      patientsRepo.activeAllergies(trx, patientId),
      patientsRepo.activeConditions(trx, patientId),
      patientsRepo.activeMedications(trx, patientId, boundaryMonthsAgo(12)),
      patientsRepo.recentVisits(trx, patientId, boundaryMonthsAgo(24), 10),
    ]);
    const age = ageYears(p.birth_date, p.birth_year);
    const version = await patientsRepo.upsertSummary(trx, patientId, {
      allergies: allergies.map((a) => ({ substance: a.substance_text, reaction: a.reaction, severity: a.severity })),
      active_conditions: conditions.map((c) => ({ text: c.display_text, code: c.code, is_chronic: c.is_chronic })),
      active_medications: meds.map((m) => ({
        drug: m.strength ? `${m.drug_name} ${m.strength}` : m.drug_name,
        dose: m.dose,
        frequency: m.frequency,
        days: m.duration_days,
        since: m.created_at.toISOString().slice(0, 10),
      })),
      recent_encounters: visits.map((v) => ({
        id: v.id,
        date: v.session_date,
        facility_id: v.facility_id,
        department_id: v.department_id,
        triage_level: v.triage_level,
        complaint_codes: (v.symptoms ?? []).map((s) => s.code).filter(Boolean),
        diagnoses: v.diagnoses,
        prescriptions: v.prescriptions,
      })),
      risk_flags: riskFlagsFrom(age, conditions),
      last_encounter_at: visits[0] ? new Date(`${visits[0].session_date}T00:00:00Z`) : null,
    });
    return version;
  },

  async merge(trx, fromId, intoId) {
    if (fromId === intoId) throw AppError.validation('cannot merge a patient into itself');
    const [from, into] = await Promise.all([patientsRepo.byId(trx, fromId), patientsRepo.byId(trx, intoId)]);
    if (!from || !into) throw AppError.notFound('patient');
    if (into.merged_into_id) throw AppError.validation('target patient was itself merged');
    await patientsRepo.mergePatient(trx, fromId, intoId);
    await writeOutbox(trx, { aggregateType: 'patient', aggregateId: intoId, eventType: 'patient.merged', payload: { fromId, intoId } });
  },

  newPatientId: () => newId(),
};
