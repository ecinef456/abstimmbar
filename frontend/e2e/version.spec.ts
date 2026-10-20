/** The app shows its version (from the release tag at image build time;
 *  "dev" in the dev stack) in the global footer and in the admin area.
 *  Read-only. */
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL } from './fixtures';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

async function login(page: Page, user: string) {
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill(user);
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
}

test('footer shows the app version', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('contentinfo').getByText('Version dev', { exact: true })).toBeVisible();
});

test('admin area shows the app version', async ({ page }) => {
  await login(page, 'admin-demo');
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('main').getByText('Version dev', { exact: true })).toBeVisible();
});
