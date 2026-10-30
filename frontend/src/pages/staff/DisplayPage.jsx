import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDisplaySnapshot } from '../../api/tokens';
import { pick } from '../../i18n';
import { useDevice } from '../../context/DeviceContext';
import { useSocketStatus } from '../../context/SocketContext';
import { useLiveResource } from '../../hooks/useLiveResource';
import { useWakeLock } from '../../hooks/useWakeLock';
import { formatTime } from '../../utils/format';
import { playChime } from '../../utils/audio';
import DeviceSetup from '../../components/layout/DeviceSetup';
import TokenNumeral from '../../components/ui/TokenNumeral';
import './StaffPages.css';

const ROTATION = ['en', 'hi', 'gu'];
const splitCode = (code) => {
  const m = String(code || '').match(/^([A-Z]+)-?(\d+)$/i);
  return m ? { prefix: m[1].toUpperCase(), number: m[2] } : { prefix: '', number: code || '' };
};

/** Waiting-hall display (§4.6): painted signboard, token codes and rooms only, labels rotate language every 8 s. */
export default function DisplayPage() {
  const device = useDevice();
  if (!device.deviceKey || device.error) return <DeviceSetup />;
  if (!device.device) return null;
  return <Board device={device.device} />;
}

function Board({ device }) {
  const { i18n, t } = useTranslation();
  const [lang, setLang] = useState(0);
  const [shift, setShift] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [called, setCalled] = useState([]); // most recent calls first: { token, room, at }
  const { status, lastEventAt } = useSocketStatus('display');
  useWakeLock(true);

  const { data: snap, refetch, updatedAt } = useLiveResource({ fetcher: getDisplaySnapshot, ns: 'display', rooms: [], events: {}, pollMs: 15000 });
  const sessions = (snap && snap.items) || [];
  const rooms = sessions.map((s) => ({ kind: 'queue', id: s.queue_session_id }));

  // per-session realtime: a token is called → front of the board + chime; counts change → refresh the snapshot
  const refetchTimer = useRef(0);
  useLiveResource({
    fetcher: async () => null,
    ns: 'display',
    rooms,
    events: {
      'token.called': (p) => {
        setCalled((c) => [{ token: p.token, room: p.room, at: Date.now() }, ...c.filter((x) => x.token !== p.token)].slice(0, 6));
        playChime('call');
        return undefined;
      },
      'queue.updated': () => {
        clearTimeout(refetchTimer.current);
        refetchTimer.current = setTimeout(refetch, 800);
        return undefined;
      },
      'queue.snapshot': () => undefined,
    },
    enabled: rooms.length > 0,
    pollMs: 60000,
  });

  useEffect(() => {
    const a = setInterval(() => setLang((l) => (l + 1) % ROTATION.length), 8000);
    const b = setInterval(() => setShift((s) => (s + 1) % 4), 10 * 60000); // burn-in protection: 2px shift
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(a);
      clearInterval(b);
      clearInterval(c);
    };
  }, []);

  const L = ROTATION[lang];
  const lbl = (key, p) => i18n.getFixedT(L)(key, p);
  const nowServing = sessions.flatMap((s) => s.now_serving.map((n) => ({ ...n, department: s.department, department_i18n: s.department_i18n })));
  const first = called[0] || nowServing[0] || null;
  const others = (called.length ? called.slice(1) : nowServing.slice(1)).slice(0, 3);
  const freshest = Math.max(updatedAt || 0, lastEventAt || 0);
  const staleSec = freshest ? (now - freshest) / 1000 : 0;
  const dim = staleSec > 180 || status === 'disconnected';
  const translate = [[0, 0], [2, 0], [2, 2], [0, 2]][shift];
  const dept = sessions[0];
  const waiting = sessions.reduce((n, s) => n + (s.next ? s.next.length : 0), 0);

  return (
    <div className={`board board-page ${dim ? 'is-dim' : ''}`} style={{ transform: `translate(${translate[0]}px, ${translate[1]}px)` }} lang={L}>
      <header className="board__header">
        <h1>
          {dept && (
            <>
              <span lang="en">{dept.department}</span>
              {L !== 'en' && pick(dept.department_i18n, L) && pick(dept.department_i18n, L) !== dept.department && (
                <>
                  <span style={{ margin: '0 16px', color: 'var(--board-muted)' }}>·</span>
                  <span lang={L}>{pick(dept.department_i18n, L)}</span>
                </>
              )}
            </>
          )}
        </h1>
        <time className="tnum" style={{ color: 'var(--board-muted)' }}>{formatTime(new Date(now).toISOString(), 'en')}</time>
      </header>

      <section className="board__main" aria-live="polite" aria-atomic>
        <p className="board__label">{lbl('display.nowCalling')}</p>
        {first ? (
          <div className="board__now">
            <TokenNumeral prefix={splitCode(first.token).prefix} number={splitCode(first.token).number} surface="board" />
            <div className="board__room">
              <p className="board__label" style={{ fontSize: '4vh' }}>{lbl('display.room')}</p>
              <p className="numeral numeral--board board__room-number">{first.room || '—'}</p>
            </div>
          </div>
        ) : (
          <p className="numeral numeral--board" style={{ fontSize: '10vh', color: 'var(--board-muted)' }}>—</p>
        )}
        {others.length > 0 && (
          <ul className="board__others">
            {others.map((n) => (
              <li key={n.token} className="numeral numeral--board">
                {n.token} <span>→ {n.room || '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="board__recent">
        <small>{lbl('display.next')}</small>
        {sessions.flatMap((s) => s.next.slice(0, 2)).slice(0, 4).map((n) => (
          <span key={n.token} className="numeral numeral--board">
            {n.token}
          </span>
        ))}
        {waiting === 0 && <small>{lbl('display.nobody')}</small>}
      </section>

      <footer className="board__footer">
        <span>{snap ? snap.facility : ''}</span>
        <span>{dim ? lbl('display.reconnecting') : staleSec > 60 && freshest ? lbl('display.lastUpdated', { time: formatTime(new Date(freshest).toISOString(), 'en') }) : t('app.name')}</span>
      </footer>
    </div>
  );
}
