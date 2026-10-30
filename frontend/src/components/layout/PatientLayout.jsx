import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { usePrefs } from '../../context/PrefsContext';
import { ContrastToggle, LanguageSwitch, TextSizeSwitch } from '../ui/PrefsSwitches';
import './PatientLayout.css';

// Quiet patient header: app name, language, text size and contrast switches. Content is centred.
export default function PatientLayout() {
  const { t } = useTranslation();
  const prefs = usePrefs();
  return (
    <div className="patient patient-layout">
      <header className="patient-layout__header">
        <span className="font-display patient-layout__brand">{t('app.name')}</span>
        <div className="patient-layout__prefs">
          <LanguageSwitch value={prefs.language} onChange={(language) => prefs.setPrefs({ language })} label={t('common.language')} />
          <TextSizeSwitch value={prefs.textScale} onChange={(textScale) => prefs.setPrefs({ textScale })} label={t('common.textSize')} />
          <ContrastToggle value={prefs.highContrast} onChange={(highContrast) => prefs.setPrefs({ highContrast })} label={t('common.highContrast')} />
        </div>
      </header>
      <main className="patient-layout__main">
        <Outlet />
      </main>
    </div>
  );
}
