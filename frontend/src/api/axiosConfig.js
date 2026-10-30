import axios from 'axios';
import i18next from '../i18n';
import { ApiError, NetworkError } from '../utils/errors';

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Shared Axios instance for the Sahayak API (/api/v1). Errors are RFC 9457 problem+json with a stable `code`.
const api = axios.create({ baseURL: `${API_URL}/api/v1`, timeout: 15000 });

/**
 * Three kinds of callers use this instance:
 *  - staff:   Authorization: Bearer <access token>  (AuthContext registers getToken/refresh/onFailure)
 *  - patient: Authorization: Bearer <patient token> (OTP sign-in, PatientSessionContext registers it)
 *  - device:  X-Device-Key: <device api key>        (kiosk and waiting-hall display)
 */
let getStaffToken = () => null;
let getPatientToken = () => null;
let getDeviceKey = () => null;
let refreshStaff = async () => null;
let onStaffAuthFailure = () => {};

export function configureStaffAuth({ getToken, refresh, onFailure }) {
  getStaffToken = getToken;
  refreshStaff = refresh;
  onStaffAuthFailure = onFailure;
}
export function configurePatientAuth(getToken) {
  getPatientToken = getToken;
}
export function configureDeviceAuth(getKey) {
  getDeviceKey = getKey;
}

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

api.interceptors.request.use((config) => {
  // A request may say which credential it wants: config.auth = 'staff' | 'patient' | 'device' (default: staff, then patient).
  const kind = config.authKind || (getStaffToken() ? 'staff' : getPatientToken() ? 'patient' : getDeviceKey() ? 'device' : 'none');
  if (kind === 'staff' && getStaffToken()) config.headers.Authorization = `Bearer ${getStaffToken()}`;
  if (kind === 'patient' && getPatientToken()) config.headers.Authorization = `Bearer ${getPatientToken()}`;
  if (kind === 'device' && getDeviceKey()) config.headers['X-Device-Key'] = getDeviceKey();
  config.headers['Accept-Language'] = i18next.language || 'en';
  config.headers['X-Request-Id'] = uuid();
  return config;
});

let refreshing = null; // single-flight refresh promise

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const { config, response } = error;
    if (!response) throw new NetworkError(error.message);

    const staffCall = (config.authKind || 'staff') === 'staff' && !!getStaffToken();
    const isAuthRoute = config.url && config.url.includes('/auth/');
    if (response.status === 401 && staffCall && !config._retried && !isAuthRoute) {
      config._retried = true;
      refreshing = refreshing || refreshStaff().finally(() => (refreshing = null));
      const token = await refreshing;
      if (token) return api(config);
      onStaffAuthFailure();
    }
    const data = response.data && typeof response.data === 'object' ? response.data : {};
    throw new ApiError({
      status: response.status,
      code: data.code || (response.status === 404 ? 'not_found' : response.status === 401 ? 'unauthenticated' : 'internal_error'),
      detail: data.detail,
      requestId: data.requestId || data.request_id || config.headers['X-Request-Id'],
      errors: data.errors,
      retryAfter: response.headers['retry-after'] ? Number(response.headers['retry-after']) : undefined,
      ...data,
    });
  },
);

/** Reads the version from an ETag header like "3". */
export const versionFromEtag = (res) => {
  const m = String(res.headers.etag || '').match(/"?(\d+)"?/);
  return m ? Number(m[1]) : undefined;
};

export default api;
