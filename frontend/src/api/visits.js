import api from './axiosConfig';

// Visit history. Patients see their own household's visits (the doctor's diagnosis and medicines);
// doctors see a patient's visits with the AI pre-brief headline written at each one.
export const getMyVisits = (lang) => api.get('/me/visits', { params: { lang }, authKind: 'patient' }).then((r) => r.data);
export const getMyVisitByRef = (ref, lang) => api.get(`/me/visits/by-ref/${ref}`, { params: { lang }, authKind: 'patient' }).then((r) => r.data);
export const getPatientVisits = (patientId) => api.get(`/patients/${patientId}/visits`, { authKind: 'staff' }).then((r) => r.data);
