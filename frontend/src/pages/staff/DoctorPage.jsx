import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'antd';
import { callNext, getQueueNext, getQueuesToday, getToken, setDoctorStatus, transitionToken } from '../../api/queues';
import { completeEncounter, getEncounter, getPrebrief, regeneratePrebrief, sendPrebriefFeedback } from '../../api/encounters';
import { getPatient } from '../../api/patients';
import { getDoctorSchedules } from '../../api/facility';
import { useAuth } from '../../context/AuthContext';
import { usePrefs } from '../../context/PrefsContext';
import { useLiveResource } from '../../hooks/useLiveResource';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useSecondsSince } from '../../hooks/useSecondsSince';
import { useErrorText } from '../../hooks/useErrorText';
import { ApiError } from '../../utils/errors';
import LaneRail from '../../components/staff/LaneRail';
import PrebriefPanel from '../../components/staff/PrebriefPanel';
import VisitHistory from '../../components/staff/VisitHistory';
import TriageBadge from '../../components/ui/TriageBadge';
import Kbd from '../../components/ui/Kbd';
import { ConfirmDialog, ShortcutHelp } from '../../components/ui/Dialogs';
import { InlineNotice } from '../../components/ui/Notices';
import { DiagnosisForm, PrescriptionForm } from './ClinicalForms';
import './StaffPages.css';

const LANE_NAMES = ['urgent', 'protected', 'general'];
const CURRENT_KEY = 'sahayak.doctor.current';
const thisYear = new Date().getFullYear();
// Bookings and walk-ins go to the morning session before 14:00 IST and to the evening session after it.
const istShiftNow = () => (new Date(Date.now() + 5.5 * 3600_000).getUTCHours() < 14 ? 'morning' : 'evening');
/** The doctor's own department today (all departments for staff without one), current shift first. */
function pickSession(items, departmentId) {
  const pool = departmentId ? items.filter((s) => s.department_id === departmentId) : items;
  return pool.find((s) => s.shift === istShiftNow()) || pool.find((s) => s.status === 'open') || pool[0] || null;
}

/** Doctor console (§4.5): queue rail, pre-brief, action column. Built for 1366×768 without scrolling. */
export default function DoctorPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const prefs = usePrefs();
  const errorText = useErrorText();
  const facilityId = auth.facilityId;

  // ---- today's sessions; the doctor's own department first ----
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const [sessionsTick, setSessionsTick] = useState(0);
  useEffect(() => {
    if (!facilityId) return;
    getQueuesToday(facilityId)
      .then((items) => {
        setSessions(items);
        setSessionId((cur) => (cur && items.some((s) => s.id === cur) ? cur : (pickSession(items, auth.departmentId) || {}).id || ''));
      })
      .catch(() => {});
  }, [facilityId, auth.departmentId, sessionsTick]);
  // A department's queue session is created by its first booking or check-in of the day: until then, look again often.
  useEffect(() => {
    const id = setInterval(() => setSessionsTick((n) => n + 1), sessionId ? 60_000 : 8_000);
    return () => clearInterval(id);
  }, [sessionId]);
  const session = sessions.find((s) => s.id === sessionId) || null;

  // the doctor's consult room today (service point from the duty schedule), sent with call-next so the display and slip show it
  const [servicePointId, setServicePointId] = useState(null);
  useEffect(() => {
    if (!facilityId || !auth.user) return;
    const weekday = ((new Date().getDay() + 6) % 7) + 1; // ISO: Monday = 1
    getDoctorSchedules(facilityId)
      .then((items) => {
        const mine = items.filter((s) => s.user_id === auth.user.id && s.service_point_id);
        const today = mine.find((s) => Number(s.weekday) === weekday) || mine[0];
        setServicePointId(today ? today.service_point_id : null);
      })
      .catch(() => {});
  }, [facilityId, auth.user]);

  // ---- queue rail (next codes per lane) + lane counts, kept live ----
  const [snapshot, setSnapshot] = useState(null);
  const rail = useLiveResource({
    fetcher: () => getQueueNext(sessionId),
    ns: 'staff',
    rooms: sessionId ? [{ kind: 'queue', id: sessionId }] : [],
    events: {
      'queue.snapshot': (p) => {
        setSnapshot(p);
        return undefined;
      },
      'queue.updated': (p, cur, refetch) => {
        if (p.lanes) setSnapshot((s) => ({ ...(s || {}), lanes: p.lanes }));
        refetch();
        return undefined;
      },
      'token.called': (p, cur, refetch) => {
        refetch();
        return undefined;
      },
      'prebrief.ready': (p) => {
        const id = p.encounter_id || p.encounterId;
        if (id && currentRef.current && currentRef.current.encounter && currentRef.current.encounter.id === id) loadPrebrief(id);
        return undefined;
      },
    },
    enabled: !!sessionId,
  });

  // ---- the patient with the doctor now ----
  const [current, setCurrent] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(CURRENT_KEY) || 'null');
    } catch {
      return null;
    }
  });
  const currentRef = useRef(current);
  currentRef.current = current;
  useEffect(() => {
    try {
      if (current) sessionStorage.setItem(CURRENT_KEY, JSON.stringify(current));
      else sessionStorage.removeItem(CURRENT_KEY);
    } catch {
      /* storage blocked */
    }
  }, [current]);

  const loadPrebrief = useCallback(async (encounterId) => {
    try {
      const pb = await getPrebrief(encounterId);
      setCurrent((c) => (c && c.encounter && c.encounter.id === encounterId ? { ...c, prebrief: pb } : c));
    } catch {
      /* not generated yet */
    }
  }, []);

  // after a reload: refresh the token, encounter, patient and pre-brief of the stored current patient
  useEffect(() => {
    const c = currentRef.current;
    if (!c || !c.token) return;
    Promise.all([getToken(c.token.id), getEncounter(c.encounter.id)])
      .then(([token, encounter]) => {
        if (['completed', 'cancelled', 'skipped', 'no_show', 'transferred'].includes(token.status)) return setCurrent(null);
        setCurrent((cur) => (cur ? { ...cur, token, encounter } : cur));
        if (encounter.patient_id) getPatient(encounter.patient_id).then((p) => setCurrent((cur) => (cur ? { ...cur, patient: p } : cur))).catch(() => {});
        loadPrebrief(encounter.id);
        return undefined;
      })
      .catch(() => setCurrent(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Try again" on a summary the AI could not write: queue a new one and wait until a newer pre-brief exists
  const [regenerating, setRegenerating] = useState(false);
  const regenerate = useCallback(async () => {
    const c = currentRef.current;
    if (!c || !c.encounter) return;
    const encounterId = c.encounter.id;
    const oldId = c.prebrief && c.prebrief.prebrief_id;
    setRegenerating(true);
    try {
      await regeneratePrebrief(encounterId);
      const started = Date.now();
      while (Date.now() - started < 60_000) {
        await new Promise((r) => setTimeout(r, 2500));
        const fresh = await getPrebrief(encounterId).catch(() => null);
        if (fresh && fresh.prebrief_id !== oldId) {
          setCurrent((cur) => (cur && cur.encounter && cur.encounter.id === encounterId ? { ...cur, prebrief: fresh } : cur));
          break;
        }
        if (!currentRef.current || currentRef.current.encounter.id !== encounterId) break;
      }
    } catch (e) {
      flash('error', errorText(e));
    } finally {
      setRegenerating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // poll the pre-brief while it is being prepared
  useEffect(() => {
    if (!current || !current.encounter || current.prebrief) return undefined;
    const id = setInterval(() => loadPrebrief(current.encounter.id), 5000);
    return () => clearInterval(id);
  }, [current, loadPrebrief]);

  const [notice, setNotice] = useState(null);
  const noticeTimer = useRef(0);
  const flash = (tone, text) => {
    setNotice({ tone, text });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  };
  const [pending, setPending] = useState(false);

  // Call next: not optimistic, the server decides who is next.
  const doCallNext = async () => {
    if (!sessionId || pending || current) return;
    setPending(true);
    try {
      const r = await callNext(sessionId, servicePointId);
      if (!r) return flash('info', t('doctor.callNextEmpty'));
      const next = { token: r.token, room: r.room, encounter: r.encounter, prebrief: r.prebrief || null, patient: null, calledAt: Date.now() };
      setCurrent(next);
      if (r.encounter && r.encounter.patient_id) getPatient(r.encounter.patient_id).then((p) => setCurrent((c) => (c && c.token.id === r.token.id ? { ...c, patient: p } : c))).catch(() => {});
      if (!r.prebrief) loadPrebrief(r.encounter.id);
    } catch (e) {
      flash('error', e instanceof ApiError && e.code === 'invalid_state' ? t('doctor.noSession') : errorText(e));
    } finally {
      setPending(false);
    }
    return undefined;
  };

  // Transitions carry the version the screen last saw; 412 → reload the token and explain.
  const act = async (action) => {
    if (!current || pending) return;
    setPending(true);
    try {
      if (action === 'complete') {
        await completeEncounter(current.encounter.id);
        setCurrent(null);
      } else {
        const token = await transitionToken(current.token.id, action, current.token.version);
        if (action === 'skip') setCurrent(null);
        else setCurrent((c) => (c ? { ...c, token } : c));
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        flash('error', t('doctor.callingFromAnother'));
        getToken(current.token.id).then((token) => setCurrent((c) => (c ? { ...c, token } : c))).catch(() => setCurrent(null));
      } else flash('error', errorText(e));
    } finally {
      setPending(false);
    }
  };

  const [confirm, setConfirm] = useState(null);
  const [help, setHelp] = useState(false);
  const [openForm, setOpenForm] = useState(null);
  const [status, setStatus] = useState('in_opd');
  const changeStatus = (s) => {
    setStatus(s);
    setDoctorStatus(s, sessionId).catch(() => {});
  };
  const canCall = status === 'in_opd' && !current && !pending && !!sessionId;
  const tokenStatus = current && current.token.status;

  useKeyboardShortcuts(
    [
      { key: 'n', label: t('doctor.kbd.callNext'), handler: () => canCall && doCallNext() },
      { key: 's', label: t('doctor.kbd.start'), handler: () => tokenStatus === 'called' && act('start') },
      { key: 'r', label: t('doctor.kbd.recall'), handler: () => tokenStatus === 'called' && act('recall') },
      { key: 'k', label: t('doctor.kbd.skip'), handler: () => tokenStatus === 'called' && setConfirm('skip') },
      { key: 'c', label: t('doctor.kbd.complete'), handler: () => current && setConfirm('complete') },
      { key: 'd', label: t('doctor.kbd.diagnosis'), handler: () => current && setOpenForm('diagnosis') },
      { key: 'p', label: t('doctor.kbd.prescription'), handler: () => current && setOpenForm('prescription') },
      { key: '?', label: t('staff.shortcuts'), handler: () => setHelp(true) },
    ],
    prefs.shortcutsEnabled && !openForm && !confirm,
  );

  const withYouSec = useSecondsSince(current ? current.calledAt : null, 15000);
  const railTokens = useMemo(() => (rail.data || []).map((x) => ({ id: x.id, code: x.token, lane: LANE_NAMES[x.lane] || 'general', status: 'waiting', callCount: 0 })), [rail.data]);
  const lanes = (snapshot && snapshot.lanes) || (session && session.lanes) || null;
  const avg = snapshot ? snapshot.ewma_consult_sec : session ? session.ewma_consult_sec : null;
  const servers = snapshot ? snapshot.active_servers : session ? session.active_servers : null;
  const patient = current && current.patient;
  const pb = current && current.prebrief;
  const triage = current && (current.encounter.triage_level || (pb && pb.deterministic.today.triage_level));
  const today = pb ? pb.deterministic.today : null;
  const complaint = today
    ? (today.complaint_labels && today.complaint_labels.length ? today.complaint_labels : today.complaint_codes.map((c) => String(c).replace(/^SYM_/, '').replace(/_/g, ' ').toLowerCase())).join(', ')
    : '';

  return (
    <div className="doctor">
      <div className="staff-subheader">
        <span className="font-display" style={{ fontSize: 'var(--t-md)', fontWeight: 600 }}>{session ? session.department || session.token_prefix : t('doctor.selectQueue')}</span>
        {current && current.room && <span>· {current.room}</span>}
        <span>· {auth.user && auth.user.display_name}</span>
        {sessions.length > 1 && (
          <select aria-label={t('doctor.selectQueue')} value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.department || s.token_prefix} · {s.shift}
              </option>
            ))}
          </select>
        )}
        <select aria-label="Status" style={{ marginLeft: 'auto' }} value={status} onChange={(e) => changeStatus(e.target.value)}>
          <option value="in_opd">{t('doctor.status.in_opd')}</option>
          <option value="on_break">{t('doctor.status.break')}</option>
          <option value="off">{t('doctor.status.off')}</option>
        </select>
        <button type="button" style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' }} onClick={() => setHelp(true)} aria-label={t('staff.shortcuts')}>
          ?
        </button>
      </div>

      <div className="doctor__grid">
        <LaneRail
          tokens={railTokens}
          counts={lanes}
          labels={{ urgent: t('doctor.lane.urgent'), protected: t('doctor.lane.protected'), general: t('doctor.lane.general') }}
          footer={
            <>
              {avg != null && <div>{t('doctor.avgConsult', { time: `${Math.floor(avg / 60)}m ${String(Math.round(avg % 60)).padStart(2, '0')}s` })}</div>}
              {servers != null && <div>{t('doctor.doctors', { count: servers })}</div>}
            </>
          }
        />

        <main className="doctor__main" aria-live="polite">
          {current ? (
            <>
              <div className="doctor__head">
                <span className="numeral text-2xl">{current.token.display_code}</span>
                <span className="text-lg" style={{ fontWeight: 500 }}>{patient ? patient.display_name : <span className="skeleton" style={{ width: 140, height: 20 }}>&nbsp;</span>}</span>
                {patient && (
                  <span className="text-soft">
                    · {t(`common.sex.${patient.sex || 'unknown'}`)} · {patient.birth_year ? thisYear - patient.birth_year : '—'}
                  </span>
                )}
                <span style={{ flexBasis: '100%' }} />
                {triage && <TriageBadge level={triage} label={t(`triage.${triage}`)} />}
                {complaint && <span>{complaint}</span>}
              </div>
              <PrebriefPanel
                prebrief={pb}
                pendingText={t('doctor.noPrebriefYet')}
                onFeedback={(helpful) => sendPrebriefFeedback(current.encounter.id, helpful).catch(() => {})}
                onRegenerate={regenerate}
                regenerating={regenerating}
                labels={{
                  allergies: t('prebrief.allergies'),
                  medicines: t('prebrief.medicines'),
                  conditions: t('prebrief.conditions'),
                  today: t('prebrief.today'),
                  none: t('prebrief.none'),
                  summary: t('prebrief.summary'),
                  aiLabel: t('prebrief.aiLabel'),
                  fallback: t('prebrief.fallback'),
                  pending: t('prebrief.pending'),
                  considerAsking: t('prebrief.considerAsking'),
                  recentVisits: t('doctor.recentVisits'),
                  riskFlags: t('doctor.riskFlags'),
                  helpful: t('prebrief.helpful'),
                  notHelpful: t('prebrief.notHelpful'),
                  thanks: t('prebrief.thanks'),
                  history: t('prebrief.history'),
                  keyPoints: t('prebrief.keyPoints'),
                  considerations: t('prebrief.considerations'),
                  considerationsNote: t('prebrief.considerationsNote'),
                  tryAgain: t('prebrief.tryAgain'),
                  regenerating: t('prebrief.regenerating'),
                }}
              />
              {current.encounter.patient_id && (
                <VisitHistory
                  patientId={current.encounter.patient_id}
                  currentEncounterId={current.encounter.id}
                  t={t}
                  labels={{
                    title: t('doctor.history.title'),
                    none: t('doctor.history.none'),
                    complaint: t('doctor.complaint'),
                    triage: t('doctor.history.triage'),
                    diagnosis: t('doctor.history.diagnosis'),
                    medicines: t('prebrief.medicines'),
                    seenBy: t('doctor.history.seenBy'),
                    aiThen: t('doctor.history.aiThen'),
                    aiLabel: t('prebrief.aiLabel'),
                    inProgress: t('doctor.history.inProgress'),
                  }}
                />
              )}
            </>
          ) : (
            <div style={{ padding: 16 }}>
              {sessionId ? <p className="text-soft">{t('doctor.nobody')}</p> : <InlineNotice tone="info">{t('doctor.waitingFirstPatient')}</InlineNotice>}
            </div>
          )}
        </main>

        <aside className="doctor__actions">
          <Button type="primary" onClick={doCallNext} loading={pending && !current} disabled={!canCall}>
            {t('doctor.callNext')} <Kbd>N</Kbd>
          </Button>
          <div className="doctor__with">
            <p className="text-soft">{t('doctor.nowWithYou')}</p>
            {current ? (
              <p className="row" style={{ justifyContent: 'space-between' }}>
                <span className="numeral">{current.token.display_code}</span>
                <span className="tnum text-soft">{t('doctor.minutes', { count: Math.floor(withYouSec / 60) })}</span>
              </p>
            ) : (
              <p className="text-soft">—</p>
            )}
          </div>
          <Button onClick={() => act('start')} disabled={tokenStatus !== 'called' || pending}>
            {t('doctor.start')} <Kbd>S</Kbd>
          </Button>
          <Button onClick={() => act('recall')} disabled={tokenStatus !== 'called' || pending}>
            {t('doctor.recall')} <Kbd>R</Kbd>
          </Button>
          <Button onClick={() => setConfirm('skip')} disabled={tokenStatus !== 'called' || pending}>
            {t('doctor.skip')} <Kbd>K</Kbd>
          </Button>
          <Button onClick={() => setConfirm('complete')} disabled={!current || pending}>
            {t('doctor.complete')} <Kbd>C</Kbd>
          </Button>
          <div className="stack" style={{ gap: 4, marginTop: 8, paddingTop: 8, borderTop: 'var(--rule-width) solid var(--rule)' }}>
            <Button type="link" style={{ justifyContent: 'flex-start' }} onClick={() => setOpenForm('diagnosis')} disabled={!current}>
              {t('doctor.diagnosis')} <Kbd>D</Kbd>
            </Button>
            <Button type="link" style={{ justifyContent: 'flex-start' }} onClick={() => setOpenForm('prescription')} disabled={!current}>
              {t('doctor.prescription')} <Kbd>P</Kbd>
            </Button>
          </div>
          {notice && (
            <InlineNotice tone={notice.tone} className="text-sm" style={{ marginTop: 'auto' }}>
              {notice.text}
            </InlineNotice>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={confirm != null}
        onClose={() => setConfirm(null)}
        title={confirm === 'skip' ? t('doctor.skip') : t('doctor.complete')}
        body={current ? (confirm === 'skip' ? t('doctor.skipConfirm', { code: current.token.display_code }) : t('doctor.completeConfirm', { code: current.token.display_code })) : ''}
        confirmLabel={confirm === 'skip' ? t('doctor.skip') : t('doctor.complete')}
        cancelLabel={t('common.cancel')}
        tone={confirm === 'skip' ? 'danger' : 'primary'}
        onConfirm={() => {
          const a = confirm;
          setConfirm(null);
          if (a) act(a);
        }}
      />
      {current && (
        <>
          <DiagnosisForm encounterId={current.encounter.id} open={openForm === 'diagnosis'} onClose={() => setOpenForm(null)} onSaved={() => flash('success', t('doctor.diagnosisSaved'))} />
          <PrescriptionForm encounterId={current.encounter.id} open={openForm === 'prescription'} onClose={() => setOpenForm(null)} onSaved={() => flash('success', t('doctor.prescriptionSaved'))} />
        </>
      )}
      <ShortcutHelp
        open={help}
        onClose={() => setHelp(false)}
        title={t('staff.shortcuts')}
        shortcuts={[
          { key: 'N', label: t('doctor.kbd.callNext') },
          { key: 'S', label: t('doctor.kbd.start') },
          { key: 'R', label: t('doctor.kbd.recall') },
          { key: 'K', label: t('doctor.kbd.skip') },
          { key: 'C', label: t('doctor.kbd.complete') },
          { key: 'D', label: t('doctor.kbd.diagnosis') },
          { key: 'P', label: t('doctor.kbd.prescription') },
        ]}
      />
    </div>
  );
}
