import { useTranslation } from 'react-i18next';
import { RobotOutlined } from '@ant-design/icons';
import TriageBadge from '../ui/TriageBadge';
import './Patient.css';

/**
 * The visible face of the AI-assisted intake. Everything here renders structured data from the backend
 * (catalogue symptom labels, the rules engine's urgency level, the routed department and how it was chosen)
 * with reviewed UI strings. 🔒 No AI-written text and no diagnosis is ever shown to the patient.
 */

export function AssistantHeader({ mode }) {
  const { t } = useTranslation();
  const guided = mode === 'structured_fallback';
  return (
    <header className="assistant-head">
      <span className="assistant-avatar" aria-hidden>
        <RobotOutlined />
      </span>
      <div>
        <p className="assistant-head__name">
          {t('intake.ai.name')} <span className={`ai-badge${guided ? ' ai-badge--plain' : ''}`}>{guided ? t('intake.ai.guided') : t('intake.ai.badge')}</span>
        </p>
        <p className="text-sm text-soft">{guided ? t('intake.ai.subGuided') : t('intake.ai.sub')}</p>
      </div>
    </header>
  );
}

/** Three animated dots in an assistant bubble while the backend works. */
export function Thinking({ text }) {
  return (
    <div className="bubble bubble--bot bubble--thinking" role="status">
      <span className="dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="text-soft">{text}</span>
    </div>
  );
}

export function durationText(t, hours) {
  if (hours == null || Number.isNaN(Number(hours))) return null;
  const h = Number(hours);
  return h >= 24 && h % 24 === 0 ? t('intake.ai.days', { count: h / 24 }) : h >= 48 ? t('intake.ai.days', { count: Math.round(h / 24) }) : t('intake.ai.hours', { count: h });
}

/** "Here is what I understood": the catalogue symptoms the assistant matched in the patient's own words. */
export function UnderstoodCard({ understood, showNext = true }) {
  const { t } = useTranslation();
  if (!understood || !understood.symptoms || understood.symptoms.length === 0) return null;
  const since = durationText(t, understood.duration_hours);
  return (
    <div className="bubble bubble--bot bubble--card" data-testid="ai-understood">
      <p className="assistant-card__title">
        <span className="ai-badge">{t('intake.ai.badge')}</span> {t('intake.ai.understood')}
      </p>
      <div className="chips">
        {understood.symptoms.map((s) => (
          <span key={s.code} className="chip">
            {s.label}
          </span>
        ))}
        {since && (
          <span className="chip chip--soft">
            {t('intake.ai.since')}: {since}
          </span>
        )}
      </div>
      {showNext && <p className="text-sm text-soft">{t('intake.ai.nextQuestions')}</p>}
    </div>
  );
}

/** "How Sahayak decided": urgency from the clinical rules, the department and how it was chosen. */
export function DecisionCard({ assistant }) {
  const { t } = useTranslation();
  const d = assistant && assistant.decision;
  if (!d) return null;
  const u = assistant.understood;
  const since = u ? durationText(t, u.duration_hours) : null;
  return (
    <section className="assistant-decision" aria-label={t('intake.ai.howDecided')} data-testid="ai-decision">
      <h2 className="assistant-card__title">
        <span className="assistant-avatar assistant-avatar--small" aria-hidden>
          <RobotOutlined />
        </span>
        {t('intake.ai.howDecided')} <span className="ai-badge">{t('intake.ai.badge')}</span>
      </h2>
      <dl className="assistant-decision__rows">
        {u && u.symptoms && u.symptoms.length > 0 && (
          <div>
            <dt>{t('intake.ai.youTold')}</dt>
            <dd>
              {u.symptoms.map((s) => s.label).join(', ')}
              {since ? ` · ${since}` : ''}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('intake.ai.urgency')}</dt>
          <dd>
            <TriageBadge level={d.level} label={t(`triage.${d.level}`)} /> <span>{t(`intake.ai.level.${d.level}`)}</span>
          </dd>
        </div>
        {d.department && (
          <div>
            <dt>{t('intake.ai.department')}</dt>
            <dd>
              <strong>{d.department}</strong>
              {d.routing_method && t(`intake.ai.route.${d.routing_method}`, { defaultValue: '' }) && (
                <span className="text-soft">({t(`intake.ai.route.${d.routing_method}`)})</span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('intake.ai.checked')}</dt>
          <dd>{t('intake.ai.checkedBody', { count: assistant.questions_asked || 0 })}</dd>
        </div>
      </dl>
      <p className="assistant-decision__note">{t('intake.ai.notDiagnosis')}</p>
    </section>
  );
}
