import { defineConfig, devices } from '@playwright/test';

// Reference device from #179: Galaxy Z Fold7 front screen (324×756 CSS px),
// Firefox for Android. Playwright's Firefox has no `isMobile`, so the phone
// layout runs twice: Chromium with full mobile emulation and the reporter's
// UA, and desktop Firefox (Gecko layout engine) squeezed to the same width.
const PHONE_VIEWPORT = { width: 324, height: 756 };
const PHONE_UA = 'Mozilla/5.0 (Android 16; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0';
// Phone specs only (mobile-*.spec.ts) + their seed/teardown (mobile.*.ts).
const MOBILE_SPECS = /mobile-.*\.spec\.ts$/;
const MOBILE_SETUP = /mobile\.(setup|teardown)\.ts$/;
// Website screenshots (`npm run docs:shots`): not a test — the project only
// exists when DOCS_SHOTS is set, and every other project ignores the file.
const DOCS_SHOTS = /docs-screenshots\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testIgnore: [MOBILE_SPECS, MOBILE_SETUP, DOCS_SHOTS],
    },
    // Logs in demo + admin-demo once (storage states) and seeds the shared
    // "E2E Mobile …" room; `mobile-teardown` deletes it after all phone runs.
    {
      name: 'mobile-setup',
      testMatch: /mobile\.setup\.ts$/,
      teardown: 'mobile-teardown',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-teardown',
      testMatch: /mobile\.teardown\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'phone-chromium',
      dependencies: ['mobile-setup'],
      testMatch: MOBILE_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        viewport: PHONE_VIEWPORT,
        deviceScaleFactor: 2, // device has 3.33; 2 keeps screenshots/traces small
        isMobile: true,
        hasTouch: true,
        userAgent: PHONE_UA,
        locale: 'de-DE',
      },
    },
    {
      name: 'phone-firefox',
      dependencies: ['mobile-setup'],
      testMatch: MOBILE_SPECS,
      use: {
        ...devices['Desktop Firefox'],
        viewport: PHONE_VIEWPORT,
        hasTouch: true,
        locale: 'de-DE',
      },
    },
    ...(process.env.DOCS_SHOTS
      ? [
          {
            name: 'docs-shots',
            testMatch: DOCS_SHOTS,
            use: { ...devices['Desktop Chrome'], locale: 'de-DE', colorScheme: 'light' as const },
          },
        ]
      : []),
  ],
});
