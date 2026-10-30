import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getMyVisits, getMyVisitByRef } from '../../api/visits';
import { usePatientSession } from '../../context/PatientSessionContext';
import { useErrorText } from '../../hooks/useErrorText';
import { ApiError } from '../../utils/errors';
import { InlineNotice } from '../../components/ui/Notices';
import VisitCard from '../../components/patient/VisitCard';
import './PatientPages.css';

const FACILITY = import.meta.env.VITE_DEFAULT_FACILITY || 'CHA';

/** /f/:facilityCode/visits: every visit booked from this phone, with the doctor's diagnosis and medicines. */
export default function MyVisitsPage() {
  const { facilityCode } = useParams();
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const patient = usePatientSession();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!patient.signedIn) return undefined;
    let alive = true;
    getMyVisits(i18n.language)
      .then((r) => alive && setItems(r.items))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [patient.signedIn, i18n.language]);

  if (!patient.signedIn) return <Navigate to={`/f/${facilityCode}/otp?next=${encodeURIComponent(`/f/${facilityCode}/visits`)}`} replace />;
  const family = items ? new Set(items.map((v) => v.patient_id)).size > 1 : false;

  return (
    <div className="patient-page" style={{ gap: 16 }}>
      <section style={{ paddingTop: 8 }}>
        <h1 className="font-display text-2xl" style={{ fontWeight: 600, color: 'var(--ward)' }}>
          {t('visit.myVisits')}
        </h1>
        <p className="text-soft">{t('visit.myVisitsBody')}</p>
      </section>
      {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
      {!items && !error && <span className="skeleton" style={{ height: 160 }}>&nbsp;</span>}
      {items && items.length === 0 && <p className="text-soft">{t('visit.none')}</p>}
      {items && items.map((v, i) => <VisitCard key={v.id} visit={v} showPatient={family} highlight={i === 0} />)}
      <Link to={`/f/${facilityCode}`} className="ant-btn ant-btn-default ant-btn-lg btn-patient" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        {t('common.back')}
      </Link>
    </div>
  );
}

/**
 * Under a completed slip: the doctor's diagnosis and medicines for this visit. The slip link itself is public,
 * so this needs the patient to be signed in on the phone that booked the visit.
 */
export function SlipVisitSummary({ publicRef }) {
  const { t, i18n } = useTranslation();
  const patient = usePatientSession();
  const [visit, setVisit] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!patient.signedIn) return undefined;
    let alive = true;
    getMyVisitByRef(publicRef, i18n.language)
      .then((v) => alive && setVisit(v))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [patient.signedIn, publicRef, i18n.language]);

  if (!patient.signedIn) {
    return (
      <div className="stack" style={{ width: '100%', gap: 8 }}>
        <p>{t('visit.signInToSee')}</p>
        <Link
          to={`/f/${FACILITY}/otp?next=${encodeURIComponent(`/t/${publicRef}`)}`}
          className="ant-btn ant-btn-primary ant-btn-lg btn-patient"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {t('visit.signIn')}
        </Link>
      </div>
    );
  }
  if (error) return <p className="text-soft">{error instanceof ApiError && error.status === 404 ? t('visit.notYours') : t('err.generic', { requestId: '—' })}</p>;
  if (!visit) return <span className="skeleton" style={{ height: 120, width: '100%' }}>&nbsp;</span>;
  return (
    <div className="stack" style={{ width: '100%', gap: 8 }}>
      <VisitCard visit={visit} highlight />
      {visit.prescriptions && visit.prescriptions.length > 0 && <p className="text-soft">{t('visit.pharmacy')}</p>}
      <Link to={`/f/${FACILITY}/visits`}>{t('visit.allVisits')}</Link>
    </div>
  );
}
