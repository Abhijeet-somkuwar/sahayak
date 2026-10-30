import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from 'antd';
import { useAuth } from '../../context/AuthContext';
import { usePrefs } from '../../context/PrefsContext';
import { useSocketStatus } from '../../context/SocketContext';
import { useIdleTimer } from '../../hooks/useIdleTimer';
import { LanguageSwitch } from '../ui/PrefsSwitches';
import { ConfirmDialog } from '../ui/Dialogs';
import LockScreen from './LockScreen';
import './StaffLayout.css';

const IDLE_MS = 10 * 60 * 1000;
const WARN_MS = 30 * 1000;

// Ward-green header, role-aware navigation, connection status and the 10-minute idle lock.
export default function StaffLayout() {
  const { t } = useTranslation();
  const auth = useAuth();
  const prefs = usePrefs();
  const { status } = useSocketStatus();
  const navigate = useNavigate();
  const [warn, setWarn] = useState(null);
  const [epoch, setEpoch] = useState(0);

  const resetIdle = useIdleTimer({
    idleMs: IDLE_MS,
    warnMs: WARN_MS,
    enabled: !!auth.accessToken && !auth.locked,
    onWarn: () => setWarn(WARN_MS / 1000),
    onTimeout: () => {
      setWarn(null);
      auth.lock();
    },
  });
  useEffect(() => {
    if (warn == null || warn <= 0) return undefined;
    const id = setTimeout(() => setWarn((w) => (w == null ? null : w - 1)), 1000);
    return () => clearTimeout(id);
  }, [warn]);

  const role = auth.role;
  const admin = ['facility_admin', 'state_admin'].includes(role);
  const nav = [
    (['registration_clerk', 'help_desk', 'nurse'].includes(role) || admin) && { to: '/counter', label: t('staff.nav.counter') },
    (['doctor', 'nurse'].includes(role) || admin) && { to: '/doctor', label: t('staff.nav.doctor') },
    (['doctor', 'nurse'].includes(role) || admin) && { to: '/ed', label: t('staff.nav.ed') },
  ].filter(Boolean);

  const signOut = async () => {
    await auth.logout();
    navigate('/login');
  };

  return (
    <div className="staff-layout">
      <header className="staff-header">
        <span className="font-display staff-header__brand">{t('app.name')}</span>
        {auth.user && <span className="staff-header__facility">{auth.user.email}</span>}
        <nav className="staff-header__nav" aria-label="Sections">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `staff-header__link ${isActive ? 'is-active' : ''}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="staff-header__right">
          <span className="staff-header__status" role="status">
            <span aria-hidden className={`staff-header__dot ${status === 'connected' ? 'is-on' : ''}`} />
            {status === 'connected' ? t('staff.online') : status === 'connecting' ? t('staff.reconnecting') : t('staff.offline')}
          </span>
          <LanguageSwitch value={prefs.language} onChange={(language) => prefs.setPrefs({ language })} label={t('common.language')} tone="sheet" size="staff" />
          {auth.user && <span className="text-sm">{auth.user.display_name}</span>}
          <Button type="link" onClick={signOut} style={{ color: 'var(--sheet)', textDecoration: 'underline' }}>
            {t('staff.signOut')}
          </Button>
        </div>
      </header>
      <div key={epoch} className="staff-layout__body" inert={auth.locked ? '' : undefined}>
        <Outlet />
      </div>
      {auth.locked && (
        <LockScreen
          onUnlocked={() => {
            setEpoch((e) => e + 1); // remount the page so it reloads fresh data
            resetIdle();
          }}
        />
      )}
      <ConfirmDialog
        open={warn != null && !auth.locked}
        onClose={() => setWarn(null)}
        title={t('staff.lock.warn', { seconds: warn || 0 })}
        confirmLabel={t('staff.lock.stay')}
        cancelLabel={t('common.close')}
        onConfirm={() => {
          setWarn(null);
          resetIdle();
        }}
      />
    </div>
  );
}
