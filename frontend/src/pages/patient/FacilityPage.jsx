import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Input } from 'antd';
import { getFacility } from '../../api/facility';
import { usePatientSession } from '../../context/PatientSessionContext';
import { InlineNotice } from '../../components/ui/Notices';
import { useErrorText } from '../../hooks/useErrorText';
import './PatientPages.css';

// Facility landing: departments open today with live waits, start a visit, or open a slip by its code.
export default function FacilityPage() {
  const { facilityCode } = useParams();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const patient = usePatientSession();
  const errorText = useErrorText();
  const [facility, setFacility] = useState(null);
  const [error, setError] = useState(null);
  const [ref, setRef] = useState('');

  useEffect(() => {
    let alive = true;
    getFacility(facilityCode, i18n.language)
      .then((f) => alive && setFacility(f))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [facilityCode, i18n.language]);

  const startHref = patient.signedIn ? `/f/${facilityCode}/start` : `/f/${facilityCode}/otp?next=${encodeURIComponent(`/f/${facilityCode}/start`)}`;

  return (
    <div className="patient-page">
      <section style={{ paddingTop: 16 }}>
        <p className="text-soft">{t('facility.welcome')}</p>
        <h1 className="font-display text-2xl" style={{ fontWeight: 600, color: 'var(--ward)' }}>
          {facility ? facility.name : <span className="skeleton" style={{ height: 32, width: 256 }}>&nbsp;</span>}
        </h1>
        {facility && facility.address && <p className="text-soft">{facility.address}</p>}
      </section>
      {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}

      <Link to={startHref} className="ant-btn ant-btn-primary ant-btn-lg btn-patient" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        {t('facility.startVisit')}
      </Link>
      {patient.signedIn && (
        <Link to={`/f/${facilityCode}/visits`} className="ant-btn ant-btn-default ant-btn-lg btn-patient" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          {t('visit.myVisits')}
        </Link>
      )}

      <form
        className="stack sheet rule-all"
        style={{ padding: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ref.trim()) navigate(`/t/${ref.trim().toLowerCase()}`);
        }}
      >
        <h2 className="text-lg">{t('facility.haveSlip')}</h2>
        <label htmlFor="slip-ref" style={{ fontWeight: 500 }}>
          {t('facility.enterRef')}
        </label>
        <Input id="slip-ref" size="large" value={ref} onChange={(e) => setRef(e.target.value)} autoComplete="off" />
        <Button size="large" htmlType="submit">
          {t('common.continue')}
        </Button>
      </form>

      {facility && (
        <section>
          <h2 className="text-lg" style={{ marginBottom: 8 }}>
            {t('facility.departments')}
          </h2>
          <ul className="sheet rule-all dept-list">
            {facility.departments.map((d) => (
              <li key={d.id}>
                <span>
                  {d.name}
                  {!d.open_today && <span className="text-sm text-soft"> · {t('facility.closedToday')}</span>}
                </span>
                <span className="text-soft tnum">
                  {d.wait ? t('facility.waitRange', { count: d.wait.waiting, min: d.wait.eta.min_minutes, max: d.wait.eta.max_minutes }) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
