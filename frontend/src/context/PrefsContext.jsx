import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import i18next from '../i18n';

// Language, text size and contrast. Saved in localStorage (no patient data), applied to <html>.
const PrefsContext = createContext(null);
const KEY = 'sahayak.prefs';
const DEFAULTS = { language: 'en', textScale: 100, highContrast: false, shortcutsEnabled: true };

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
}

export function PrefsProvider({ children }) {
  const [prefs, setPrefs] = useState(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* storage blocked */
    }
    document.documentElement.lang = prefs.language;
    document.documentElement.style.setProperty('--text-scale', String(prefs.textScale / 100));
    document.documentElement.dataset.contrast = prefs.highContrast ? 'high' : 'normal';
    if (i18next.language !== prefs.language) i18next.changeLanguage(prefs.language);
  }, [prefs]);

  const value = useMemo(() => ({ ...prefs, setPrefs: (patch) => setPrefs((p) => ({ ...p, ...patch })) }), [prefs]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export const usePrefs = () => useContext(PrefsContext);
