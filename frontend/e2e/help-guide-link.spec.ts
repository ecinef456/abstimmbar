/** Header "?" menu: the "Guide" entry links to the project website guide in
 *  the UI language (German at the site root, English under /en/) and opens
 *  in a new tab. Read-only; runs as `demo`. */
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL } from './fixtures';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

async function openHelpMenu(page: Page, lang: 'de' | 'en') {
  await page.addInitScript((l) => {
    try {
      localStorage.setItem('abstimmbar_lang', l);
    } catch {
      /* ignore */
    }
  }, lang);
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
  await page.locator('[data-tour="header.help"]').click();
}

for (const [lang, name, href] of [
  ['de', /Anleitung/, /^https:\/\/.+\/anleitung\/$/],
  ['en', /Guide/, /^https:\/\/.+\/en\/guide\/$/],
] as const) {
  test(`help menu: Guide item links to the ${lang} guide in a new tab`, async ({ page }) => {
    await openHelpMenu(page, lang);
    const item = page.getByRole('menuitem', { name });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('href', href);
    await expect(item).toHaveAttribute('target', '_blank');
    await expect(item).toHaveAttribute('rel', /noopener/);
  });
}
