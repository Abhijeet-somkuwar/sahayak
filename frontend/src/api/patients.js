import api from './axiosConfig';

// Staff search: { phone } | { abha } | { name, district, birth_year } → { kind, items }
export const searchPatients = (params) => api.get('/patients/search', { params, authKind: 'staff' }).then((r) => r.data);

// Registration. body: { display_name, sex, age_years | birth_date, district_code, phone?, relationship, force? }
// 201 → { id, display_name, sex, birth_year, version }; 409 possible_duplicates → error.extra.candidates
export const createPatient = (body) => api.post('/patients', body, { authKind: 'staff' }).then((r) => r.data);

export const getPatient = (id) => api.get(`/patients/${id}`, { authKind: 'staff' }).then((r) => r.data);
export const getClinicalSummary = (id) => api.get(`/patients/${id}/clinical-summary`, { authKind: 'staff' }).then((r) => r.data);
export const breakGlass = (id, reason) => api.post(`/patients/${id}/breakglass`, { reason }, { authKind: 'staff' }).then((r) => r.data);
