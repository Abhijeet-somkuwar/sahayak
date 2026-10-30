import { useEffect, useState } from 'react';
import { Collapse } from 'antd';
import { getPatientVisits } from '../../api/visits';
import { formatDate, daysAgo } from '../../utils/format';
import { medicineShort } from '../../utils/medicine';
import TriageBadge from '../ui/TriageBadge';
import './VisitHistory.css';

/**
 * The doctor's view of a patient's earlier visits (last 24 months): complaint, triage, the diagnoses and
 * medicines recorded by the doctor, and the AI pre-brief headline written at that visit (labelled).
 * The visit in progress is left out.
 */
export default function VisitHistory({ patientId, currentEncounterId, labels, t }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!patientId) return undefined;
    let alive = true;
    setItems(null);
    getPatientVisits(patientId)
      .then((r) => alive && setItems(r.items.filter((v) => v.id !== currentEncounterId)))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [patientId, currentEncounterId]);

  if (error) return null;
  if (!items) return <span className="skeleton" style={{ height: 24, margin: '0 16px' }}>&nbsp;</span>;

  return (
    <section className="visit-history" aria-label={labels.title} data-testid="visit-history">
      <h3 className="text-sm text-soft">
        {labels.title} · {items.length}
      </h3>
      {items.length === 0 ? (
        <p className="text-soft">{labels.none}</p>
      ) : (
        <Collapse
          size="small"
          defaultActiveKey={items.slice(0, 1).map((v) => v.id)}
          items={items.map((v) => {
            const dx = (v.diagnoses || []).map((d) => d.text).join(', ');
            const open = ['booked', 'triaged', 'checked_in', 'in_consult'].includes(v.status);
            return {
              key: v.id,
              label: (
                <span className="visit-history__label">
                  <strong>{formatDate(v.date)}</strong>
                  <span className="text-soft">{t('doctor.history.daysAgo', { count: daysAgo(v.date) })}</span>
                  <span>· {v.department}</span>
                  <span className="visit-history__dx">· {dx || (v.complaint || []).join(', ') || (open ? labels.inProgress : v.status)}</span>
                </span>
              ),
              children: (
                <dl className="visit-history__facts">
                  {v.complaint && v.complaint.length > 0 && (
                    <div>
                      <dt>{labels.complaint}</dt>
                      <dd>{v.complaint.join(', ')}</dd>
                    </div>
                  )}
                  {v.triage_level && (
                    <div>
                      <dt>{labels.triage}</dt>
                      <dd>
                        <TriageBadge level={v.triage_level} label={t(`triage.${v.triage_level}`)} />
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>{labels.diagnosis}</dt>
                    <dd>{dx || '—'}</dd>
                  </div>
                  <div>
                    <dt>{labels.medicines}</dt>
                    <dd>{v.prescriptions && v.prescriptions.length ? v.prescriptions.map(medicineShort).join(' | ') : '—'}</dd>
                  </div>
                  {v.doctor && (
                    <div>
                      <dt>{labels.seenBy}</dt>
                      <dd>{v.doctor}</dd>
                    </div>
                  )}
                  {v.ai_headline && (
                    <div>
                      <dt>{labels.aiThen}</dt>
                      <dd className="visit-history__ai">
                        {v.ai_headline} <span className="text-soft">({labels.aiLabel})</span>
                      </dd>
                    </div>
                  )}
                </dl>
              ),
            };
          })}
        />
      )}
    </section>
  );
}
