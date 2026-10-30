import api from './axiosConfig';

// Development-only demo helpers on the backend (404 in production, where the demo panel then stays hidden).
export const getDemoInfo = () => api.get('/dev/demo', { authKind: 'none' }).then((r) => r.data);
export const resetDemo = () => api.post('/dev/demo/reset', {}, { authKind: 'none' }).then((r) => r.data);
