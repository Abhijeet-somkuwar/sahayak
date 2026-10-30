import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getTokenStatus } from '../../api/tokens';
import { pick } from '../../i18n';
import { useLiveResource } from '../../hooks/useLiveResource';
import { useSecondsSince } from '../../hooks/useSecondsSince';
import { useSocketStatus } from '../../context/SocketContext';
import { connectPatient, disconnect } from '../../services/websocketService';
import { playChime } from '../../utils/audio';
import { ApiError } from '../../utils/errors';
import { useErrorText } from '../../hooks/useErrorText';
import TokenSlip from '../../components/ui/TokenSlip';
import TokenNumeral from '../../components/ui/TokenNumeral';
import Stamp from '../../components/ui/Stamp';
import { InlineNotice, StaleIndicator } from '../../components/ui/Notices';
import { SlipVisitSummary } from './MyVisitsPage';
import './PatientPages.css';

const cacheKey = (ref) => `sahayak.slip.${ref}`;
// Cached so a phone with no signal still shows the last known state. Token code, room and times only.
const readCached = (ref) => {
  try {
    const raw = localStorage.getItem(cacheKey(ref));
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
};

const splitCode = (code) => {
  const m = String(code || '').match(/^([A-Z]+)-?(\d+)$/i);
  return m ? { prefix: m[1].toUpperCase(), number: m[2] } : { prefix: '', number: code || '' };
};

/**
 * The slip status page (/t/<ref>). Public: the API returns the token code, department, room, status,
 * people ahead and an ETA range in minutes. Live updates arrive on the /patient namespace.
 */
export default function SlipPage() {
  const { publicRef } = useParams();
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const errorText = useErrorText();
  const { status: connection } = useSocketStatus('patient');

  useEffect(() => {
    connectPatient(publicRef);
    return () => disconnect('patient');
  }, [publicRef]);

  const { data, error, updatedAt } = useLiveResource({
    fetcher: () => getTokenStatus(publicRef),
    ns: 'patient',
    rooms: [],
    events: {
      'token.status': (p, current) => (current && p.token === current.token ? { ...current, status: p.status, people_ahead: p.people_ahead, eta: p.eta || current.eta, room: p.room || current.room } : undefined),
      'token.called': (p, current) => (current && p.token === current.token ? { ...current, status: 'called', room: p.room || current.room, people_ahead: 0 } : undefined),
    },
    initialData: readCached(publicRef),
  });

  useEffect(() => {
    if (!data) return;
    try {
      localStorage.setItem(cacheKey(publicRef), JSON.stringify(data));
    } catch {
      /* storage blocked */
    }
  }, [data, publicRef]);

  const prevStatus = useRef();
  useEffect(() => {
    if (data && data.status === 'called' && prevStatus.current && prevStatus.current !== 'called') playChime('call');
    prevStatus.current = data && data.status;
  }, [data]);

  const ageSec = useSecondsSince(updatedAt || null, 5000);

  if (error && !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="patient-page" style={{ paddingTop: 24 }}>
        <InlineNotice tone="error">{notFound ? t('slip.notFound') : errorText(error)}</InlineNotice>
      </div>
    );
  }
  if (!data) return <p className="text-soft" style={{ paddingTop: 40 }}>{t('common.loading')}…</p>;

  const { prefix, number } = splitCode(data.token);
  const dept = pick(data.department_i18n, lng) || data.department || '';
  const room = data.room || '—';

  if (data.status === 'called') {
    return (
      <div className="your-turn takeover" role="alert">
        <p className="text-xl" style={{ color: 'var(--board-muted)' }}>{t('slip.yourTurn')}</p>
        <TokenNumeral prefix={prefix} number={number} surface="board" />
        <p className="your-turn__room">{t('slip.goToRoomNow', { room })}</p>
      </div>
    );
  }

  let body;
  switch (data.status) {
    case 'waiting':
      body = (
        <>
          {data.room && <p className="slip-room">{t('slip.room', { room: data.room })}</p>}
          <p key={data.people_ahead} className="crossfade text-lg" style={{ marginTop: 12 }}>
            {t('slip.peopleAhead', { count: data.people_ahead || 0 })}
          </p>
          {data.eta && !data.eta.doctor_unavailable && (
            <p className="text-lg tnum">
              {t('slip.expectedMinutes', { min: data.eta.min_minutes, max: data.eta.max_minutes })}
            </p>
          )}
          {data.eta && data.eta.doctor_unavailable && <p className="text-lg">{t('slip.doctorUnavailable')}</p>}
        </>
      );
      break;
    case 'in_consult':
      body = <p className="text-xl">{t('slip.inConsultation')}</p>;
      break;
    case 'completed':
      body = (
        <>
          <p className="text-xl">{t('slip.done.title')}</p>
          <p className="text-soft" style={{ marginTop: 4 }}>{t('slip.done.body')}</p>
        </>
      );
      break;
    case 'skipped':
    case 'no_show':
      body = (
        <>
          <p className="text-xl">{t('slip.skipped.title')}</p>
          <p className="text-soft" style={{ marginTop: 4 }}>{t('slip.skipped.body')}</p>
        </>
      );
      break;
    case 'cancelled':
      body = (
        <>
          <p className="text-xl">{t('slip.cancelled.title')}</p>
          <p className="text-soft" style={{ marginTop: 4 }}>{t('slip.cancelled.body')}</p>
        </>
      );
      break;
    case 'transferred':
      body = <p className="text-xl">{t('slip.transferred')}</p>;
      break;
    default:
      body = <p className="text-xl">{t(`status.${data.status}`, { defaultValue: data.status })}</p>;
  }
  if (data.session_status === 'closed' && data.status === 'waiting') {
    body = (
      <>
        <p className="text-xl">{t('slip.closed.title')}</p>
        <p className="text-soft" style={{ marginTop: 4 }}>{t('slip.closed.bodyShort')}</p>
      </>
    );
  }

  return (
    <div className="patient-page patient-page--center" style={{ gap: 12, paddingTop: 8 }}>
      <TokenSlip department={dept} numeral={<TokenNumeral prefix={prefix} number={number} />} stamp={<Stamp text={t('slip.checkedIn')} haptic={false} />}>
        {body}
      </TokenSlip>
      {data.status === 'completed' && <SlipVisitSummary publicRef={publicRef} />}
      <StaleIndicator text={`${t('common.updatedAgo', { seconds: ageSec })}${connection !== 'connected' ? ` · ${t('common.offlineKeep')}` : ''}`} />
    </div>
  );
}
