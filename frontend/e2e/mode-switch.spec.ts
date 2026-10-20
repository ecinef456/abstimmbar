/** Mode switch feedback (#77): switching Simple ↔ Expert in the header shows
 *  a short status notice, and for a moment after switching to Expert the
 *  controls that just appeared (`[data-pro-only]`) are highlighted via the
 *  root class `pro-just-enabled`.
 *
 *  Runs as `demo` (logs in per test); seeds its own "E2E …" room and deletes
 *  it. The mode POST is answered in the browser, so the account's stored
 *  mode is never changed; `afterEach` still restores it should it differ. */
import { test, expect, API_BASE_URL } from './fixtures';
import { apiClient, createRoomWithQuestions } from './helpers/seed';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } });

let originalEasyMode: boolean | undefined;

test.beforeEach(async ({ page }) => {
  // Start in Simple mode without the auto-starting tour, whatever the demo
  // user has stored.
  await page.route(/\/api\/whoami\/(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    if (json.username) {
      json.onboarding_tour_seen = true;
      json.easy_mode = true;
    }
    await route.fulfill({ response, json });
  });
  // Echo the mode switch without persisting it: the mode is per account
  // and other specs run in parallel as the same user.
  await page.route(/\/api\/whoami\/mode\/$/, async (route) => {
    const body = route.request().postDataJSON() as { easy_mode: boolean };
    await route.fulfill({ json: { easy_mode: body.easy_mode } });
  });
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
  const who = await page.request.get(`${API_BASE_URL}/api/whoami/`);
  originalEasyMode = (await who.json()).easy_mode;
});

test.afterEach(async ({ page }) => {
  if (originalEasyMode === undefined) return;
  const api = apiClient(page.request);
  const now = (await api.get('/api/whoami/')).easy_mode;
  if (now !== originalEasyMode) await api.post('/api/whoami/mode/', { easy_mode: originalEasyMode });
});

test('switching to Expert confirms and highlights the new controls; back to Simple hides them', async ({
  page,
  trackRoom,
}) => {
  const seed = await createRoomWithQuestions(
    page.request, ['single_choice', 'single_choice'], 'Mode', trackRoom, 'E2E Mode',
  );
  await page.goto(`/sets/${seed.setId}`);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  const proOnly = page.locator('[data-pro-only]');
  await expect(proOnly).toHaveCount(0);

  const mode = page.getByRole('group', { name: 'Mode' });
  await mode.getByRole('radio', { name: 'Expert' }).click();
  const notice = page.getByRole('status').filter({ hasText: 'Expert mode:' });
  await expect(notice).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/\bpro-just-enabled\b/);
  expect(await proOnly.count()).toBeGreaterThan(0);
  // The highlight is brief.
  await expect(page.locator('html')).not.toHaveClass(/\bpro-just-enabled\b/, { timeout: 5000 });

  await mode.getByRole('radio', { name: 'Simple' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Simple mode:' })).toBeVisible();
  await expect(proOnly).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/\bpro-just-enabled\b/);
});
