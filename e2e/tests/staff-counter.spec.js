import { test, expect } from '@playwright/test';
import { CLERK, expectAccessible, staffLogin } from '../helpers.js';

test('counter: register a patient and check them in', async ({ page }) => {
  await staffLogin(page, CLERK);
  await expect(page).toHaveURL(/\/counter/);
  await expectAccessible(page, 'counter');

  await page.getByRole('button', { name: /Register someone new/ }).click();
  const name = `Playwright ${String.fromCharCode(65 + (Date.now() % 26))}${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6)}`;
  await page.getByLabel('Full name').fill(name);
  await page.locator('.ant-radio-button-wrapper', { hasText: /^Female$/ }).click();
  await page.getByRole('textbox', { name: 'Age' }).fill('34');
  await page.getByLabel('District').fill('474');
  await expectAccessible(page, 'register form');
  await page.getByRole('button', { name: 'Register', exact: true }).click();

  await expect(page.getByText('Selected patient')).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
  await page.getByRole('button', { name: /Check in →/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Checked in. Token' })).toBeVisible();
  await expect(page.getByText('Status link')).toBeVisible();
  await expectAccessible(page, 'counter after check-in');
});

test('counter: validation errors are listed and keep what was typed', async ({ page }) => {
  await staffLogin(page, CLERK);
  await page.getByRole('button', { name: /Register someone new/ }).click();
  await page.getByLabel('Full name').fill('X');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  const summary = page.getByRole('alert').first();
  await expect(summary).toBeFocused();
  await expect(summary).toContainText('Enter the full name');
  await expect(page.getByLabel('Full name')).toHaveValue('X');
});
