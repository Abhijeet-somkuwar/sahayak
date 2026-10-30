import api from './axiosConfig';

// Public facility page: name, departments open today, live waits. No sign-in needed.
export const getFacility = (code, lang = 'en') => api.get(`/facilities/${encodeURIComponent(code)}/public`, { params: { lang }, authKind: 'none' }).then((r) => r.data);

export const getDepartments = (facilityId) => api.get(`/facilities/${facilityId}/departments`).then((r) => r.data.items);
export const getServicePoints = (facilityId) => api.get(`/facilities/${facilityId}/service-points`).then((r) => r.data.items);
export const getDoctorSchedules = (facilityId) => api.get(`/facilities/${facilityId}/doctor-schedules`).then((r) => r.data.items);
