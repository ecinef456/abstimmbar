/** LTI platform form: e-mail account linking is opt-in (security F3). A new
 *  platform must not pre-tick "Link users by email". Read-only; runs as
 *  `admin-demo`. */
import { test, expect, API_BASE_URL } from './fixtures';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

test('new LTI platform form: "Link users by email" is unchecked by default', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('abstimmbar_lang', 'en');
    } catch {
      /* ignore */
    }
  });
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('admin-demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
  await page.goto('http://localhost:5174/admin?tab=settings&section=lms');
  await page.getByRole('button', { name: /Add platform/ }).click();
  await expect(page.getByLabel('Link users by email')).not.toBeChecked();
});
