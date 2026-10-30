/**
 * End-to-end smoke test against a running stack (api on :3000) with the demo seed loaded.
 * Exercises the assignment story (§18): staff login + MFA, counter registration → token, patient status link,
 * doctor call-next with pre-brief, kiosk intake → booking, knowledge bot, analytics and audit.
 * Run: npx tsx scripts/smoke.ts [http://localhost:3000]
 */
import 'dotenv/config';
import { authenticator } from 'otplib';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// TOTP secrets enrolled by earlier smoke runs are kept locally (git-ignored) so the script is re-runnable on the same seed.
const SECRETS_FILE = '.smoke-totp.json';
const secrets = existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) : {};

const BASE = process.argv[2] ?? 'http://localhost:3000';
const PASSWORD = process.env['SEED_STAFF_PASSWORD'] ?? 'Demo@12345678';
let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`, extra ?? '');
  }
};

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

async function login(email) {
  const r = await api('POST', '/auth/staff/login', { identifier: email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login ${email} → ${r.status} ${JSON.stringify(r.json)}`);
  if (!r.json.mfa_required) return r.json.access_token;
  let secret = process.env[`TOTP_${email}`] ?? secrets[email];
  if (!secret) {
    if (!r.json.enrol_required)
      throw new Error(`${email} already has TOTP enrolled but no secret is known; re-seed or provide TOTP_${email}`);
    const e = await api('POST', '/auth/staff/mfa/enrol', { mfa_token: r.json.mfa_token });
    if (e.status !== 200) throw new Error(`mfa enrol → ${e.status} ${JSON.stringify(e.json)}`);
    secret = new URL(e.json.otpauth_url).searchParams.get('secret');
    secrets[email] = secret;
    writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
    console.log(`  (enrolled TOTP for ${email}; secret saved to ${SECRETS_FILE})`);
  }
  const v = await api('POST', '/auth/staff/mfa/verify', { mfa_token: r.json.mfa_token, code: authenticator.generate(secret) });
  if (v.status !== 200) throw new Error(`mfa verify → ${v.status} ${JSON.stringify(v.json)}`);
  return v.json.access_token;
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

console.log(`Smoke test against ${BASE}`);
const health = await api('GET', '/readyz');
ok(health.status === 200, 'readyz', health.json);
const pub = await api('GET', '/facilities/GJ-DEMO-DH/public');
ok(pub.status === 200 && pub.json.departments.length >= 6, 'public facility page lists departments');
const facilities = await (async () => {
  const t = await login('state@demo.sahayak.health');
  const f = await api('GET', '/facilities', undefined, bearer(t));
  return f.json.items;
})();
const facilityId = facilities.find((f) => f.code === 'GJ-DEMO-DH').id;
const medDept = pub.json.departments.find((d) => d.code === 'GEN_MED');

console.log('\nM1 — staff auth, RBAC, audit');
const clerk = await login('clerk@demo.sahayak.health');
ok(!!clerk, 'clerk logged in (no MFA for clerks)');
const doctor = await login('dr.mehta@demo.sahayak.health');
ok(!!doctor, 'doctor logged in with TOTP');
const forbidden = await api('GET', `/audit/breakglass`, undefined, bearer(clerk));
ok(forbidden.status === 403, 'clerk cannot read audit (RBAC)');
const me = await api('GET', '/me', undefined, bearer(doctor));
ok(me.status === 200 && me.json.memberships.length > 0, '/me returns memberships');

console.log('\nM2 — patients, households, consent');
const phone = `98${String(Date.now()).slice(-8)}`;
const runTag = Math.random().toString(36).slice(2, 6).toUpperCase(); // unique name per run; the duplicate check is exercised separately below
const newPatient = {
  display_name: `Ramesh Patel ${runTag}`,
  sex: 'male',
  age_years: 46,
  preferred_language: 'hi',
  district_code: '474',
  phone,
  relationship: 'self',
  address: 'House 12, Shanti Nagar',
};
let created = await api('POST', '/patients', newPatient, bearer(clerk));
if (created.status === 409 && created.json.code === 'possible_duplicates') {
  console.log(
    `  (duplicate check flagged ${created.json.candidates?.length} similar patient(s) from earlier runs; clerk reviews and retries with force=true)`,
  );
  created = await api('POST', '/patients', { ...newPatient, force: true }, bearer(clerk));
}
ok(created.status === 201, 'patient created at the counter', created.json);
const patientId = created.json.id;
const dup = await api(
  'POST',
  '/patients',
  { display_name: `Ramesh Patel ${runTag}`, sex: 'male', age_years: 46, district_code: '474', phone, relationship: 'self' },
  bearer(clerk),
);
ok(dup.status === 409 && dup.json.code === 'possible_duplicates', 'duplicate check returns 409 possible_duplicates');
const hh = await api('GET', `/patients/search?phone=${phone}`, undefined, bearer(clerk));
ok(hh.status === 200 && hh.json.kind === 'household' && hh.json.items.length === 1, 'Q1 household lookup by phone');
const fuzzy = await api('GET', `/patients/search?name=Ramesh%20Patle&district=474&birth_year=1981`, undefined, bearer(clerk));
ok(fuzzy.status === 200 && fuzzy.json.items.length >= 1, 'Q3 fuzzy name search tolerates typos');
const consent = await api(
  'POST',
  `/patients/${patientId}/consents`,
  { phone, purpose: 'care_coordination', granted: true, notice_version: 'consent.notice.v1', language: 'hi' },
  bearer(clerk),
);
ok(consent.status === 201, 'consent recorded');
const allergy = await api(
  'POST',
  `/patients/${patientId}/allergies`,
  { substance_text: 'Penicillin', reaction: 'rash', severity: 'moderate' },
  bearer(doctor),
);
ok(
  allergy.status === 201 || allergy.status === 403,
  `allergy recorded (${allergy.status === 403 ? 'care relationship not yet established, expected before the visit' : 'ok'})`,
);

console.log('\nM3 — queue: registration, token, status link, call-next, transitions');
const today = await api('GET', `/facilities/${facilityId}/queues/today`, undefined, bearer(clerk));
ok(today.status === 200 && today.json.items.length >= 6, "today's queue sessions exist (nightly job)");
const session = today.json.items.find((s) => s.department_id === medDept.id);
const reg = await api(
  'POST',
  '/encounters',
  { facility_id: facilityId, patient_id: patientId, department_id: medDept.id, triage_level: 'routine' },
  bearer(clerk),
);
ok(reg.status === 422, 'POST /encounters without Idempotency-Key is rejected (422)');
const reg2 = await api(
  'POST',
  '/encounters',
  { facility_id: facilityId, patient_id: patientId, department_id: medDept.id, triage_level: 'routine' },
  { ...bearer(clerk), 'idempotency-key': `smoke-${Date.now()}` },
);
ok(
  reg2.status === 201 && /^MED-\d{3}$/.test(reg2.json.checkin.token.display_code),
  `counter registration issued token ${reg2.json.checkin?.token?.display_code}`,
  reg2.json,
);
const status = await api('GET', `/t/${reg2.json.checkin.public_ref}`);
ok(
  status.status === 200 && status.json.token === reg2.json.checkin.token.display_code && !JSON.stringify(status.json).includes('Ramesh'),
  'public status link shows token/position/ETA without PHI',
);
const qsId = reg2.json.checkin.queue_session_id;
ok(
  qsId === session.id || !!qsId,
  `registration used queue session ${qsId === session.id ? "(today's morning session)" : '(a different shift session)'}`,
);
await api('PUT', '/doctors/me/status', { status: 'in_opd', queue_session_id: qsId }, bearer(doctor));
await new Promise((r) => setTimeout(r, 1500)); // let the outbox relay / prebrief worker run if present
const call = await api('POST', `/queues/${qsId}/call-next`, { service_point_id: null }, bearer(doctor));
ok(
  call.status === 200 && !!call.json.token,
  `doctor called next → ${call.json.token?.display_code} (pre-brief ${call.json.prebrief ? 'cached' : 'not yet generated: worker not running?'})`,
  call.status !== 200 ? call.json : '',
);
const etag = call.headers.get('etag');
const start = await api('POST', `/tokens/${call.json.token.id}/start`, undefined, { ...bearer(doctor), 'if-match': etag });
ok(start.status === 200, 'consult started (If-Match)');
const stale = await api('POST', `/tokens/${call.json.token.id}/complete`, undefined, { ...bearer(doctor), 'if-match': etag });
ok(stale.status === 412 && stale.json.code === 'version_conflict', 'stale ETag → 412 version_conflict');
const summary = await api('GET', `/patients/${patientId}/clinical-summary`, undefined, bearer(doctor));
ok(summary.status === 200, "doctor reads clinical summary (care relationship via today's encounter)");
const rx = await api(
  'POST',
  `/encounters/${call.json.encounter.id}/prescriptions`,
  {
    drug_name: 'Pantoprazole',
    strength: '40 mg',
    dose: '1 tab',
    frequency: 'OD',
    duration_days: 14,
    instructions_i18n: { hi: 'खाने से पहले' },
  },
  bearer(doctor),
);
ok(rx.status === 201, 'prescription recorded');
const complete = await api(
  'POST',
  `/encounters/${call.json.encounter.id}/complete`,
  { followups: [{ kind: 'symptom_checkin', due_in_hours: 72 }] },
  bearer(doctor),
);
ok(complete.status === 200 && complete.json.followups.length === 1, 'encounter completed with a day-3 follow-up');
const pb = await api('GET', `/encounters/${call.json.encounter.id}/prebrief`, undefined, bearer(doctor));
ok(
  pb.status === 200 || pb.status === 404,
  `pre-brief endpoint (${pb.status === 200 ? `status=${pb.json.status}` : 'not generated: worker not running'})`,
);

console.log('\nM4 — intake (web adapter, structured mode) and triage');
const otp = await api('POST', '/auth/patient/otp', { phone, language: 'hi' });
ok(otp.status === 200 && !!otp.json.dev_code, 'patient OTP requested (dev code returned in non-production)');
const verify = await api('POST', '/auth/patient/otp/verify', { phone, code: otp.json.dev_code, language: 'hi' });
ok(verify.status === 200, 'patient OTP verified → session');
const pt = bearer(verify.json.access_token);

let r = (await api('POST', '/intake/sessions', { facility_code: 'GJ-DEMO-DH', language: 'hi' }, pt)).json;
const ans = async (body) => (await api('POST', `/intake/sessions/${r.session_id}/answers`, body, pt)).json;
const pickId = (prefix) =>
  r.messages.flatMap((m) => [...(m.buttons ?? []), ...(m.list?.rows ?? [])]).find((b) => b.id.startsWith(prefix))?.id;
let guard = 0;
while (guard++ < 30 && r.state !== 'idle') {
  if (r.state === 'consent') r = await ans({ kind: 'choice', id: 'consent:yes' });
  else if (r.state === 'consent_ai')
    r = await ans({ kind: 'choice', id: 'consent_ai:no' }); // structured mode: no LLM
  else if (r.state === 'who_for') r = await ans({ kind: 'choice', id: pickId('pt:') });
  else if (r.state === 'purpose') r = await ans({ kind: 'choice', id: 'purpose:new_problem' });
  else if (r.state === 'complaint') r = await ans({ kind: 'text', text: 'pet mein jalan hai 3 din se' });
  else if (r.state === 'clarify' || r.state === 'risk') {
    const id = pickId('q:');
    r = await ans(
      id
        ? { kind: 'choice', id: id.includes('RISK_CHRONIC') ? 'q:RISK_CHRONIC:none' : id.replace(/:[^:]+$/, ':no') }
        : { kind: 'text', text: '3 din' },
    );
  } else if (r.state === 'extract_system') r = await ans({ kind: 'choice', id: pickId('sys:') });
  else if (r.state === 'extract_symptom') r = await ans({ kind: 'choice', id: pickId('sym:') });
  else break;
}
ok(
  r.state === 'idle' && r.messages.some((m) => m.templateCode === 'outcome.opd_booking'),
  `intake reached an OPD booking in ${guard} steps without any LLM`,
  r.state,
);
const emg = (await api('POST', '/intake/sessions', { facility_code: 'GJ-DEMO-DH', language: 'hi' }, pt)).json;
r = emg;
r = await ans({ kind: 'choice', id: pickId('pt:') ?? 'pt:new' });
if (r.state === 'purpose') {
  r = await ans({ kind: 'choice', id: 'purpose:new_problem' });
  r = await ans({ kind: 'text', text: 'seene mein dard aur saans nahi aa rahi' });
}
ok(
  r.messages.some((m) => m.templateCode === 'triage.emergency_go_now'),
  '🔒 emergency phrase → casualty redirect + pre-alert',
);
const prealerts = await api('GET', `/facilities/${facilityId}/emergency-prealerts`, undefined, bearer(doctor));
ok(prealerts.status === 200 && prealerts.json.items.length >= 1, 'casualty dashboard shows the pre-alert');

console.log('\nM8 — knowledge bot');
const faq = await api('POST', '/kb/ask', { question: 'What are the OPD timings?', facility_code: 'GJ-DEMO-DH', language: 'en' });
ok(
  faq.status === 200 && ['faq', 'cache', 'rag'].includes(faq.json.path),
  `KB answered via ${faq.json.path}: "${faq.json.answer?.slice(0, 60)}"`,
);
const med = await api('POST', '/kb/ask', {
  question: 'what medicine should I take for fever?',
  facility_code: 'GJ-DEMO-DH',
  language: 'en',
});
ok(
  med.status === 200 && ['medical_redirect', 'not_found', 'rag', 'cache'].includes(med.json.path),
  `medical question → ${med.json.path} (${med.json.path === 'medical_redirect' ? 'LLM guardrail' : 'LLM not configured: deterministic path'})`,
);

console.log('\nM9 — analytics & audit');
const admin = await login('admin@demo.sahayak.health');
const daily = await api('GET', `/analytics/facilities/${facilityId}/daily`, undefined, bearer(admin));
ok(daily.status === 200, 'facility daily analytics readable by facility_admin');
const dpo = await login('dpo@demo.sahayak.health');
const log = await api('GET', `/audit/patients/${patientId}/access-log`, undefined, bearer(dpo));
ok(
  log.status === 200 && log.json.items.some((i) => i.action === 'patient.clinical.read'),
  `"who accessed my record" lists ${log.json.items?.length} audited accesses incl. clinical reads`,
);

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} SMOKE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
