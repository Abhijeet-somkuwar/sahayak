// End-to-end tests against the running stack: backend gateway on :8000 (npm run dev:backend) and the frontend on :5173.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm --prefix frontend run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 5'] }, testMatch: /patient.*\.spec\.js/ },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } }, testMatch: /staff.*\.spec\.js/ },
  ],
});
