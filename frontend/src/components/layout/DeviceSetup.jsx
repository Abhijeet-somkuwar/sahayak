import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from 'antd';
import { useDevice } from '../../context/DeviceContext';
import { useDemoInfo } from '../../hooks/useDemoInfo';
import { InlineNotice } from '../ui/Notices';
import '../../pages/staff/StaffPages.css';

const KIND_FOR_SLOT = { kiosk: 'kiosk', display: 'queue_display' };

// First-run screen for a kiosk or display: paste the device key an admin created. Stored on this device only.
// In development the demo keys are offered as one-click buttons.
export default function DeviceSetup() {
  const { t } = useTranslation();
  const device = useDevice();
  const demo = useDemoInfo();
  const [key, setKey] = useState('');
  const demoKeys = demo ? demo.devices.filter((d) => d.kind === KIND_FOR_SLOT[device.slot]) : [];
  return (
    <main className="device-setup">
      <form
        className="login__card"
        onSubmit={(e) => {
          e.preventDefault();
          device.setDeviceKey(key);
        }}
      >
        <h1 className="font-display login__title">{t('device.title')}</h1>
        <p className="text-soft">{t('device.body')}</p>
        {demoKeys.length > 0 && (
          <InlineNotice tone="info">
            <p style={{ marginBottom: 8 }}>Demo mode: this screen can use the demo key, no copying needed.</p>
            {demoKeys.map((d) => (
              <Button key={d.label} type="primary" onClick={() => device.setDeviceKey(d.key)} data-testid="use-demo-device-key">
                Use the demo key “{d.label}”
              </Button>
            ))}
          </InlineNotice>
        )}
        <label htmlFor="device-key" style={{ fontWeight: 500 }}>
          {t('device.key')}
        </label>
        <Input id="device-key" value={key} onChange={(e) => setKey(e.target.value)} autoFocus autoComplete="off" />
        {device.error && <InlineNotice tone="error">{t('device.invalid')}</InlineNotice>}
        <Button type={demoKeys.length ? 'default' : 'primary'} htmlType="submit" block>
          {t('device.save')}
        </Button>
      </form>
    </main>
  );
}
