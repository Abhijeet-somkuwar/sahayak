import { useTranslation } from 'react-i18next';
import { MedicineBoxOutlined } from '@ant-design/icons';
import { formatDate } from '../../utils/format';
import { medicineParts } from '../../utils/medicine';
import './Patient.css';

const OPEN = new Set(['booked', 'triaged', 'checked_in', 'in_consult']);

/**
 * One visit as the patient sees it: date, department, doctor, their problem, the doctor's diagnosis and the
 * medicines in plain words ("1 tablet, three times a day, for 3 days, by mouth"). Everything here was written
 * by the doctor; nothing is AI-generated.
 */
export default function VisitCard({ visit, showPatient = false, highlight = false }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const rx = visit.prescriptions || [];
  const dx = visit.diagnoses || [];
  return (
    <article className={`visit-card${highlight ? ' visit-card--highlight' : ''}`} data-testid="visit-card">
      <header className="visit-card__head">
        <div>
          <p className="visit-card__date">{formatDate(visit.date, lng)}</p>
          <p className="text-sm text-soft">{[visit.department, visit.doctor].filter(Boolean).join(' · ')}</p>
        </div>
        <span className={`visit-card__status visit-card__status--${OPEN.has(visit.status) ? 'open' : visit.status}`}>
          {t(`visit.status.${visit.status}`, { defaultValue: visit.status })}
        </span>
      </header>
      {showPatient && visit.patient_name && <p className="text-sm">{t('visit.forPatient', { name: visit.patient_name })}</p>}
      {visit.complaint && visit.complaint.length > 0 && (
        <div className="visit-card__field">
          <p className="visit-card__label">{t('visit.youSaid')}</p>
          <p>{visit.complaint.join(', ')}</p>
        </div>
      )}
      {dx.length > 0 && (
        <div className="visit-card__field">
          <p className="visit-card__label">{t('visit.doctorFound')}</p>
          <p className="visit-card__dx">{dx.map((d) => d.text).join(', ')}</p>
        </div>
      )}
      {rx.length > 0 && (
        <div className="visit-card__field">
          <p className="visit-card__label">
            <MedicineBoxOutlined aria-hidden /> {t('visit.medicines')}
          </p>
          <ul className="rx-list">
            {rx.map((p, i) => {
              const m = medicineParts(p, t, lng);
              return (
                <li key={i}>
                  <strong>{m.name}</strong>
                  <span>{m.how}</span>
                  {m.instructions && <span className="text-soft">{m.instructions}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {visit.status === 'completed' && rx.length === 0 && <p className="text-soft">{t('visit.noMedicines')}</p>}
      {OPEN.has(visit.status) && <p className="text-soft">{t('visit.notFinished')}</p>}
      {visit.token && <p className="text-sm text-soft">{t('visit.token', { token: visit.token })}</p>}
    </article>
  );
}
