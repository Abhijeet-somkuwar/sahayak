import api from './axiosConfig';

// Counter registration: creates the visit and (check_in: true) issues the token immediately.
// body: { facility_id, patient_id, department_id, kind?, triage_level?, check_in, protected_lane? } → 201 { encounter, checkin }
export const createEncounter = (body, idempotencyKey) => api.post('/encounters', body, { authKind: 'staff', headers: { 'Idempotency-Key': idempotencyKey } }).then((r) => r.data);

export const getEncounter = (id) => api.get(`/encounters/${id}`, { authKind: 'staff' }).then((r) => r.data);
export const getPrebrief = (id) => api.get(`/encounters/${id}/prebrief`, { authKind: 'staff' }).then((r) => r.data);
export const sendPrebriefFeedback = (id, helpful) => api.post(`/encounters/${id}/prebrief/feedback`, { feedback: helpful ? 1 : -1, note: null }, { authKind: 'staff' });

export const addObservation = (id, body) => api.post(`/encounters/${id}/observations`, body, { authKind: 'staff' }).then((r) => r.data);
export const addDiagnosis = (id, displayText, isPrimary = true) => api.post(`/encounters/${id}/diagnoses`, { display_text: displayText, code_system: 'local', is_primary: isPrimary }, { authKind: 'staff' }).then((r) => r.data);
export const addPrescription = (id, item) => api.post(`/encounters/${id}/prescriptions`, item, { authKind: 'staff' }).then((r) => r.data);
export const completeEncounter = (id, { followups = [], referred = false } = {}) => api.post(`/encounters/${id}/complete`, { followups, referred }, { authKind: 'staff' }).then((r) => r.data);
export const overrideTriage = (id, version, finalLevel, reason) =>
  api.patch(`/encounters/${id}/triage`, { final_level: finalLevel, reason }, { authKind: 'staff', headers: { 'If-Match': `"${version}"` } }).then((r) => r.data);
// Ask for a fresh pre-brief (after the AI was busy); a prebrief.ready event follows.
export const regeneratePrebrief = (id) => api.post(`/encounters/${id}/prebrief/regenerate`, {}, { authKind: 'staff' }).then((r) => r.data);
