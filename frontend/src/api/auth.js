import api from './axiosConfig';

// ---- Staff (email or phone + password; doctors, admins, reviewers and the DPO also need a TOTP code) ----
export const staffLogin = (identifier, password) => api.post('/auth/staff/login', { identifier, password }, { authKind: 'none' }).then((r) => r.data);
export const mfaEnrol = (mfaToken) => api.post('/auth/staff/mfa/enrol', { mfa_token: mfaToken }, { authKind: 'none' }).then((r) => r.data);
export const mfaVerify = (mfaToken, code) => api.post('/auth/staff/mfa/verify', { mfa_token: mfaToken, code }, { authKind: 'none' }).then((r) => r.data);
// Development only: the backend returns the account's current authenticator code (404 in production).
export const mfaDevCode = (mfaToken) => api.post('/auth/staff/mfa/dev-code', { mfa_token: mfaToken }, { authKind: 'none' }).then((r) => r.data);
export const refresh = (refreshToken) => api.post('/auth/refresh', { refresh_token: refreshToken }, { authKind: 'none' }).then((r) => r.data);
export const logout = (refreshToken) => api.post('/auth/logout', refreshToken ? { refresh_token: refreshToken } : {}, { authKind: 'staff' });
export const me = () => api.get('/me', { authKind: 'staff' }).then((r) => r.data);

// ---- Patient (OTP by SMS/WhatsApp; in development the code is also returned as dev_code) ----
export const requestPatientOtp = (phone, language) => api.post('/auth/patient/otp', { phone, language }, { authKind: 'none' }).then((r) => r.data);
export const verifyPatientOtp = (phone, code, language) => api.post('/auth/patient/otp/verify', { phone, code, language }, { authKind: 'none' }).then((r) => r.data);
