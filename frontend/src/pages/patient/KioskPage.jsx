import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'antd';
import { PrinterOutlined, QrcodeOutlined } from '@ant-design/icons';
import { checkIn, getBooking } from '../../api/tokens';
import { LANGS, pick } from '../../i18n';
import { usePrefs } from '../../context/PrefsContext';
import { useDevice } from '../../context/DeviceContext';
import { useIdempotencyKey } from '../../services/idempotency';
import { useIdleTimer } from '../../hooks/useIdleTimer';
import { useErrorText } from '../../hooks/useErrorText';
import { ApiError } from '../../utils/errors';
import DeviceSetup from '../../components/layout/DeviceSetup';
import TokenSlip from '../../components/ui/TokenSlip';
import TokenNumeral from '../../components/ui/TokenNumeral';
import Stamp from '../../components/ui/Stamp';
import QrScanner from '../../components/ui/QrScanner';
import QrCode from '../../components/ui/QrCode';
import { ConfirmDialog } from '../../components/ui/Dialogs';
import { InlineNotice, OfflineBanner } from '../../components/ui/Notices';
import './PatientPages.css';

const splitCode = (code) => {
  const m = String(code || '').match(/^([A-Z]+)-?(\d+)$/i);
  return m ? { prefix: m[1].toUpperCase(), number: m[2] } : { prefix: '', number: code || '' };
};

/**
 * Kiosk mode: portrait, bilingual header. The patient scans the booking QR (sahayak:enc:<id>) or types
 * the check-in code; the kiosk resolves it to today's queue session and checks in with the device key.
 * Everything here is component state: nothing persists between patients.
 */
export default function KioskPage() {
  const device = useDevice();
  if (!device.deviceKey || (!device.device && !device.error)) return device.deviceKey ? null : <DeviceSetup />;
  if (device.error) return <DeviceSetup />;
  return <Kiosk device={device.device} />;
}

function Kiosk({ device }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const prefs = usePrefs();
  const errorText = useErrorText();
  const idem = useIdempotencyKey();
  const [mode, setMode] = useState('scan'); // scan | code | done
  const [result, setResult] = useState(null);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [warn, setWarn] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const reset = () => {
    setMode('scan');
    setResult(null);
    setWarn(null);
    setError(null);
    idem.reset();
  };
  const resetIdle = useIdleTimer({ idleMs: 60000, warnMs: 15000, enabled: mode !== 'scan', onWarn: () => setWarn(15), onTimeout: reset });
  useEffect(() => {
    if (warn == null || warn <= 0) return undefined;
    const id = setTimeout(() => setWarn((w) => (w == null ? null : w - 1)), 1000);
    return () => clearTimeout(id);
  }, [warn]);

  const doCheckIn = async (raw) => {
    const encounterId = String(raw).replace(/^sahayak:enc:/, '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(encounterId)) return setError(new ApiError({ status: 404, code: 'not_found' }));
    setPending(true);
    setError(null);
    try {
      const booking = await getBooking(encounterId, 'device');
      if (!booking.queue_session_id || !['intake', 'triaged', 'booked'].includes(booking.status)) {
        setError(new ApiError({ status: 409, code: 'invalid_state' }));
        return undefined;
      }
      const r = await checkIn(booking.queue_session_id, { encounter_id: encounterId, source: 'kiosk' }, idem.get(), 'device');
      idem.reset();
      setResult(r);
      setMode('done');
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
    return undefined;
  };

  const errorNotice = error && (
    <InlineNotice tone="error">{error instanceof ApiError && (error.status === 404 || error.code === 'invalid_state' || error.code === 'conflict') ? t('kiosk.notBooked') : errorText(error)}</InlineNotice>
  );
  const facilityName = device.facility ? pick(device.facility.name_i18n, lng) || device.facility.name : '';
  const facilityEn = device.facility ? device.facility.name : '';
  const statusUrl = result ? `${window.location.origin}/t/${result.public_ref}` : '';
  const code = result ? splitCode(result.token.display_code) : null;

  return (
    <div className="kiosk">
      <header className="kiosk__header">
        <div className="kiosk__brand">
          <p>{facilityEn}</p>
          {lng !== 'en' && facilityName !== facilityEn && <p lang={lng}>{facilityName}</p>}
        </div>
        <div role="radiogroup" aria-label={t('common.language')} className="kiosk__lang">
          {LANGS.map((l) => (
            <button key={l.code} type="button" role="radio" aria-checked={l.code === lng} lang={l.code} onClick={() => prefs.setPrefs({ language: l.code })}>
              {l.label}
            </button>
          ))}
        </div>
      </header>
      {!online && <OfflineBanner text={t('kiosk.offline')} />}

      {mode === 'scan' && (
        <div className="kiosk__body">
          <h1 className="kiosk__title">
            <QrcodeOutlined style={{ fontSize: 36, color: 'var(--ward)' }} aria-hidden /> {t('kiosk.scanQr')}
          </h1>
          {!cameraUnavailable ? <QrScanner className="kiosk__scanner" onResult={doCheckIn} onUnavailable={() => setCameraUnavailable(true)} /> : <InlineNotice tone="info">{t('kiosk.noCamera')}</InlineNotice>}
          <p className="text-lg text-soft">{t('kiosk.scanHint')}</p>
          {pending && <p className="text-soft">{t('common.loading')}…</p>}
          {errorNotice}
          <div className="kiosk__bottom">
            <Button size="large" block onClick={() => setMode('code')}>
              {t('kiosk.enterCode')}
            </Button>
            <p className="text-soft" style={{ textAlign: 'center' }}>{t('kiosk.goCounter')}</p>
          </div>
        </div>
      )}

      {mode === 'code' && <CodeEntry onSubmit={doCheckIn} pending={pending} error={errorNotice} onStartOver={reset} onTouch={resetIdle} />}

      {mode === 'done' && result && (
        <div className="kiosk__body">
          <h1 className="kiosk__title">{t('kiosk.checkedIn')}</h1>
          <TokenSlip variant="print" facility={facilityName} numeral={<TokenNumeral prefix={code.prefix} number={code.number} />} stamp={<Stamp text={t('slip.checkedIn')} />}>
            {result.position && result.position.room && <p className="slip-room">{t('kiosk.goTo', { room: result.position.room })}</p>}
            {result.position && <p className="text-lg" style={{ marginTop: 8 }}>{t('slip.peopleAhead', { count: result.position.ahead || 0 })}</p>}
            {result.position && result.position.eta && !result.position.eta.doctor_unavailable && (
              <p className="text-lg tnum">{t('slip.expectedMinutes', { min: result.position.eta.min_minutes, max: result.position.eta.max_minutes })}</p>
            )}
            <div style={{ marginTop: 16 }}>
              <QrCode value={statusUrl} label={t('kiosk.statusLink')} size={160} />
              <p className="text-soft" style={{ textAlign: 'center', marginTop: 8 }}>{t('kiosk.statusLink')}</p>
              <p className="slip-ref">{result.public_ref}</p>
            </div>
          </TokenSlip>
          <div className="kiosk__bottom">
            <Button size="large" block icon={<PrinterOutlined />} onClick={() => window.print()}>
              {t('kiosk.print')}
            </Button>
            <Button type="primary" size="large" block onClick={reset}>
              {t('kiosk.takeSlip')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={warn != null && mode !== 'scan'}
        onClose={() => setWarn(null)}
        title={t('kiosk.stillThere')}
        body={t('kiosk.stillThereBody', { seconds: warn || 0 })}
        confirmLabel={t('kiosk.imHere')}
        cancelLabel={t('kiosk.startOver')}
        onConfirm={() => {
          setWarn(null);
          resetIdle();
        }}
      />
    </div>
  );
}

function CodeEntry({ onSubmit, pending, error, onStartOver, onTouch }) {
  const { t } = useTranslation();
  const [v, setV] = useState('');
  return (
    <form
      className="kiosk__body"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSubmit(v.trim());
      }}
    >
      <h1 className="kiosk__title">{t('kiosk.enterCode')}</h1>
      <input
        aria-label={t('kiosk.enterCode')}
        className="kiosk__ref-input"
        style={{ fontSize: 'var(--t-lg)', letterSpacing: 0 }}
        value={v}
        onChange={(e) => {
          onTouch();
          setV(e.target.value);
        }}
        autoFocus
        autoComplete="off"
      />
      {error}
      <Button type="primary" size="large" block style={{ maxWidth: 384 }} htmlType="submit" loading={pending}>
        {t('kiosk.checkIn')}
      </Button>
      <Button type="link" size="large" onClick={onStartOver}>
        {t('kiosk.startOver')}
      </Button>
    </form>
  );
}
