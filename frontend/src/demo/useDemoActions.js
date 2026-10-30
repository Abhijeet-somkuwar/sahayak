import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDevice } from '../context/DeviceContext';
import { resetDemo } from '../api/dev';
import { findDevice, homeOf, loginUrl } from './demoData';

// New tabs are opened without an opener so they do not copy this tab's sessionStorage (each tab keeps its own login).
const openTab = (url) => window.open(url, '_blank', 'noopener');
const KIND = { kiosk: 'kiosk', display: 'queue_display' };

/** The buttons of the Demo panel and the guide: open screens in new tabs, sign in, start a fresh demo. */
export function useDemoActions(demo) {
  const navigate = useNavigate();
  const auth = useAuth();
  const device = useDevice();
  const facility = (demo && demo.facility.code) || import.meta.env.VITE_DEFAULT_FACILITY;
  const patientUrl = `/f/${facility}`;

  const openPatient = useCallback(() => openTab(patientUrl), [patientUrl]);
  /** slot: 'kiosk' | 'display'. Saves the demo device key (shared by all tabs) and opens the screen. */
  const openScreen = useCallback(
    (slot) => {
      const d = findDevice(demo, KIND[slot]);
      if (d) device.setDeviceKey(d.key, slot);
      openTab(`/${slot}`);
    },
    [demo, device],
  );
  const openStaff = useCallback((s, screen) => openTab(loginUrl(s, screen)), []);
  const signInHere = useCallback(
    async (s, screen) => {
      await auth.devLogin(s.email, demo.staff_password);
      navigate(screen || homeOf(s) || '/counter');
    },
    [auth, demo, navigate],
  );
  const reset = useCallback(() => resetDemo(), []);
  return { patientUrl, openPatient, openScreen, openStaff, signInHere, reset };
}
