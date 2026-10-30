import api, { versionFromEtag } from './axiosConfig';

// Public slip status by its random reference. No name, no clinical data.
// → { token, department, department_i18n, room, status, people_ahead, eta: { min_minutes, max_minutes, doctor_unavailable }, session_status }
export const getTokenStatus = (publicRef) => api.get(`/t/${publicRef}`, { authKind: 'none' }).then((r) => r.data);

// Check-in at the kiosk (device) or counter (staff). body: { encounter_id } for a booking, or { patient_id } for a walk-in.
// → 201 { token: { id, display_code, lane, token_no, status, version, queue_entry_at }, encounter_id, queue_session_id, public_ref, status_url, position }
export const checkIn = (sessionId, body, idempotencyKey, authKind = 'staff') =>
  api.post(`/queues/${sessionId}/checkins`, body, { authKind, headers: { 'Idempotency-Key': idempotencyKey } }).then((r) => ({ ...r.data, version: versionFromEtag(r) }));

// Devices (kiosk, waiting-hall display): what am I, and the board snapshot.
export const getDeviceMe = () => api.get('/devices/me', { authKind: 'device' }).then((r) => r.data);
export const getDisplaySnapshot = () => api.get('/displays/me/snapshot', { authKind: 'device' }).then((r) => r.data);

// Resolve a booking QR (sahayak:enc:<encounter id>) to today's queue session, at the kiosk (device) or counter (staff).
export const getBooking = (encounterId, authKind = 'device') => api.get(`/bookings/${encounterId}`, { authKind }).then((r) => r.data);
