/** Header "?" menu: the "Guide" entry links to the project website guide and
 *  opens in a new tab. Read-only; runs as `demo`. */
import { test, expect, API_BASE_URL } from './fixtures';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

test('help menu: Guide item links to the guide in a new tab', async ({ page }) => {
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');

  await page.locator('[data-tour="header.help"]').click();
  const item = page.getByRole('menuitem', { name: /Guide/ });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('href', /^https:\/\/.+\/anleitung\/$/);
  await expect(item).toHaveAttribute('target', '_blank');
  await expect(item).toHaveAttribute('rel', /noopener/);
});
