import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { authenticator } from 'otplib';
import fs from 'node:fs';

export const API = process.env.E2E_API_URL || 'http://localhost:8000/api/v1';
export const PASSWORD = process.env.SEED_STAFF_PASSWORD || 'Demo@12345678';
export const CLERK = 'clerk@demo.sahayak.health';
export const DOCTOR = 'dr.mehta@demo.sahayak.health';

/** Zero serious or critical axe violations (WCAG 2.1 AA). */
export async function expectAccessible(page, context) {
  await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`), context || 'axe').toEqual([]);
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/** Staff access token through the API (clerks need no MFA). */
export async function clerkToken() {
  const r = await call('POST', '/auth/staff/login', { identifier: CLERK, password: PASSWORD });
  if (r.status !== 200 || !r.body.access_token) throw new Error(`clerk login failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.access_token;
}

export async function facilityOf(token) {
  const me = await call('GET', '/me', undefined, { Authorization: `Bearer ${token}` });
  return me.body.memberships[0].facility_id;
}

/** Register a fresh patient and check them in at the counter, through the API. Returns { encounter, checkin }. */
export async function seedCheckedInPatient(name = `E2E Patient ${Date.now() % 100000}`) {
  const token = await clerkToken();
  const auth = { Authorization: `Bearer ${token}` };
  const facilityId = await facilityOf(token);
  const depts = await call('GET', `/facilities/${facilityId}/departments`, undefined, auth);
  const dept = depts.body.items.find((d) => !d.is_emergency && d.code === 'GEN_MED') || depts.body.items.find((d) => !d.is_emergency);
  const patient = await call('POST', '/patients', { display_name: name, sex: 'female', age_years: 40, district_code: '474', relationship: 'self', preferred_language: 'hi', force: true }, auth);
  if (patient.status !== 201) throw new Error(`patient create failed: ${patient.status} ${JSON.stringify(patient.body)}`);
  const enc = await call('POST', '/encounters', { facility_id: facilityId, patient_id: patient.body.id, department_id: dept.id, kind: 'opd_new', triage_level: 'routine', check_in: true }, { ...auth, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random()}` });
  if (enc.status !== 201) throw new Error(`encounter create failed: ${enc.status} ${JSON.stringify(enc.body)}`);
  return { patient: patient.body, encounter: enc.body.encounter, checkin: enc.body.checkin, facilityId, department: dept };
}

/** Sign in through the UI. Doctors get the MFA step: enrol (manual key shown beside the QR) or enter the stored code. */
export async function staffLogin(page, identifier) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(identifier);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const mfaHeading = page.getByRole('heading', { name: 'Enter your authenticator code' });
  const signOut = page.getByRole('button', { name: 'Sign out' });
  await expect(mfaHeading.or(signOut)).toBeVisible();
  if (await mfaHeading.isVisible()) {
    const secretEl = page.getByTestId('mfa-secret');
    let secret = secretsFile()[identifier];
    if (await secretEl.isVisible({ timeout: 3000 }).catch(() => false)) {
      secret = (await secretEl.textContent()).trim();
      saveSecret(identifier, secret);
    }
    if (!secret) throw new Error(`no TOTP secret known for ${identifier}; delete e2e/.mfa-secrets.json and re-seed`);
    await page.getByLabel('Authenticator code').fill(authenticator.generate(secret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(signOut).toBeVisible();
  }
}

const SECRETS = new URL('./.mfa-secrets.json', import.meta.url);
function secretsFile() {
  // secrets enrolled through the UI (e2e/.mfa-secrets.json) plus the ones the backend smoke script enrolled
  let mine = {};
  let smoke = {};
  try {
    mine = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
  } catch {
    /* none yet */
  }
  try {
    smoke = JSON.parse(fs.readFileSync(new URL('../backend/.smoke-totp.json', import.meta.url), 'utf8'));
  } catch {
    /* smoke not run */
  }
  return { ...smoke, ...mine };
}
function saveSecret(id, secret) {
  fs.writeFileSync(SECRETS, JSON.stringify({ ...secretsFile(), [id]: secret }, null, 2));
}

export function deviceKey(label) {
  const p = new URL('../backend/.demo-device-keys.json', import.meta.url);
  const keys = JSON.parse(fs.readFileSync(p, 'utf8'));
  return keys[label];
}
