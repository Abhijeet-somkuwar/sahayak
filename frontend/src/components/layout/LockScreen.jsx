import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useAuth } from '../../context/AuthContext';
import { useErrorText } from '../../hooks/useErrorText';
import { InlineNotice } from '../ui/Notices';

// Shared computers lock after 10 minutes idle; the password unlocks and the page reloads its data.
export default function LockScreen({ onUnlocked }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const errorText = useErrorText();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setPending(true);
    try {
      await auth.unlock(password);
      onUnlocked();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="lock-title" style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', background: 'rgb(10 63 54 / 0.95)', padding: 16 }}>
      <form onSubmit={submit} className="stack sheet" style={{ width: '100%', maxWidth: 384, padding: 24 }}>
        <h1 id="lock-title" className="text-xl row">
          <LockOutlined style={{ color: 'var(--stamp)' }} aria-hidden /> {t('staff.lock.title')}
        </h1>
        <p className="text-soft">{t('staff.lock.body')}</p>
        {auth.user && <p style={{ fontWeight: 500 }}>{auth.user.display_name}</p>}
        <label htmlFor="lock-password" style={{ fontWeight: 500 }}>
          {t('staff.login.password')}
        </label>
        <Input.Password id="lock-password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
        <Button type="primary" htmlType="submit" loading={pending}>
          {t('staff.lock.unlock')}
        </Button>
      </form>
    </div>
  );
}
