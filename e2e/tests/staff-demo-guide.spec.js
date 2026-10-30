import { test, expect } from '@playwright/test';

// Walks the in-app demo guide (/demo) exactly as a reader would: its buttons open every screen in its own tab,
// then the story runs across them. Needs the development backend (demo mode). Uses fresh phone numbers so the
// guide's own sample numbers stay unused, and ends with "Start a fresh demo" so the queue is left empty.

const API = 'http://localhost:8000/api/v1';
const uniquePhone = (n) => `9${String(Date.now() + n).slice(-9)}`;
const tokenAria = (code) => {
  const [prefix, number] = code.split('-');
  return `Token ${prefix.split('').join(' ')} ${number}`;
};

/** Answers the intake conversation: `decide(prompt, labels)` returns an option label or the text to type. */
async function converse(p, decide) {
  const done = p.getByRole('heading', { name: /Your visit is booked|Go to Casualty now/ });
  const cont = p.getByRole('button', { name: 'Continue' });
  const question = p.locator('.intake-question').last();
  for (let step = 0; step < 30; step++) {
    await expect(done.or(question)).toBeVisible({ timeout: 45_000 });
    if (await done.isVisible()) return;
    const prompt = ((await question.textContent({ timeout: 5000 }).catch(() => '')) || '').trim();
    const options = p.locator('.answer-option');
    const labels = (await options.allTextContents()).map((l) => l.trim());
    const answer = decide(prompt.toLowerCase(), labels);
    if (labels.length) {
      const i = labels.findIndex((l) => l === answer);
      await options.nth(i >= 0 ? i : 0).click();
    } else {
      await p.getByRole('textbox').first().fill(answer);
    }
    await cont.click();
    // wait for the reply: the outcome, or a different question
    await expect
      .poll(async () => (await done.isVisible()) || ((await question.textContent({ timeout: 500 }).catch(() => prompt)) || '').trim() !== prompt, { timeout: 45_000 })
      .toBe(true);
  }
  throw new Error('intake did not finish');
}

async function patientSignIn(p, phone) {
  await p.getByRole('link', { name: 'Start a visit' }).click();
  await p.getByLabel('Mobile number').fill(phone);
  await p.getByRole('button', { name: 'Send code' }).click();
  const code = (await p.getByTestId('otp-dev-code').textContent()).trim();
  await p.getByLabel('6-digit code').fill(code);
  await p.getByRole('button', { name: 'Verify' }).click();
}

test('demo guide: fresh demo → booking → kiosk → counter walk-in → doctor calls protected first → emergency alert', async ({ page, context, request }) => {
  test.setTimeout(300_000);
  const sunitaPhone = uniquePhone(0);
  const rameshPhone = uniquePhone(7);

  // the guide and the Demo panel
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Try Sahayak as every person in the hospital' })).toBeVisible();
  await page.getByTestId('demo-fab').click();
  await expect(page.getByText('Password for every account')).toBeVisible();
  await expect(page.getByTestId('demo-staff-dr.mehta')).toContainText('Doctor, Medicine OPD');
  await page.getByRole('button', { name: 'Close' }).click();

  // Before you start: fresh demo, then every screen in its own tab
  await page.getByRole('button', { name: 'Start a fresh demo' }).first().click();
  await page.getByRole('button', { name: 'Start fresh' }).click();
  await expect(page.getByText(/^Done: /)).toBeVisible();
  const open = async (name) => {
    const [p] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name, exact: true }).click()]);
    await p.waitForLoadState();
    return p;
  };
  const patient = await open('Patient’s phone');
  const kiosk = await open('Gate kiosk');
  const tv = await open('Waiting-hall TV');
  const counter = await open('Counter (clerk)');
  const doctor = await open('Doctor (Dr. Anil Mehta)');
  const casualty = await open('Casualty board (nurse)');
  await expect(counter).toHaveURL(/\/counter/, { timeout: 30_000 });
  await expect(doctor).toHaveURL(/\/doctor/, { timeout: 30_000 });
  await expect(casualty).toHaveURL(/\/ed/, { timeout: 30_000 });
  await expect(kiosk.getByText('Scan your QR code')).toBeVisible();
  await expect(tv.getByText('Now calling')).toBeVisible();

  // 1. Sunita books from home
  await patientSignIn(patient, sunitaPhone);
  await converse(patient, (q, labels) => {
    if (labels.length) {
      if (/agree|computer assistant/.test(q)) return 'Yes';
      if (/who is this visit for/.test(q)) return 'Someone else';
      if (/sex/.test(q)) return 'Female';
      if (/related/.test(q)) return 'My parent';
      if (/what do you need/.test(q)) return 'New health problem';
      if (/long-term/.test(q)) return 'None';
      return 'No';
    }
    if (/full name/.test(q)) return 'Sunita Sharma';
    if (/age/.test(q)) return '58';
    if (/describe/.test(q)) return 'fever and body ache since 2 days';
    if (/since when/.test(q)) return '2 days';
    return '2';
  });
  await expect(patient.getByRole('heading', { name: 'Your visit is booked' })).toBeVisible();
  await expect(patient.getByText(/Medicine OPD/).first()).toBeVisible();
  // the assistant explains what it understood and how it decided, without a diagnosis
  await expect(patient.getByTestId('ai-decision')).toContainText('Medicine OPD');
  await expect(patient.getByTestId('ai-decision')).toContainText('not a diagnosis');
  const checkinCode = (await patient.getByTestId('checkin-code').textContent()).trim();

  // 2. the gate kiosk
  await kiosk.getByRole('button', { name: 'Enter the check-in code' }).click();
  await kiosk.getByLabel('Enter the check-in code').fill(checkinCode);
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await expect(kiosk.getByRole('heading', { name: 'You are checked in' })).toBeVisible();
  const slipRef = (await kiosk.locator('.slip-ref').last().textContent()).trim();
  const sunitaCode = (await (await request.get(`${API}/t/${slipRef}`)).json()).token;
  // her live status page, opened with the slip code
  await patient.getByRole('link', { name: 'Close' }).click();
  await patient.getByLabel('Enter the code on your slip').fill(slipRef);
  await patient.getByRole('button', { name: 'Continue' }).click();
  await expect(patient.getByText(/ahead of you|You are next/)).toBeVisible();
  await expect(doctor.getByRole('navigation', { name: 'Queue' })).toContainText(sunitaCode, { timeout: 30_000 });

  // 3. a walk-in at the counter
  await counter.getByRole('button', { name: /Register someone new/ }).click();
  await counter.getByLabel('Full name').fill('Ramesh Patel');
  await counter.locator('.ant-radio-button-wrapper', { hasText: /^Male$/ }).click();
  await counter.getByRole('textbox', { name: 'Age' }).fill('72');
  await counter.getByLabel('Mobile').fill(rameshPhone);
  await counter.getByLabel('District').fill('474');
  await counter.getByRole('button', { name: 'Register', exact: true }).click();
  const dup = counter.getByRole('button', { name: 'Use this patient' }).first();
  await expect(counter.getByText('Selected patient').or(dup)).toBeVisible();
  if (await dup.isVisible()) await dup.click();
  await counter.getByRole('button', { name: /Check in →/ }).click();
  const checked = counter.getByRole('status').filter({ hasText: 'Checked in. Token' });
  await expect(checked).toBeVisible();
  const rameshCode = (await checked.textContent()).match(/Token ([A-Z]+-\d+)/)[1];

  // 4. the doctor: protected lane (Ramesh, 72) first, then Sunita; TV and her status page follow
  const callNext = doctor.getByRole('button', { name: /^Call next/ });
  const nowWithYou = doctor.getByText('Now with you').locator('..');
  await expect(callNext).toBeEnabled();
  await callNext.click();
  await expect(nowWithYou).toContainText(rameshCode);
  await expect(tv.getByRole('img', { name: tokenAria(rameshCode) })).toBeVisible({ timeout: 10_000 });
  await doctor.keyboard.press('s');
  await expect(doctor.getByRole('button', { name: /^Start consult/ })).toBeDisabled(); // like a person: wait for Start to land
  await doctor.keyboard.press('c');
  await doctor.getByRole('alertdialog').getByRole('button', { name: 'Complete' }).click();
  await expect(callNext).toBeEnabled();
  await callNext.click();
  await expect(nowWithYou).toContainText(sunitaCode);
  await expect(patient.getByText(/Go to Room 1 now/)).toBeVisible({ timeout: 10_000 });
  // the AI summary, or (when the LLM is rate limited or off) the stated fallback: both are correct outcomes
  await expect(doctor.getByRole('main').getByText(/AI-generated, verify|Summary unavailable/).first()).toBeVisible({ timeout: 45_000 });
  // diagnosis and medicine, then Complete: Sunita's phone shows them under the slip
  await doctor.keyboard.press('d');
  await doctor.getByRole('dialog').getByLabel('Diagnosis').fill('Viral fever');
  await doctor.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect(doctor.getByText('Diagnosis saved')).toBeVisible();
  await doctor.keyboard.press('p');
  const rx = doctor.getByRole('dialog');
  await rx.getByLabel('Medicine').fill('Paracetamol 500 mg');
  await rx.getByLabel('Dose').fill('1 tablet');
  await rx.getByLabel('Frequency').click({ force: true });
  await doctor.locator('.ant-select-item-option[title="TDS"]').click();
  await rx.getByLabel('Days').fill('3');
  await rx.getByLabel('Advice (optional)').fill('After food');
  await rx.getByRole('button', { name: 'Save' }).click();
  await expect(doctor.getByText('Prescription saved')).toBeVisible();
  await doctor.keyboard.press('c');
  await doctor.getByRole('alertdialog').getByRole('button', { name: 'Complete' }).click();
  await expect(patient.getByText('Visit complete')).toBeVisible({ timeout: 10_000 });
  const card = patient.getByTestId('visit-card');
  await expect(card).toContainText('Viral fever', { timeout: 10_000 });
  await expect(card).toContainText('Paracetamol 500 mg');
  await expect(card).toContainText('1 tablet, three times a day, for 3 days, by mouth');
  await expect(card).toContainText('After food');

  // 5. Sunita comes back with a headache: the doctor sees her earlier visit, diagnosis and medicine
  const patient2 = await open('Patient’s phone');
  await patientSignIn(patient2, sunitaPhone);
  await converse(patient2, (q, labels) => {
    if (labels.length) {
      if (/who is this visit for/.test(q)) return labels.find((l) => l.startsWith('Sunita'));
      if (/what do you need/.test(q)) return 'New health problem';
      if (/long-term/.test(q)) return 'None';
      return 'No';
    }
    if (/describe/.test(q)) return 'headache since today';
    return '1';
  });
  await expect(patient2.getByRole('heading', { name: 'Your visit is booked' })).toBeVisible();
  const revisitCode = (await patient2.getByTestId('checkin-code').textContent()).trim();
  await kiosk.getByRole('button', { name: 'Take your slip' }).click();
  await kiosk.getByRole('button', { name: 'Enter the check-in code' }).click();
  await kiosk.getByLabel('Enter the check-in code').fill(revisitCode);
  await kiosk.getByRole('button', { name: 'Check in' }).click();
  await expect(kiosk.getByRole('heading', { name: 'You are checked in' })).toBeVisible();
  await expect(callNext).toBeEnabled();
  await callNext.click();
  const history = doctor.getByTestId('visit-history');
  await expect(history).toContainText('Viral fever', { timeout: 15_000 });
  await expect(history).toContainText('Paracetamol 500 mg');
  await expect(doctor.getByRole('main').getByText(/AI-generated, verify|Summary unavailable/).first()).toBeVisible({ timeout: 45_000 });
  await doctor.keyboard.press('c');
  await doctor.getByRole('alertdialog').getByRole('button', { name: 'Complete' }).click();
  await expect(callNext).toBeEnabled();

  // 6. an emergency from the same phone for another family member → casualty alert
  await patient2.getByRole('link', { name: 'Close' }).click();
  await patient2.getByRole('link', { name: 'Start a visit' }).click();
  await converse(patient2, (q, labels) => {
    if (labels.length) {
      if (/who is this visit for/.test(q)) return 'Someone else';
      if (/agree|computer assistant/.test(q)) return 'Yes';
      if (/sex/.test(q)) return 'Male';
      if (/related/.test(q)) return 'Spouse';
      if (/what do you need/.test(q)) return 'New health problem';
      return 'No';
    }
    if (/full name/.test(q)) return 'Mahesh Sharma';
    if (/age/.test(q)) return '61';
    return 'chest pain and sweating since 1 hour';
  });
  await expect(patient2.getByRole('heading', { name: 'Go to Casualty now' })).toBeVisible();
  const ack = casualty.getByRole('button', { name: 'Acknowledge' }).first();
  await expect(ack).toBeVisible({ timeout: 15_000 });
  await ack.click();

  // leave a clean queue behind
  await page.bringToFront();
  await page.getByRole('button', { name: 'Start a fresh demo' }).first().click();
  await page.getByRole('button', { name: 'Start fresh' }).click();
  await expect(page.getByText(/^Done: /)).toBeVisible();
});
