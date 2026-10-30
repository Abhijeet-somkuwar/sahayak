import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { AlertOutlined, PhoneOutlined } from '@ant-design/icons';
import TokenSlip from '../../components/ui/TokenSlip';
import Stamp from '../../components/ui/Stamp';
import QrCode from '../../components/ui/QrCode';
import { DecisionCard } from '../../components/patient/Assistant';
import './PatientPages.css';

// Replaces the whole flow: red tint, siren, the backend's own emergency text, call 108. Nothing else to tap.
export function EmergencyOutcome({ text, assistant }) {
  const { t } = useTranslation();
  const signs = (assistant && assistant.decision && assistant.decision.danger_signs) || [];
  return (
    <div className="emergency fade-in" role="alert">
      <AlertOutlined style={{ fontSize: 80, color: 'var(--triage-emergency)' }} aria-hidden />
      <h1 className="emergency__title">{t('intake.emergency.title')}</h1>
      <p className="prose-narrow text-lg" style={{ whiteSpace: 'pre-line' }}>
        {text}
      </p>
      {signs.length > 0 && <p className="text-lg" style={{ fontWeight: 500 }}>{t('intake.ai.dangerNoticed', { signs: signs.join(', ') })}</p>}
      <a href="tel:108" className="emergency__call">
        <PhoneOutlined aria-hidden /> {t('intake.emergency.call')}
      </a>
    </div>
  );
}

/**
 * The booking slip. The backend's message already contains the department, room, reporting window
 * and ETA; the QR encodes the check-in code (sahayak:enc:<encounter id>). The token number is given at
 * check-in, when the patient also receives the status link.
 */
export function BookingOutcome({ message, encounterId, assistant }) {
  const { t } = useTranslation();
  const facility = import.meta.env.VITE_DEFAULT_FACILITY || 'CHA';
  return (
    <div className="patient-page patient-page--center">
      <div style={{ textAlign: 'center' }}>
        <h1 className="text-xl">{t('intake.opd.title')}</h1>
        <p className="text-soft" style={{ marginTop: 4 }}>{t('intake.opd.subtitle')}</p>
      </div>
      <TokenSlip
        numeral={
          <div className="stack" style={{ gap: 8 }}>
            <p className="text-lg" style={{ whiteSpace: 'pre-line' }}>
              {message.text}
            </p>
            <p className="text-soft">{t('slip.yourNumberAtCheckin')}</p>
          </div>
        }
        stamp={<Stamp text={t('slip.booked')} />}
        footer={
          <Link to={`/f/${facility}`} className="ant-btn ant-btn-default ant-btn-lg btn-patient" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%' }}>
            {t('common.close')}
          </Link>
        }
      >
        <QrCode value={message.link} label={t('slip.showAtGate')} />
        <p className="text-soft" style={{ textAlign: 'center', marginTop: 8 }}>{t('slip.showAtGate')}</p>
        <CheckinCode code={encounterId} />
      </TokenSlip>
      <DecisionCard assistant={assistant} />
    </div>
  );
}

// The check-in code under the QR, with a Copy button: typed or pasted at the kiosk ("Enter the check-in code")
// when the QR cannot be scanned.
function CheckinCode({ code }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!code) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the code stays selectable */
    }
  };
  return (
    <div className="stack" style={{ gap: 4, alignItems: 'center', marginTop: 8 }}>
      <p className="text-sm text-soft">{t('intake.checkinCode')}</p>
      <p className="slip-ref" style={{ fontSize: 'var(--t-sm)', letterSpacing: 0, userSelect: 'all' }} data-testid="checkin-code">
        {code}
      </p>
      <Button size="small" onClick={copy}>
        {copied ? t('intake.codeCopied') : t('intake.copyCode')}
      </Button>
    </div>
  );
}
