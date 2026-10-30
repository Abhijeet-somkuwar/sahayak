import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as authApi from '../api/auth';
import { configurePatientAuth } from '../api/axiosConfig';

/**
 * Patient sign-in by OTP (the phone number is verified by SMS/WhatsApp; in development the backend
 * also returns the code as `dev_code`). The token lives in sessionStorage on the patient's own phone.
 */
const PatientSessionContext = createContext(null);
const KEY = 'sahayak.patient';

const load = () => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
};

export function PatientSessionProvider({ children }) {
  const [session, setSession] = useState(load); // { token, contactPointId, phone, expiresAt }

  useEffect(() => {
    try {
      if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
      else sessionStorage.removeItem(KEY);
    } catch {
      /* storage blocked */
    }
    configurePatientAuth(() => (session && Date.now() < session.expiresAt ? session.token : null));
  }, [session]);

  const requestOtp = useCallback((phone, language) => authApi.requestPatientOtp(phone, language), []);
  const verifyOtp = useCallback(async (phone, code, language) => {
    const r = await authApi.verifyPatientOtp(phone, code, language);
    setSession({ token: r.access_token, contactPointId: r.contact_point_id, phone, expiresAt: Date.now() + (r.expires_in - 60) * 1000 });
    return r;
  }, []);
  const clear = useCallback(() => setSession(null), []);

  const signedIn = !!(session && Date.now() < session.expiresAt);
  const value = useMemo(() => ({ session, signedIn, phone: session && session.phone, requestOtp, verifyOtp, clear }), [session, signedIn, requestOtp, verifyOtp, clear]);
  return <PatientSessionContext.Provider value={value}>{children}</PatientSessionContext.Provider>;
}

export const usePatientSession = () => useContext(PatientSessionContext);
