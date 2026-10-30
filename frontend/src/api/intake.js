import api from './axiosConfig';

// Conversational intake. Every response is { session_id, state, encounter_id, messages: [{ templateCode, text, buttons?, list?, link? }] }.
export const startIntake = (facilityCode, language) => api.post('/intake/sessions', { facility_code: facilityCode, language }, { authKind: 'patient' }).then((r) => r.data);
export const getIntake = (sessionId) => api.get(`/intake/sessions/${sessionId}`, { authKind: 'patient' }).then((r) => r.data);

// event: { kind: 'text', text } | { kind: 'choice', id, title } | { kind: 'start' }
export const answerIntake = (sessionId, event, idempotencyKey) =>
  api.post(`/intake/sessions/${sessionId}/answers`, event, { authKind: 'patient', headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} }).then((r) => r.data);

export const cancelBooking = (encounterId) => api.post(`/bookings/${encounterId}/cancel`, {}, { authKind: 'patient' });
