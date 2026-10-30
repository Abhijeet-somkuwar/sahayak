#!/usr/bin/env node
/**
 * Authenticator (TOTP) codes for the demo staff accounts.
 *
 * Doctors, admins, reviewers and the DPO sign in with password + a 6-digit code from an authenticator app.
 * The backend smoke test and the e2e tests enrol some accounts themselves and keep the secrets in two
 * git-ignored files; this script turns those secrets into the current code, exactly as a phone app would.
 *
 *   npm run totp                                      codes for every account with a known secret
 *   npm run totp -- dr.mehta@demo.sahayak.health      one account
 *   npm run totp -- --reset dr.mehta@demo.sahayak.health
 *       forgets that account's enrolment (database row + local files) so the next sign-in shows the
 *       QR code again and you can enrol a real phone app. Uses the Docker Postgres from backend/.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticator } from 'otplib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [join(root, 'backend', '.smoke-totp.json'), join(root, 'e2e', '.mfa-secrets.json')];

const readFile = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {});
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

const [cmd, arg] = process.argv.slice(2);

if (cmd === '--reset') {
  if (!arg) {
    console.error('usage: npm run totp -- --reset <email>');
    process.exit(1);
  }
  const sqlEmail = arg.replace(/'/g, "''");
  execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'sahayak_maint', '-d', 'sahayak', '-v', 'ON_ERROR_STOP=1', '-c',
      `UPDATE users SET mfa_secret_enc = NULL WHERE lower(email) = lower('${sqlEmail}')`],
    { cwd: join(root, 'backend'), stdio: 'inherit' },
  );
  for (const f of FILES) {
    if (!existsSync(f)) continue;
    const data = readFile(f);
    const key = Object.keys(data).find((e) => same(e, arg));
    if (key) {
      delete data[key];
      writeFileSync(f, JSON.stringify(data, null, 2) + '\n');
    }
  }
  console.log(`${arg}: enrolment cleared. Sign in again; the screen will show a QR code to scan with Google Authenticator or Authy.`);
  process.exit(0);
}

const secrets = {};
for (const f of FILES) Object.assign(secrets, readFile(f));
const emails = cmd ? Object.keys(secrets).filter((e) => same(e, cmd)) : Object.keys(secrets);

if (emails.length === 0) {
  if (cmd) {
    console.error(`No stored authenticator secret for ${cmd}.`);
    console.error('If that account has never signed in, the sign-in screen shows a QR code: scan it with Google Authenticator or Authy,');
    console.error('or copy the key under "Can\'t scan?" into the app. If it was enrolled on a phone you no longer have, run:');
    console.error(`  npm run totp -- --reset ${cmd}`);
  } else {
    console.error('No stored authenticator secrets yet. Run "npm run backend:smoke" once (it enrols dr.mehta, admin, dpo and state),');
    console.error('or sign in with an account and scan the QR code shown on first sign-in.');
  }
  process.exit(1);
}

const left = authenticator.timeRemaining();
for (const email of emails) console.log(`${email.padEnd(34)} ${authenticator.generate(secrets[email])}   (valid for ${left} s)`);
