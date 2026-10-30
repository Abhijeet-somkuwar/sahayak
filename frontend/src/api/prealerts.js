import api from './axiosConfig';

// Casualty pre-alerts: { items: [{ id, facility_id, encounter_id, summary, status, created_at, acknowledged_at, ... }] }
export const getPrealerts = (facilityId) => api.get(`/facilities/${facilityId}/emergency-prealerts`, { authKind: 'staff' }).then((r) => r.data.items);
export const acknowledgePrealert = (id) => api.post(`/emergency-prealerts/${id}/ack`, {}, { authKind: 'staff' }).then((r) => r.data);
