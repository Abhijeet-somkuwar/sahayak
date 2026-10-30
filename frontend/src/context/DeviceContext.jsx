import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { configureDeviceAuth } from '../api/axiosConfig';
import { getDeviceMe } from '../api/tokens';
import { connectDisplay } from '../services/websocketService';

/**
 * Kiosks and waiting-hall displays authenticate with a per-device API key provisioned once by an
 * admin (shown once when the device is created). It is stored on that device only.
 *
 * One key per kind of screen ("slot"): /kiosk uses the kiosk key and /display the display key, so a
 * single browser can run both screens side by side in two tabs (demos, testing).
 */
const DeviceContext = createContext(null);
const SLOTS = ['kiosk', 'display'];
const storageKey = (slot) => `sahayak.deviceKey.${slot}`;
const slotOf = (path) => (path.startsWith('/kiosk') ? 'kiosk' : path.startsWith('/display') ? 'display' : null);

const readSlot = (slot) => {
  try {
    return localStorage.getItem(storageKey(slot)) || '';
  } catch {
    return '';
  }
};
const writeSlot = (slot, value) => {
  try {
    if (value) localStorage.setItem(storageKey(slot), value);
    else localStorage.removeItem(storageKey(slot));
    localStorage.removeItem('sahayak.deviceKey'); // the old single key could hold either kind; no longer used
  } catch {
    /* storage blocked */
  }
};

export function DeviceProvider({ children }) {
  const { pathname } = useLocation();
  const slot = slotOf(pathname);
  const [keys, setKeys] = useState(() => Object.fromEntries(SLOTS.map((s) => [s, readSlot(s)])));
  const deviceKey = slot ? keys[slot] || '' : '';
  const [device, setDevice] = useState(null); // GET /devices/me
  const [error, setError] = useState(null);

  // a key saved in another tab (for example from the demo panel) applies here too
  useEffect(() => {
    const onStorage = (e) => {
      const s = SLOTS.find((x) => e.key === storageKey(x));
      if (s) setKeys((k) => ({ ...k, [s]: e.newValue || '' }));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    configureDeviceAuth(() => deviceKey || null);
    setError(null);
    if (!deviceKey) {
      setDevice(null);
      connectDisplay(null);
      return undefined;
    }
    let alive = true;
    getDeviceMe()
      .then((d) => {
        if (!alive) return;
        setDevice(d);
        setError(null);
        connectDisplay(deviceKey);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [deviceKey]);

  /** Saves a key for the current screen, or for `forSlot` ('kiosk' | 'display') from anywhere. */
  const setDeviceKey = useCallback(
    (k, forSlot) => {
      const s = forSlot || slot;
      if (!s) return;
      const v = String(k || '').trim();
      writeSlot(s, v);
      setKeys((m) => ({ ...m, [s]: v }));
    },
    [slot],
  );
  const value = useMemo(
    () => ({ slot, deviceKey, device, error, setDeviceKey, facilityId: device && device.facility && device.facility.id }),
    [slot, deviceKey, device, error, setDeviceKey],
  );
  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

export const useDevice = () => useContext(DeviceContext);
