import i18next from 'i18next';
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import hi from './hi.json';
import gu from './gu.json';

export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिंदी' },
  { code: 'gu', label: 'ગુજરાતી' },
];

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem('sahayak.prefs') || '{}').language;
  } catch {
    return undefined;
  }
})();

i18next
  .use(ICU)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, hi: { translation: hi }, gu: { translation: gu } },
    lng: saved || 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

/** Pick the active language's text from a {en, hi, gu} object. */
export function pick(localized, lang) {
  if (!localized) return '';
  return localized[lang] || localized.en || Object.values(localized)[0] || '';
}

export default i18next;
