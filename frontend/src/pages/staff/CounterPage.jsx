import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Select } from 'antd';
import { searchPatients } from '../../api/patients';
import { getDepartments } from '../../api/facility';
import { getQueuesToday } from '../../api/queues';
import { createEncounter } from '../../api/encounters';
import { useAuth } from '../../context/AuthContext';
import { useIdempotencyKey } from '../../services/idempotency';
import { useLiveResource } from '../../hooks/useLiveResource';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useErrorText } from '../../hooks/useErrorText';
import { detectSearchKind, digits, normalizeIndianMobile } from '../../utils/validation';
import { pick } from '../../i18n';
import Kbd from '../../components/ui/Kbd';
import QrCode from '../../components/ui/QrCode';
import { ShortcutHelp } from '../../components/ui/Dialogs';
import { InlineNotice } from '../../components/ui/Notices';
import RegisterForm from './RegisterForm';
import './StaffPages.css';

const thisYear = new Date().getFullYear();
const ageOf = (p) => (p.birth_year ? thisYear - p.birth_year : p.age_years != null ? p.age_years : '—');

function useDebounced(v, ms) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

/** Counter (§4.4): search first, keyboard first. Clerks see demographics only. */
export default function CounterPage() {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const auth = useAuth();
  const errorText = useErrorText();
  const facilityId = auth.facilityId;
  const idem = useIdempotencyKey();

  const [q, setQ] = useState('');
  const [district, setDistrict] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [results, setResults] = useState([]);
  const [searchError, setSearchError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [registering, setRegistering] = useState(false);
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState([]);
  const [help, setHelp] = useState(false);
  const [checked, setChecked] = useState(null);
  const [checkinError, setCheckinError] = useState(null);
  const [checkinPending, setCheckinPending] = useState(false);
  const searchRef = useRef(null);

  const kind = detectSearchKind(q);
  const dq = useDebounced(q.trim(), 250);
  const dDistrict = useDebounced(district.trim(), 250);
  const dYear = useDebounced(birthYear.trim(), 250);

  // departments (non-emergency) for the check-in select
  useEffect(() => {
    if (!facilityId) return;
    getDepartments(facilityId)
      .then((items) => {
        const opd = items.filter((d) => !d.is_emergency && d.status !== 'inactive');
        setDepartments(opd);
        setDepartmentId((cur) => cur || (opd[0] && opd[0].id) || '');
      })
      .catch(setSearchError);
  }, [facilityId]);

  // search: phone (10 digits), ABHA (14 digits) or name + district + birth year
  useEffect(() => {
    let params = null;
    if (kind === 'phone' && digits(dq).replace(/^(\+91|91|0)(?=\d{10}$)/, '').length === 10) params = { phone: `+91${normalizeIndianMobile(dq)}` };
    else if (kind === 'abha') params = { abha: digits(dq) };
    else if (kind === 'name' && dq.length >= 2 && dDistrict && /^\d{4}$/.test(dYear)) params = { name: dq, district: dDistrict, birth_year: Number(dYear) };
    if (!params) {
      setResults([]);
      return undefined;
    }
    let alive = true;
    searchPatients(params)
      .then((r) => {
        if (!alive) return;
        setResults(r.items || []);
        setSearchError(null);
        setCursor(0);
      })
      .catch((e) => alive && setSearchError(e));
    return () => {
      alive = false;
    };
  }, [kind, dq, dDistrict, dYear]);

  // live counts in the footer
  const queues = useLiveResource({
    fetcher: () => getQueuesToday(facilityId),
    ns: 'staff',
    rooms: facilityId ? [{ kind: 'facility', id: facilityId }] : [],
    events: {
      'queue.updated': (p, current) =>
        current && p.lanes ? current.map((s) => (s.id === p.queue_session_id ? { ...s, lanes: p.lanes, waiting: p.lanes.urgent + p.lanes.protected + p.lanes.general } : s)) : undefined,
    },
    enabled: !!facilityId,
  });

  const doCheckIn = async () => {
    if (!selected || !departmentId) return;
    setCheckinPending(true);
    setCheckinError(null);
    try {
      const r = await createEncounter({ facility_id: facilityId, patient_id: selected.id, department_id: departmentId, kind: 'opd_new', triage_level: 'routine', check_in: true }, idem.get());
      idem.reset();
      setChecked(r.checkin);
    } catch (e) {
      setCheckinError(e);
    } finally {
      setCheckinPending(false);
    }
  };

  const clear = () => {
    setQ('');
    setDistrict('');
    setBirthYear('');
    setSelected(null);
    setChecked(null);
    setCursor(0);
    setRegistering(false);
    if (searchRef.current) searchRef.current.focus();
  };

  useKeyboardShortcuts([
    { key: '/', label: t('counter.kbd.focus'), handler: () => searchRef.current && searchRef.current.focus() },
    { key: 'ArrowDown', label: t('counter.kbd.move'), handler: () => setCursor((c) => Math.min(results.length - 1, c + 1)), global: true },
    { key: 'ArrowUp', label: t('counter.kbd.move'), handler: () => setCursor((c) => Math.max(0, c - 1)), global: true },
    {
      key: 'Enter',
      label: t('counter.kbd.checkin'),
      handler: () => {
        if (!selected && results[cursor]) setSelected(results[cursor]);
        else if (selected && !checkinPending && !registering && !checked) doCheckIn();
      },
      global: true,
    },
    { key: 'n', label: t('counter.kbd.new'), handler: () => setRegistering(true) },
    { key: 'Escape', label: t('counter.kbd.clear'), handler: clear, global: true },
    { key: '?', label: t('staff.shortcuts'), handler: () => setHelp(true) },
  ]);

  const deptName = (id) => {
    const d = departments.find((x) => x.id === id);
    return d ? pick(d.name_i18n, lng) || d.name : '';
  };
  const statusUrl = checked ? `${window.location.origin}/t/${checked.public_ref}` : '';
  const deptOptions = useMemo(() => departments.map((d) => ({ value: d.id, label: pick(d.name_i18n, lng) || d.name })), [departments, lng]);

  return (
    <div className="counter">
      <div className="counter__cols">
        <section className="counter__search" aria-label={t('counter.results')}>
          <label htmlFor="counter-search" style={{ fontWeight: 500 }}>
            {t('counter.search')}
          </label>
          <Input
            id="counter-search"
            ref={searchRef}
            placeholder={t('counter.searchPlaceholder')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setChecked(null);
            }}
            autoFocus
            autoComplete="off"
            inputMode={kind === 'phone' || kind === 'abha' ? 'numeric' : 'text'}
          />
          <p className="text-sm text-soft" style={{ marginTop: 4 }}>{kind === 'name' ? t('counter.nameSearchHint') : t('counter.searchHint')}</p>
          {kind === 'name' && (
            <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <label htmlFor="counter-district" style={{ fontWeight: 500 }}>{t('counter.district')}</label>
                <Input id="counter-district" value={district} onChange={(e) => setDistrict(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor="counter-year" style={{ fontWeight: 500 }}>{t('counter.birthYear')}</label>
                <Input id="counter-year" inputMode="numeric" maxLength={4} value={birthYear} onChange={(e) => setBirthYear(e.target.value)} />
              </div>
            </div>
          )}
          {searchError && <InlineNotice tone="error" className="text-sm" style={{ marginTop: 8 }}>{errorText(searchError)}</InlineNotice>}

          <h2 className="text-sm text-soft" style={{ margin: '16px 0 4px' }}>{t('counter.results')}</h2>
          <ul className="counter__results" role="listbox" aria-label={t('counter.results')}>
            {results.map((p, i) => (
              <li
                key={p.id}
                role="option"
                aria-selected={!!selected && selected.id === p.id}
                tabIndex={0}
                onClick={() => {
                  setSelected(p);
                  setCursor(i);
                  setChecked(null);
                  setRegistering(false);
                }}
                onKeyDown={(e) => e.key === ' ' && (e.preventDefault(), setSelected(p), setCursor(i))}
                className={`counter__row ${cursor === i ? 'is-cursor' : ''} ${selected && selected.id === p.id ? 'is-selected' : ''}`}
              >
                <span style={{ fontWeight: 500 }}>{p.display_name}</span>
                <span className="text-soft">{t(`common.sex.${p.sex || 'unknown'}`).slice(0, 1)}</span>
                <span className="tnum text-soft">{ageOf(p)}</span>
                <span className="text-soft">{p.relationship ? t(`counter.rel.${p.relationship}`) : ''}</span>
              </li>
            ))}
            {dq.length >= 2 && results.length === 0 && kind !== 'empty' && <li className="text-sm text-soft" style={{ padding: '12px 8px' }}>{t('counter.noResults')}</li>}
          </ul>
          <Button style={{ marginTop: 12 }} onClick={() => setRegistering(true)}>
            + {t('counter.registerNew')} <Kbd>N</Kbd>
          </Button>
        </section>

        <section className="counter__detail" aria-label={t('counter.selected')}>
          {registering ? (
            <RegisterForm
              onCancel={() => setRegistering(false)}
              onRegistered={(p) => {
                setRegistering(false);
                setSelected(p);
              }}
            />
          ) : !selected ? (
            <p className="text-soft">{t('counter.nobodySelected')}</p>
          ) : (
            <div className="stack" style={{ maxWidth: 560 }}>
              <div>
                <h2 className="text-sm text-soft">{t('counter.selected')}</h2>
                <p className="text-xl">
                  {selected.display_name} · {t(`common.sex.${selected.sex || 'unknown'}`)} · {t('counter.ageAbout', { age: ageOf(selected) })}
                </p>
                {results.length > 1 && (
                  <p className="text-sm text-soft">
                    {t('counter.household')}: {results.filter((h) => h.id !== selected.id).map((h) => h.display_name).join(', ')}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="counter-department" style={{ fontWeight: 500 }}>
                  {t('counter.department')}
                </label>
                <Select id="counter-department" style={{ width: '100%' }} value={departmentId || undefined} onChange={setDepartmentId} options={deptOptions} />
              </div>
              {checked ? (
                <InlineNotice tone="success">
                  <p>{t('counter.checkedIn', { code: checked.token.display_code })}</p>
                  {checked.position && checked.position.room && <p>{t('kiosk.goTo', { room: checked.position.room })}</p>}
                  <div className="row" style={{ marginTop: 12, alignItems: 'flex-start', gap: 16 }}>
                    <QrCode value={statusUrl} label={t('counter.statusLink')} size={120} />
                    <div>
                      <p className="text-sm">{t('counter.statusLink')}</p>
                      <p className="numeral">{checked.public_ref}</p>
                      <Button size="small" onClick={() => window.print()} style={{ marginTop: 8 }}>
                        {t('kiosk.print')}
                      </Button>
                    </div>
                  </div>
                </InlineNotice>
              ) : (
                <Button type="primary" onClick={doCheckIn} loading={checkinPending} disabled={!departmentId}>
                  {t('counter.checkIn', { department: deptName(departmentId) })} <Kbd>Enter</Kbd>
                </Button>
              )}
              {checkinError && <InlineNotice tone="error">{errorText(checkinError)}</InlineNotice>}
            </div>
          )}
        </section>
      </div>

      <footer className="counter__footer" aria-live="polite">
        <span className="text-soft">{t('counter.liveCounts')}:</span>
        {(queues.data || []).map((s) => (
          <span key={s.id}>
            <span style={{ fontWeight: 500 }}>{s.department || s.token_prefix}</span> <span className="tnum">{t('counter.waiting', { count: s.waiting })}</span>
          </span>
        ))}
        <button type="button" style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--ink-soft)', cursor: 'pointer' }} onClick={() => setHelp(true)} aria-label={t('staff.shortcuts')}>
          ?
        </button>
      </footer>

      <ShortcutHelp
        open={help}
        onClose={() => setHelp(false)}
        title={t('staff.shortcuts')}
        shortcuts={[
          { key: '/', label: t('counter.kbd.focus') },
          { key: '↑ ↓', label: t('counter.kbd.move') },
          { key: 'Enter', label: t('counter.kbd.checkin') },
          { key: 'N', label: t('counter.kbd.new') },
          { key: 'Esc', label: t('counter.kbd.clear') },
        ]}
      />
    </div>
  );
}
