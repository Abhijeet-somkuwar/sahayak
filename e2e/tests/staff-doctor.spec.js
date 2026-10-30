import { test, expect } from '@playwright/test';
import { DOCTOR, deviceKey, expectAccessible, seedCheckedInPatient, staffLogin } from '../helpers.js';

test('doctor: call next → facts above AI summary → start → diagnosis → complete; display updates', async ({ page, context }) => {
  const seeded = await seedCheckedInPatient();
  await staffLogin(page, DOCTOR);
  await expect(page).toHaveURL(/\/doctor/);
  await expect(page.getByRole('navigation', { name: 'Queue' })).toBeVisible();
  await expectAccessible(page, 'doctor console');

  // the TV in the hall
  const display = await context.newPage();
  await display.goto('/display');
  if (await display.getByLabel('Device key').isVisible({ timeout: 3000 }).catch(() => false)) {
    await display.getByLabel('Device key').fill(deviceKey('Main Hall Display'));
    await display.getByRole('button', { name: 'Save' }).click();
  }
  await expect(display.getByText('Now calling')).toBeVisible();

  // if a previous run left someone with this doctor, finish with them first
  const complete = page.getByRole('button', { name: /^Complete/ });
  if (await complete.isEnabled()) {
    await complete.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Complete' }).click();
    await expect(complete).toBeDisabled();
  }

  const callNext = page.getByRole('button', { name: /^Call next/ });
  await expect(callNext).toBeEnabled();
  await callNext.click();
  await expect(callNext).toBeDisabled();
  const nowWithYou = page.getByText('Now with you').locator('..');
  await expect(nowWithYou).toContainText(/[A-Z]+-\d{3}/);
  const code = (await nowWithYou.textContent()).match(/[A-Z]+-\d{3}/)[0];

  // display shows the same code in the marigold row
  await expect(display.getByRole('img', { name: `Token ${code.split('-')[0].split('').join(' ')} ${code.split('-')[1]}` })).toBeVisible({ timeout: 5000 });

  // deterministic facts sit above the AI summary
  const main = page.getByRole('main');
  await expect(main.getByText('Allergies', { exact: true })).toBeVisible();
  // the AI summary (labelled) or, when the LLM is rate limited or off, the stated fallback
  await expect(main.getByText(/AI-generated, verify|Summary unavailable/).first()).toBeVisible({ timeout: 30_000 });
  const allergiesY = (await main.getByText('Allergies', { exact: true }).boundingBox()).y;
  const summaryY = (await main.getByRole('region', { name: 'Summary' }).boundingBox()).y;
  expect(allergiesY).toBeLessThan(summaryY);

  await page.keyboard.press('s');
  await expect(page.getByRole('button', { name: /^Start consult/ })).toBeDisabled();

  await page.keyboard.press('d');
  await page.getByRole('dialog').getByLabel('Diagnosis').fill('Acid peptic disease');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Diagnosis saved')).toBeVisible();

  await page.keyboard.press('c');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Complete' }).click();
  await expect(callNext).toBeEnabled();
  await expectAccessible(display, 'display board');
  void seeded;
});
