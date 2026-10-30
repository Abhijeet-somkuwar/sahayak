import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'antd';
import { AlertOutlined } from '@ant-design/icons';
import { acknowledgePrealert, getPrealerts } from '../../api/prealerts';
import { useAuth } from '../../context/AuthContext';
import { useLiveResource } from '../../hooks/useLiveResource';
import { useErrorText } from '../../hooks/useErrorText';
import { playChime } from '../../utils/audio';
import { InlineNotice } from '../../components/ui/Notices';
import './StaffPages.css';

/** Casualty board (§4.7): open pre-alerts newest first; one button, one colour. No names, no identifiers. */
export default function CasualtyPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const errorText = useErrorText();
  const facilityId = auth.facilityId;
  const ackPending = useRef(new Set());

  const { data, error, refetch, setData } = useLiveResource({
    fetcher: () => getPrealerts(facilityId),
    ns: 'staff',
    rooms: facilityId ? [{ kind: 'ed', id: facilityId }] : [],
    events: {
      'ed.prealert': (p, current, refetchFn) => {
        playChime('alert');
        refetchFn();
        return undefined;
      },
    },
    enabled: !!facilityId,
  });

  const ack = async (id) => {
    ackPending.current.add(id);
    try {
      const row = await acknowledgePrealert(id);
      setData((cur) => (cur || []).map((p) => (p.id === id ? row : p)));
    } catch {
      refetch();
    } finally {
      ackPending.current.delete(id);
    }
  };

  const items = (data || []).slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
  const open = items.filter((p) => p.status === 'open');
  const acked = items.filter((p) => p.status === 'acknowledged').slice(0, 8);
  const minutesAgo = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  const summaryOf = (p) => {
    const s = p.summary || {};
    const parts = [s.age_band, s.sex ? t(`common.sex.${s.sex}`) : null, ...(s.complaint_codes || []).map((c) => String(c).replace(/_/g, ' '))].filter(Boolean);
    return parts.join(' · ') || (s.self_harm ? t('ed.selfHarm') : '—');
  };

  return (
    <main className="ed">
      <h1 className="row text-2xl">
        <AlertOutlined style={{ color: 'var(--triage-emergency)' }} aria-hidden /> {t('ed.title')}
      </h1>
      {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
      {open.length === 0 && <p className="text-soft">{t('ed.empty')}</p>}
      <ul className="stack" style={{ listStyle: 'none', gap: 12 }} aria-live="assertive">
        {open.map((p) => (
          <li key={p.id} className="ed__item">
            <div>
              <p className="text-lg" style={{ fontWeight: 500, color: 'var(--triage-emergency)' }}>
                {summaryOf(p)}
              </p>
              {p.summary && p.summary.self_harm && <p style={{ fontWeight: 500 }}>{t('ed.selfHarm')}</p>}
              {p.summary && p.summary.red_flags && p.summary.red_flags.length > 0 && (
                <p style={{ marginTop: 4 }}>
                  <span className="text-soft">{t('ed.redFlags')}:</span> {p.summary.red_flags.join(', ')}
                </p>
              )}
              <p className="text-sm text-soft" style={{ marginTop: 4 }}>
                {t('ed.ago', { minutes: minutesAgo(p.created_at) })}
                {p.summary && p.summary.channel ? ` · ${t('ed.channel', { channel: p.summary.channel })}` : ''}
              </p>
            </div>
            <Button type="primary" danger onClick={() => ack(p.id)} loading={ackPending.current.has(p.id)}>
              {t('ed.acknowledge')}
            </Button>
          </li>
        ))}
      </ul>
      {acked.length > 0 && (
        <ul style={{ listStyle: 'none', marginTop: 16 }}>
          {acked.map((p) => (
            <li key={p.id} className="ed__done">
              <span>{summaryOf(p)}</span>
              <span>{t('ed.acknowledged')}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
