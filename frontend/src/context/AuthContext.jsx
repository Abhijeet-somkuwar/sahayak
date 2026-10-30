import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as authApi from '../api/auth';
import { configureStaffAuth } from '../api/axiosConfig';
import { connectStaff } from '../services/websocketService';

/**
 * Staff session. The access token lives in memory; the refresh token is kept in sessionStorage
 * (per tab, cleared when the tab closes) so a reload keeps you signed in. Doctors, admins,
 * reviewers and the DPO must also enter a TOTP code (MFA) after the password.
 */
const AuthContext = createContext(null);
const REFRESH_KEY = 'sahayak.staff.refresh';

const readRefresh = () => {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
};
const writeRefresh = (v) => {
  try {
    if (v) sessionStorage.setItem(REFRESH_KEY, v);
    else sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    /* storage blocked */
  }
};

const EMPTY = { accessToken: null, user: null, mfa: null, locked: false, ready: false };

export function AuthProvider({ children }) {
  const [state, setState] = useState(EMPTY);
  const tokenRef = useRef(null);
  tokenRef.current = state.accessToken;

  // tokens → access token in memory, refresh token in sessionStorage, staff socket, then /me
  const applyTokens = useCallback(async (tokens) => {
    tokenRef.current = tokens.access_token;
    if (tokens.refresh_token) writeRefresh(tokens.refresh_token);
    connectStaff(tokens.access_token);
    const me = await authApi.me();
    setState({ accessToken: tokens.access_token, user: me, mfa: null, locked: false, ready: true });
    return tokens.access_token;
  }, []);

  const clear = useCallback(() => {
    tokenRef.current = null;
    writeRefresh(null);
    connectStaff(null);
    setState({ ...EMPTY, ready: true });
  }, []);

  const refresh = useCallback(async () => {
    const rt = readRefresh();
    if (!rt) return null;
    try {
      const tokens = await authApi.refresh(rt);
      return await applyTokens(tokens);
    } catch {
      clear();
      return null;
    }
  }, [applyTokens, clear]);

  useEffect(() => {
    configureStaffAuth({
      getToken: () => tokenRef.current,
      refresh,
      onFailure: () => {
        clear();
        const p = window.location.pathname;
        if (['/counter', '/doctor', '/ed'].some((s) => p.startsWith(s))) window.location.assign(`/login?returnTo=${encodeURIComponent(p + window.location.search)}`);
      },
    });
  }, [refresh, clear]);

  // Restore the session on first load.
  useEffect(() => {
    refresh().finally(() => setState((s) => ({ ...s, ready: true })));
  }, [refresh]);

  /** Returns 'ok' when signed in, or 'mfa' when a TOTP code is needed next (state.mfa is set). */
  const login = useCallback(
    async (identifier, password) => {
      const r = await authApi.staffLogin(identifier, password);
      if (r.mfa_required) {
        setState((s) => ({ ...s, mfa: { mfaToken: r.mfa_token, enrolRequired: r.enrol_required, otpauthUrl: null, identifier } }));
        return 'mfa';
      }
      await applyTokens(r);
      return 'ok';
    },
    [applyTokens],
  );

  const mfaEnrol = useCallback(async () => {
    const r = await authApi.mfaEnrol(state.mfa.mfaToken);
    setState((s) => ({ ...s, mfa: { ...s.mfa, otpauthUrl: r.otpauth_url } }));
    return r.otpauth_url;
  }, [state.mfa]);

  const mfaVerify = useCallback(
    async (code) => {
      const tokens = await authApi.mfaVerify(state.mfa.mfaToken, code);
      await applyTokens(tokens);
    },
    [state.mfa, applyTokens],
  );

  const cancelMfa = useCallback(() => setState((s) => ({ ...s, mfa: null })), []);

  /**
   * Development only (the demo panel): sign this tab in as a demo account in one step. Any session in this tab is
   * dropped locally first (not revoked, so another tab that shares it is not signed out); the authenticator code
   * comes from the development backend.
   */
  const devLogin = useCallback(
    async (identifier, password) => {
      tokenRef.current = null;
      writeRefresh(null);
      connectStaff(null);
      setState({ ...EMPTY, ready: true });
      const r = await authApi.staffLogin(identifier, password);
      if (!r.mfa_required) return applyTokens(r);
      if (r.enrol_required) await authApi.mfaEnrol(r.mfa_token);
      const { code } = await authApi.mfaDevCode(r.mfa_token);
      return applyTokens(await authApi.mfaVerify(r.mfa_token, code));
    },
    [applyTokens],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout(readRefresh());
    } catch {
      /* already signed out */
    } finally {
      clear();
    }
  }, [clear]);

  const lock = useCallback(() => setState((s) => ({ ...s, locked: true })), []);
  // Unlock: the password proves the person is still there; the existing session continues.
  const unlock = useCallback(
    async (password) => {
      const identifier = state.user && (state.user.email || state.user.id);
      await authApi.staffLogin(identifier, password); // throws on a wrong password; an mfa_required reply still proves the password
      setState((s) => ({ ...s, locked: false }));
    },
    [state.user],
  );

  const memberships = (state.user && state.user.memberships) || [];
  const membership = memberships[0] || null;
  const value = useMemo(
    () => ({
      ...state,
      memberships,
      membership,
      role: membership ? membership.role : null,
      facilityId: membership ? membership.facility_id : null,
      departmentId: membership ? membership.department_id : null,
      login,
      mfaEnrol,
      mfaVerify,
      cancelMfa,
      devLogin,
      logout,
      lock,
      unlock,
    }),
    [state, memberships, membership, login, mfaEnrol, mfaVerify, cancelMfa, devLogin, logout, lock, unlock],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
