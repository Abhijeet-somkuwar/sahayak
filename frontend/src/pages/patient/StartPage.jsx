import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { startIntake } from '../../api/intake';
import { usePatientSession } from '../../context/PatientSessionContext';
import { usePrefs } from '../../context/PrefsContext';
import { useErrorText } from '../../hooks/useErrorText';
import { InlineNotice } from '../../components/ui/Notices';
import { saveIntake } from './intakeStore';

// Starts a conversation with the intake engine and opens it. Needs a patient OTP session.
export default function StartPage() {
  const { facilityCode } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const prefs = usePrefs();
  const patient = usePatientSession();
  const errorText = useErrorText();
  const [error, setError] = useState(null);
  const started = useRef(false);

  useEffect(() => {
    if (!patient.signedIn) {
      navigate(`/f/${facilityCode}/otp?next=${encodeURIComponent(`/f/${facilityCode}/start`)}`, { replace: true });
      return;
    }
    if (started.current) return;
    started.current = true;
    startIntake(facilityCode, prefs.language)
      .then((r) => {
        saveIntake(r.session_id, { ...r, rows: [] });
        navigate(`/intake/${r.session_id}`, { replace: true });
      })
      .catch(setError);
  }, [facilityCode, navigate, patient.signedIn, prefs.language]);

  return (
    <div className="patient-page" style={{ paddingTop: 40 }}>
      {error ? <InlineNotice tone="error">{errorText(error)}</InlineNotice> : <p className="text-soft">{t('common.loading')}…</p>}
    </div>
  );
}
