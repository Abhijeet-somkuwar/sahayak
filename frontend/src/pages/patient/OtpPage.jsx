import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Form, Input } from 'antd';
import { usePatientSession } from '../../context/PatientSessionContext';
import { usePrefs } from '../../context/PrefsContext';
import { useErrorText } from '../../hooks/useErrorText';
import { normalizeIndianMobile, rule, validateOtp, validatePhone } from '../../utils/validation';
import { InlineNotice } from '../../components/ui/Notices';
import './PatientPages.css';

// Patient sign-in: mobile number → 6-digit code. In development the backend returns the code too.
export default function OtpPage() {
  const { facilityCode } = useParams();
  const [params] = useSearchParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const prefs = usePrefs();
  const patient = usePatientSession();
  const errorText = useErrorText();
  const [phone, setPhone] = useState('');
  const [devCode, setDevCode] = useState(null);
  const [step, setStep] = useState('phone'); // phone | code
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const next = params.get('next') || `/f/${facilityCode}/start`;

  const sendCode = async (v) => {
    setPending(true);
    setError(null);
    try {
      const p = `+91${normalizeIndianMobile(v.phone)}`;
      const r = await patient.requestOtp(p, prefs.language);
      setPhone(p);
      setDevCode(r.dev_code || null);
      setStep('code');
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  const verify = async (v) => {
    setPending(true);
    setError(null);
    try {
      await patient.verifyOtp(phone, v.code, prefs.language);
      navigate(next, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="patient-page">
      <h1 className="text-xl">{t('otp.title')}</h1>
      {step === 'phone' ? (
        <Form layout="vertical" requiredMark={false} onFinish={sendCode} scrollToFirstError={false} className="stack">
          <Form.Item name="phone" label={t('otp.phone')} extra={t('otp.phoneHint')} rules={[rule(validatePhone, t)]} validateTrigger="onSubmit">
            <Input size="large" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={16} autoFocus />
          </Form.Item>
          {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
          <Button type="primary" size="large" htmlType="submit" loading={pending} block>
            {t('otp.send')}
          </Button>
        </Form>
      ) : (
        <Form layout="vertical" requiredMark={false} onFinish={verify} scrollToFirstError={false} className="stack">
          <p className="text-lg">{t('otp.sentTo', { phone })}</p>
          {devCode && (
            <InlineNotice tone="info">
              {t('otp.devCode')}: <strong className="numeral" data-testid="otp-dev-code">{devCode}</strong>
            </InlineNotice>
          )}
          <Form.Item name="code" label={t('otp.code')} rules={[rule(validateOtp, t)]} validateTrigger="onSubmit">
            <Input size="large" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus />
          </Form.Item>
          {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
          <Button type="primary" size="large" htmlType="submit" loading={pending} block>
            {t('otp.verify')}
          </Button>
          <Button type="link" size="large" onClick={() => setStep('phone')}>
            {t('otp.changeNumber')}
          </Button>
        </Form>
      )}
    </div>
  );
}
