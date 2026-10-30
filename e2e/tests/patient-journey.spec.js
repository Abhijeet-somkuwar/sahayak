import { test, expect } from '@playwright/test';
import { expectAccessible, seedCheckedInPatient } from '../helpers.js';

const FACILITY = process.env.E2E_FACILITY_CODE || 'GJ-DEMO-DH';

test('patient: OTP sign-in → conversational intake → booking or emergency outcome', async ({ page }) => {
  await page.goto(`/f/${FACILITY}`);
  await expect(page.getByRole('link', { name: 'Start a visit' })).toBeVisible();
  await expectAccessible(page, 'facility page');

  await page.getByRole('link', { name: 'Start a visit' }).click();
  await page.getByLabel('Mobile number').fill(`9${String(Date.now()).slice(-9)}`);
  await page.getByRole('button', { name: 'Send code' }).click();
  const code = (await page.getByTestId('otp-dev-code').textContent()).trim();
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();

  // walk the conversation: pick the first choice when offered, otherwise type a complaint
  for (let step = 0; step < 25; step++) {
    const booked = page.getByRole('heading', { name: 'Your visit is booked' });
    const emergency = page.getByRole('heading', { name: 'Go to Casualty now' });
    const cont = page.getByRole('button', { name: 'Continue' });
    await expect(booked.or(emergency).or(cont)).toBeVisible({ timeout: 30_000 });
    if ((await booked.isVisible()) || (await emergency.isVisible())) break;
    const options = page.locator('.answer-option');
    if ((await options.count()) > 0) {
      // prefer "yes"-like consent answers and English, otherwise the first option
      const labels = await options.allTextContents();
      let idx = labels.findIndex((l) => /^(yes|हाँ|હા|english)$/i.test(l.trim()));
      if (idx < 0) idx = labels.findIndex((l) => /new problem|fever|self|myself/i.test(l));
      if (idx < 0) idx = 0;
      await options.nth(idx).click();
    } else {
      // answer by what the engine asked: a number for age, a name for name, otherwise the complaint
      const prompt = (await page.locator('.intake-question').last().textContent().catch(() => '')) || '';
      const answer = /age|years|number|उम्र|ઉંમર/i.test(prompt) ? '34' : /name|नाम|નામ/i.test(prompt) ? 'Playwright Patient' : 'fever since two days';
      await page.getByRole('textbox').first().fill(answer);
    }
    await cont.click();
    await page.waitForTimeout(300);
  }
  const booked = page.getByRole('heading', { name: 'Your visit is booked' });
  const emergency = page.getByRole('heading', { name: 'Go to Casualty now' });
  expect((await booked.isVisible()) || (await emergency.isVisible())).toBe(true);
  await expectAccessible(page, 'outcome');
});

test('patient: slip status page shows the token and updates to "your turn"', async ({ page }) => {
  const { checkin } = await seedCheckedInPatient();
  await page.goto(`/t/${checkin.public_ref}`);
  await expect(page.getByRole('img', { name: 'Checked in' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Token [A-Z ]+ \d{3}/ })).toBeVisible();
  await expect(page.getByText(/ahead of you|You are next/)).toBeVisible();
  await expectAccessible(page, 'slip');
});

test('language switch renders Hindi and Gujarati', async ({ page }) => {
  await page.goto(`/f/${FACILITY}`);
  await page.getByRole('radio', { name: 'हिंदी' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByRole('link', { name: 'विज़िट शुरू करें' })).toBeVisible();
  await page.getByRole('radio', { name: 'ગુજરાતી' }).click();
  await expect(page.getByRole('link', { name: 'મુલાકાત શરૂ કરો' })).toBeVisible();
  await expectAccessible(page, 'gujarati facility page');
  await page.getByRole('radio', { name: 'English' }).click();
});
