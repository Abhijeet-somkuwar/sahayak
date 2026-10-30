import { useState } from 'react';
import { Button } from 'antd';
import { DislikeOutlined, LikeOutlined, ReloadOutlined, WarningFilled } from '@ant-design/icons';
import './PrebriefPanel.css';

function Row({ label, children, alert }) {
  return (
    <div className="prebrief__row">
      <dt>{label}</dt>
      <dd className={alert ? 'prebrief__alert' : ''}>
        {alert && <WarningFilled aria-hidden />}
        <span>{children}</span>
      </dd>
    </div>
  );
}

const VITAL_LABEL = { bp_systolic: 'BP sys', bp_diastolic: 'BP dia', pulse: 'Pulse', temp_c: 'Temp', spo2: 'SpO₂', weight_kg: 'Weight', height_cm: 'Height', rbs_mg_dl: 'RBS', resp_rate: 'RR' };

/**
 * The pre-brief as the backend returns it: deterministic facts (allergies, medicines, conditions, today's
 * vitals, risk flags, recent visits) rendered from data in full ink, ALWAYS above the AI narrative
 * ({ headline, history_summary, key_points, considerations, questions_to_consider }), which is visually
 * subordinate and labelled. Considerations are AI suggestions for the doctor, never shown to the patient.
 */
export default function PrebriefPanel({ prebrief, labels, onFeedback, pendingText, onRegenerate, regenerating }) {
  const [feedback, setFeedback] = useState(null);
  if (!prebrief) {
    return (
      <div className="stack" style={{ padding: 16, gap: 8 }} aria-busy>
        <p className="text-soft">{pendingText}</p>
        <span className="skeleton" style={{ height: 20, width: '66%' }}>&nbsp;</span>
        <span className="skeleton" style={{ height: 20, width: '50%' }}>&nbsp;</span>
      </div>
    );
  }
  const d = prebrief.deterministic || {};
  const allergies = d.allergies || [];
  const meds = d.active_medications || [];
  const conditions = d.chronic_conditions || [];
  const vitals = (d.today && d.today.vitals) || [];
  const risk = d.risk_flags || [];
  const visits = d.recent_visits || [];
  const n = prebrief.narrative;
  const status = prebrief.status;

  return (
    <div className="prebrief">
      <dl className="prebrief__facts">
        <Row label={labels.allergies} alert={allergies.length > 0}>
          {allergies.length ? allergies.map((a) => `${a.substance}${a.reaction ? ` (${a.reaction}` : ''}${a.severity && a.severity !== 'unknown' ? `${a.reaction ? ', ' : ' ('}${a.severity})` : a.reaction ? ')' : ''}`).join('; ') : labels.none}
        </Row>
        <Row label={labels.medicines}>{meds.length ? meds.map((m) => [m.drug, m.dose, m.frequency].filter(Boolean).join(' · ')).join(' | ') : labels.none}</Row>
        <Row label={labels.conditions}>{conditions.length ? conditions.join(', ') : labels.none}</Row>
        <Row label={labels.today}>
          {vitals.length ? vitals.map((v) => `${VITAL_LABEL[v.code] || v.code} ${v.value}${v.unit ? ` ${v.unit}` : ''}`).join(' · ') : labels.none}
          {d.today && d.today.red_flags && d.today.red_flags.length > 0 && <span style={{ color: 'var(--triage-emergency)', fontWeight: 500 }}> · {d.today.red_flags.join(', ')}</span>}
        </Row>
        {risk.length > 0 && <Row label={labels.riskFlags}>{risk.map((r) => String(r).replace(/_/g, ' ')).join(', ')}</Row>}
        {visits.length > 0 && (
          <Row label={labels.recentVisits}>
            {visits
              .slice(0, 3)
              .map((v) => `${v.when} · ${[v.where, v.department].filter(Boolean).join(' ')}${v.complaint && v.complaint.length ? ` (${v.complaint.join(', ')})` : ''}${v.diagnoses && v.diagnoses.length ? `: ${v.diagnoses.join(', ')}` : ''}`)
              .join(' | ')}
          </Row>
        )}
      </dl>
      <section className="prebrief__summary" aria-label={labels.summary}>
        <h3 className="text-sm text-soft">
          {labels.summary} {status === 'ready' && n && <span>({labels.aiLabel})</span>}
        </h3>
        {regenerating && <p className="text-soft">{labels.regenerating}</p>}
        {!regenerating && (status === 'fallback' || status === 'failed' || !n) && (
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <p className="text-soft">{labels.fallback}</p>
            {onRegenerate && (
              <Button size="small" icon={<ReloadOutlined />} onClick={onRegenerate}>
                {labels.tryAgain}
              </Button>
            )}
          </div>
        )}
        {!regenerating && status === 'ready' && n && (
          <div className="prose-narrow">
            <p className="prebrief__headline">{n.headline}</p>
            {n.history_summary && (
              <>
                <h4 className="text-sm text-soft" style={{ marginTop: 10 }}>{labels.history}</h4>
                <p>{n.history_summary}</p>
              </>
            )}
            {n.key_points && n.key_points.length > 0 && (
              <>
                <h4 className="text-sm text-soft" style={{ marginTop: 10 }}>{labels.keyPoints}</h4>
                <ul className="prebrief__list">
                  {n.key_points.map((k, i) => (
                    <li key={i}>{typeof k === 'string' ? k : k.text}</li>
                  ))}
                </ul>
              </>
            )}
            {n.considerations && n.considerations.length > 0 && (
              <div className="prebrief__considerations" data-testid="ai-considerations">
                <h4 className="text-sm">
                  {labels.considerations} <span className="text-soft">· {labels.considerationsNote}</span>
                </h4>
                <ol className="prebrief__list">
                  {n.considerations.map((c, i) => (
                    <li key={i}>
                      <strong>{c.condition}</strong>
                      {c.reasoning ? <span className="text-soft">: {c.reasoning}</span> : null}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {n.questions_to_consider && n.questions_to_consider.length > 0 && (
              <>
                <h4 className="text-sm text-soft" style={{ marginTop: 12 }}>{labels.considerAsking}</h4>
                <ul className="prebrief__list">
                  {n.questions_to_consider.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="prebrief__feedback">
              {feedback == null ? (
                <>
                  <Button type="text" icon={<LikeOutlined />} aria-label={labels.helpful} onClick={() => { setFeedback(true); onFeedback && onFeedback(true); }} />
                  <Button type="text" icon={<DislikeOutlined />} aria-label={labels.notHelpful} onClick={() => { setFeedback(false); onFeedback && onFeedback(false); }} />
                </>
              ) : (
                <span className="text-sm text-soft">{labels.thanks}</span>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
