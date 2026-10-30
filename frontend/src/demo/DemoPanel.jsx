import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button, Collapse, Drawer, Popconfirm, Tag, Typography } from 'antd';
import { ExperimentOutlined } from '@ant-design/icons';
import { useAuth } from '../context/AuthContext';
import { useDemoInfo } from '../hooks/useDemoInfo';
import { InlineNotice } from '../components/ui/Notices';
import { PRIMARY, findDevice, formatPhone, homeOf, plainOf, titleOf } from './demoData';
import { useDemoActions } from './useDemoActions';
import './Demo.css';

const { Text } = Typography;

const SCREENS = [
  { slot: 'kiosk', kind: 'kiosk', title: 'Gate kiosk', plain: 'Patients scan their booking QR here and get their token number.' },
  { slot: 'display', kind: 'queue_display', title: 'Waiting-hall TV', plain: 'Shows which token is being called, and to which room.' },
];

/**
 * Development only: a "Demo" button on every screen that opens a panel with every demo login, the device keys,
 * one-click sign-in (here or in a new tab), the step-by-step guide and "Start a fresh demo".
 * Hidden when the backend has no /dev/demo route (production).
 */
export default function DemoPanel() {
  const demo = useDemoInfo();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  if (!demo) return null;
  const onBoard = pathname.startsWith('/display');
  return (
    <>
      <button type="button" className={`demo-fab${onBoard ? ' demo-fab--board' : ''}`} onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="demo-fab">
        <ExperimentOutlined aria-hidden /> Demo
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Demo helper" width={Math.min(460, window.innerWidth)} destroyOnHidden>
        <DemoPanelBody demo={demo} close={() => setOpen(false)} />
      </Drawer>
    </>
  );
}

function DemoPanelBody({ demo, close }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const actions = useDemoActions(demo);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  const primary = PRIMARY.map((p) => demo.staff.find((s) => s.email.startsWith(p))).filter(Boolean);
  const others = demo.staff.filter((s) => !primary.includes(s));
  const otherDoctors = others.filter((s) => s.role === 'doctor');
  const backOffice = others.filter((s) => s.role !== 'doctor');

  const signIn = async (s) => {
    setBusy(s.email);
    setNotice(null);
    try {
      await actions.signInHere(s);
      close();
    } catch (e) {
      setNotice({ tone: 'error', text: `Could not sign in as ${s.email}: ${e.message}` });
    } finally {
      setBusy(null);
    }
  };
  const reset = async () => {
    setNotice(null);
    try {
      const r = await actions.reset();
      setNotice({
        tone: 'success',
        text: `Fresh demo ready: ${r.cancelled + r.completed} leftover tokens cleared, ${r.prealerts_closed} casualty alerts closed. Reload any screens you already have open.`,
      });
    } catch (e) {
      setNotice({ tone: 'error', text: `Could not reset: ${e.message}` });
    }
  };

  const staffCard = (s) => {
    const home = homeOf(s);
    return (
      <div key={s.email} className="demo-card" data-testid={`demo-staff-${s.email.split('@')[0]}`}>
        <div className="demo-card__head">
          <strong>{titleOf(s)}</strong>
          {s.mfa && <Tag>code</Tag>}
        </div>
        <p className="text-sm">{s.display_name}</p>
        <p className="text-sm text-soft">{plainOf(s)}</p>
        <Text className="text-sm" copyable>
          {s.email}
        </Text>
        {home && (
          <div className="demo-panel__row">
            <Button size="small" type="primary" loading={busy === s.email} onClick={() => signIn(s)}>
              Sign in here
            </Button>
            <Button size="small" onClick={() => actions.openStaff(s)}>
              New tab
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="demo-panel">
      <p className="text-soft">Demo mode only. Every login and device key in one place, so you can play each role yourself.</p>
      <div className="demo-panel__row">
        <Button
          type="primary"
          onClick={() => {
            close();
            navigate('/demo');
          }}
        >
          Step-by-step guide
        </Button>
        <Popconfirm title="Start a fresh demo?" description="Clears today's queue and the casualty alerts. Patients and their records stay." okText="Start fresh" onConfirm={reset}>
          <Button>Start a fresh demo</Button>
        </Popconfirm>
      </div>
      {notice && <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>}

      <section className="demo-panel__section">
        <h3>Patient</h3>
        <p className="text-sm text-soft">The patient’s phone. Sign in with any of these numbers. The 6-digit code appears on the screen (no SMS is sent in demo mode).</p>
        <div className="demo-panel__phones">
          {demo.patient_phones.map((p) => (
            <Text key={p} copyable={{ text: p }} code>
              {formatPhone(p)}
            </Text>
          ))}
        </div>
        <div className="demo-panel__row">
          <Button onClick={actions.openPatient}>Open in a new tab</Button>
          <Button
            type="link"
            onClick={() => {
              close();
              navigate(actions.patientUrl);
            }}
          >
            Open here
          </Button>
        </div>
      </section>

      <section className="demo-panel__section">
        <h3>Hospital screens</h3>
        <p className="text-sm text-soft">No login: these screens use a device key. The button saves the key on this computer and opens the screen.</p>
        {SCREENS.map((sc) => {
          const d = findDevice(demo, sc.kind);
          if (!d) return null;
          return (
            <div key={sc.slot} className="demo-card">
              <strong>{sc.title}</strong>
              <p className="text-sm text-soft">{sc.plain}</p>
              <Text className="text-sm" copyable={{ text: d.key }}>
                Device key “{d.label}”: {d.key.slice(0, 14)}…
              </Text>
              <div className="demo-panel__row">
                <Button size="small" type="primary" onClick={() => actions.openScreen(sc.slot)}>
                  Open in a new tab
                </Button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="demo-panel__section">
        <h3>Hospital staff</h3>
        <p className="text-sm">
          Password for every account:{' '}
          <Text copyable code>
            {demo.staff_password}
          </Text>
        </p>
        <p className="text-sm text-soft">
          Accounts marked “code” also need an authenticator code; in demo mode it is filled in for you. Each browser tab keeps its own login, so one tab can be the clerk and
          another the doctor.
        </p>
        {primary.map(staffCard)}
        <Collapse
          size="small"
          items={[
            { key: 'doctors', label: `Other doctors (${otherDoctors.length})`, children: otherDoctors.map(staffCard) },
            { key: 'back', label: `Back-office roles (${backOffice.length})`, children: backOffice.map(staffCard) },
          ]}
        />
      </section>

      {auth.user && (
        <p className="text-sm text-soft">
          This tab is signed in as {auth.user.email}.{' '}
          <Button type="link" size="small" onClick={auth.logout}>
            Sign out
          </Button>
        </p>
      )}
    </div>
  );
}
