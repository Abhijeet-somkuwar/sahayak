import { test } from '@playwright/test';
import { CLERK, DOCTOR, deviceKey, seedCheckedInPatient, staffLogin } from '../helpers.js';

const FACILITY = process.env.E2E_FACILITY_CODE || 'GJ-DEMO-DH';

/** Screenshots of the slip, doctor console, counter and display, saved to docs/screenshots. */
test.setTimeout(240_000);
test('capture screens', async ({ browser }) => {
  const { checkin } = await seedCheckedInPatient('Visual Capture');

  const phone = await browser.newPage({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2 });
  await phone.goto(`http://localhost:5173/t/${checkin.public_ref}`);
  await phone.getByRole('img', { name: 'Checked in' }).waitFor();
  await phone.waitForTimeout(600);
  await phone.screenshot({ path: 'docs/screenshots/slip-waiting.png' });
  await phone.goto(`http://localhost:5173/f/${FACILITY}`);
  await phone.waitForTimeout(600);
  await phone.screenshot({ path: 'docs/screenshots/facility.png' });
  await phone.close();

  const clerk = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await staffLogin(clerk, CLERK);
  await clerk.getByRole('button', { name: /Register someone new/ }).click();
  await clerk.waitForTimeout(400);
  await clerk.screenshot({ path: 'docs/screenshots/counter.png' });
  await clerk.close();

  const desk = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  await staffLogin(desk, DOCTOR);
  const callNext = desk.getByRole('button', { name: /^Call next/ });
  if (await callNext.isEnabled()) await callNext.click();
  await desk.getByText('AI-generated, verify').waitFor({ timeout: 30_000 }).catch(() => {});
  await desk.waitForTimeout(800);
  await desk.screenshot({ path: 'docs/screenshots/doctor-console.png' });
  await desk.close();

  const tv = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await tv.goto('http://localhost:5173/display');
  if (await tv.getByLabel('Device key').isVisible({ timeout: 3000 }).catch(() => false)) {
    await tv.getByLabel('Device key').fill(deviceKey('Main Hall Display'));
    await tv.getByRole('button', { name: 'Save' }).click();
  }
  await tv.getByText('Now calling').waitFor();
  await tv.waitForTimeout(1000);
  await tv.screenshot({ path: 'docs/screenshots/display.png' });
  await tv.close();
});
