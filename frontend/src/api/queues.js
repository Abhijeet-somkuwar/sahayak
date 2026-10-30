import api, { versionFromEtag } from './axiosConfig';

// Today's queue sessions → [{ id, department_id, department, token_prefix, shift, status, lanes, waiting, ewma_consult_sec, active_servers, eta_for_new_token }]
export const getQueuesToday = (facilityId) => api.get(`/facilities/${facilityId}/queues/today`, { authKind: 'staff' }).then((r) => r.data.items);

// Next waiting tokens per lane (codes only), for the doctor's queue rail.
export const getQueueNext = (sessionId) => api.get(`/queues/${sessionId}/next`, { authKind: 'staff' }).then((r) => r.data.items);

// Call the next patient. → { token, room, encounter, prebrief } or null when nobody is waiting (204).
export const callNext = (sessionId, servicePointId) =>
  api.post(`/queues/${sessionId}/call-next`, servicePointId ? { service_point_id: servicePointId } : {}, { authKind: 'staff' }).then((r) => (r.status === 204 ? null : { ...r.data, version: versionFromEtag(r) }));

// recall | skip | start | complete | requeue | cancel, with the version the screen last saw (If-Match). Stale → 412 version_conflict.
export const transitionToken = (tokenId, action, version, reason) =>
  api.post(`/tokens/${tokenId}/${action}`, reason ? { reason } : {}, { authKind: 'staff', headers: { 'If-Match': `"${version}"` } }).then((r) => r.data);

export const getToken = (tokenId) => api.get(`/tokens/${tokenId}`, { authKind: 'staff' }).then((r) => r.data);

export const setDoctorStatus = (status, queueSessionId) => api.put('/doctors/me/status', { status, queue_session_id: queueSessionId || null }, { authKind: 'staff' }).then((r) => r.data);

export const openSession = (sessionId) => api.post(`/queues/${sessionId}/open`, {}, { authKind: 'staff' }).then((r) => r.data);
