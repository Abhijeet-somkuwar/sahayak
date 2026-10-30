import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Form, Input } from 'antd';
import { useAuth } from '../../context/AuthContext';
import { mfaDevCode } from '../../api/auth';
import { useDemoInfo } from '../../hooks/useDemoInfo';
import { titleOf } from '../../demo/demoData';
import { useErrorText } from '../../hooks/useErrorText';
import { useBlurValidation } from '../../hooks/useBlurValidation';
import { rule, validateOtp, validateRequired } from '../../utils/validation';
import { InlineNotice } from '../../components/ui/Notices';
import QrCode from '../../components/ui/QrCode';
import './StaffPages.css';

const homeFor = (role) => (role === 'doctor' || role === 'nurse' ? '/doctor' : role === 'registration_clerk' || role === 'help_desk' ? '/counter' : '/counter');

/**
 * Staff sign-in: email (or phone) + password. Doctors, admins, reviewers and the DPO then enter a
 * 6-digit code from an authenticator app; the first time, the app is enrolled by scanning a QR.
 * In development the backend also hands back the current code (like dev_code on the patient OTP),
 * and the screen shows it with Copy and "Sign in with this code" buttons.
 * Demo mode (development backend): one-click buttons for the main demo accounts, and /login?as=<email>
 * signs the tab in directly (the demo panel opens each role in its own tab this way).
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const errorText = useErrorText();
  const [form] = Form.useForm();
  const [codeForm] = Form.useForm();
  const onBlur = useBlurValidation(form);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [devCode, setDevCode] = useState(null);
  const [copied, setCopied] = useState(false);
  const demo = useDemoInfo();
  const as = params.get('as');
  const signedInAs = auth.user && auth.user.email;

  // already signed in (as the requested demo account, if one was asked for) → go to the right screen
  useEffect(() => {
    if (auth.ready && auth.accessToken && (!as || signedInAs === as)) navigate(params.get('returnTo') || homeFor(auth.role), { replace: true });
  }, [auth.ready, auth.accessToken, auth.role, navigate, params, as, signedInAs]);

  // demo mode: /login?as=<email> signs this tab in as that demo account
  const asTried = useRef(false);
  const { devLogin } = auth;
  useEffect(() => {
    if (!as || !demo || !auth.ready || asTried.current || signedInAs === as) return;
    asTried.current = true;
    setPending(true);
    devLogin(as, demo.staff_password)
      .catch(setError)
      .finally(() => setPending(false));
  }, [as, demo, auth.ready, signedInAs, devLogin]);
  const quickSignIn = async (email) => {
    setPending(true);
    setError(null);
    try {
      await auth.devLogin(email, demo.staff_password);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  const quick = demo ? ['clerk@', 'dr.mehta@', 'nurse@'].map((p) => demo.staff.find((x) => x.email.startsWith(p))).filter(Boolean) : [];

  // MFA enrolment: fetch the otpauth URL once
  useEffect(() => {
    if (auth.mfa && auth.mfa.enrolRequired && !auth.mfa.otpauthUrl) auth.mfaEnrol().catch(setError);
  }, [auth.mfa, auth]);

  // Development only: ask the backend for the current code (404 in production → nothing is shown).
  // Codes change every 30 s, so it is fetched again when the current one expires.
  useEffect(() => {
    if (!auth.mfa || (auth.mfa.enrolRequired && !auth.mfa.otpauthUrl)) return undefined;
    let cancelled = false;
    let timer;
    const fetchCode = async () => {
      try {
        const r = await mfaDevCode(auth.mfa.mfaToken);
        if (cancelled) return;
        setDevCode(r.code);
        timer = setTimeout(fetchCode, Math.max(1, r.seconds_left || 30) * 1000 + 250);
      } catch {
        if (!cancelled) setDevCode(null);
      }
    };
    fetchCode();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [auth.mfa]);

  const submitPassword = async (v) => {
    setPending(true);
    setError(null);
    try {
      await auth.login(v.identifier.trim(), v.password);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  const submitCode = async (v) => {
    setPending(true);
    setError(null);
    try {
      await auth.mfaVerify(v.code);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  const useDevCode = () => {
    codeForm.setFieldsValue({ code: devCode });
    codeForm.submit();
  };
  const copyDevCode = async () => {
    try {
      await navigator.clipboard.writeText(devCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      codeForm.setFieldsValue({ code: devCode }); // clipboard blocked: at least fill the field
    }
  };

  return (
    <main className="login">
      {!auth.mfa ? (
        <Form form={form} layout="vertical" requiredMark={false} className="login__card" onFinish={submitPassword} scrollToFirstError={false}>
          <h1 className="font-display login__title">{t('staff.login.title')}</h1>
          <Form.Item name="identifier" label={t('staff.login.username')} rules={[rule(validateRequired('v.username.required'), t)]} validateTrigger="onSubmit">
            <Input autoComplete="username" autoFocus onBlur={onBlur('identifier')} />
          </Form.Item>
          <Form.Item name="password" label={t('staff.login.password')} rules={[rule(validateRequired('v.password.required'), t)]} validateTrigger="onSubmit">
            <Input.Password autoComplete="current-password" onBlur={onBlur('password')} />
          </Form.Item>
          {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
          <Button type="primary" htmlType="submit" loading={pending} block>
            {t('staff.login.submit')}
          </Button>
          {quick.length > 0 ? (
            <div className="login__demo" data-testid="demo-quick-login">
              <p className="text-sm" style={{ fontWeight: 500 }}>
                Demo mode: sign in with one click (password {demo.staff_password}, codes are filled in for you)
              </p>
              {quick.map((x) => (
                <Button key={x.email} onClick={() => quickSignIn(x.email)} disabled={pending} block>
                  {titleOf(x)}
                  {x.display_name.toLowerCase() !== (titleOf(x).split(',')[0] || '').toLowerCase() ? ` · ${x.display_name}` : ''}
                </Button>
              ))}
              <p className="text-sm text-soft">More accounts: the Demo button at the bottom right of every screen.</p>
            </div>
          ) : (
            <p className="text-sm text-soft">{t('staff.login.demoHint')}</p>
          )}
          {as && pending && <p className="text-soft">Signing in as {as}…</p>}
        </Form>
      ) : (
        <Form form={codeForm} layout="vertical" requiredMark={false} className="login__card" onFinish={submitCode} scrollToFirstError={false}>
          <h1 className="font-display login__title">{t('staff.mfa.title')}</h1>
          {auth.mfa.enrolRequired && (
            <>
              <p className="text-soft">{t('staff.mfa.enrolBody')}</p>
              {auth.mfa.otpauthUrl ? (
                <>
                  <QrCode value={auth.mfa.otpauthUrl} label={t('staff.mfa.qrLabel')} size={200} />
                  <p className="text-sm text-soft">
                    {t('staff.mfa.manualKey')}: <code data-testid="mfa-secret" className="numeral">{new URL(auth.mfa.otpauthUrl).searchParams.get('secret')}</code>
                  </p>
                </>
              ) : (
                <span className="skeleton" style={{ width: 200, height: 200 }}>&nbsp;</span>
              )}
            </>
          )}
          <p className="text-soft">{t('staff.mfa.codeBody')}</p>
          {devCode && (
            <InlineNotice tone="info">
              <span>
                {t('staff.mfa.devCode')}:{' '}
                <strong className="numeral" data-testid="mfa-dev-code" style={{ fontSize: '1.25em', letterSpacing: '0.1em' }}>
                  {devCode}
                </strong>
              </span>
              <span style={{ display: 'inline-flex', gap: 8, marginLeft: 12, verticalAlign: 'middle' }}>
                <Button size="small" onClick={copyDevCode}>
                  {copied ? t('staff.mfa.copied') : t('staff.mfa.copy')}
                </Button>
                <Button size="small" type="primary" onClick={useDevCode} loading={pending}>
                  {t('staff.mfa.useCode')}
                </Button>
              </span>
            </InlineNotice>
          )}
          <Form.Item name="code" label={t('staff.mfa.code')} rules={[rule(validateOtp, t)]} validateTrigger="onSubmit">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus />
          </Form.Item>
          {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
          <Button type="primary" htmlType="submit" loading={pending} block>
            {t('staff.mfa.verify')}
          </Button>
          <Button type="link" onClick={auth.cancelMfa}>
            {t('common.back')}
          </Button>
        </Form>
      )}
    </main>
  );
}
