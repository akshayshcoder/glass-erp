import { defineConfig, devices } from '@playwright/test';

/*
 * End-to-end tests drive the real app in a browser. They expect the web app
 * (and behind it the API + a throw-away database) to be running at E2E_BASE_URL.
 * See README "End-to-end tests".
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    viewport: { width: 1366, height: 860 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 860 } },
    },
  ],
});
