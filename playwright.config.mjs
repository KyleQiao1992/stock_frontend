import { defineConfig } from 'playwright/test';
import { existsSync } from 'node:fs';

const live = process.env.E2E_LIVE === '1';
const port = Number(process.env.E2E_PORT || 5198);
const reportRoot = `test-results/${live ? 'live' : 'isolated'}`;
const executablePath = process.env.E2E_BROWSER || (process.platform === 'darwin'
  && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: live ? 'live.spec.mjs' : /(?:functional|visual|polling|date-flows|audit-guard|layout-guard|chart-stability)\.spec\.mjs/,
  fullyParallel: false,
  workers: 1, // Fixture state is reset between tests; never share it concurrently.
  retries: 0, // A first-run regression must remain a failure.
  timeout: live ? 120_000 : 60_000,
  expect: { timeout: live ? 45_000 : 15_000 },
  outputDir: `${reportRoot}/artifacts`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${reportRoot}/report`, open: 'never' }],
    ['json', { outputFile: `${reportRoot}/results.json` }],
    ['./tests/e2e/coverageReporter.mjs', { reportRoot }],
  ],
  use: {
    baseURL: live ? 'http://localhost:5173' : `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    launchOptions: { executablePath },
    actionTimeout: 15_000,
    screenshot: 'only-on-failure',
    trace: live ? 'off' : 'retain-on-failure',
    video: 'off',
    ...(live && process.env.E2E_LIVE_STORAGE_STATE ? { storageState: process.env.E2E_LIVE_STORAGE_STATE } : {}),
  },
  ...(live ? {} : { webServer: {
    command: 'node tests/e2e/fixtureServer.mjs',
    url: `http://127.0.0.1:${port}/__audit/manifest`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(port) },
  } }),
});
