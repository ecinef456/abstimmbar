/** The SPA and the participant pages declare the project logo as favicon
 *  and the icon files are actually served. */
import { test, expect, API_BASE_URL } from './fixtures';

async function checkIcons(page: import('@playwright/test').Page) {
  const svg = page.locator('link[rel="icon"][type="image/svg+xml"]');
  await expect(svg).toHaveCount(1);
  const hrefs = await page
    .locator('link[rel~="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLLinkElement).href));
  expect(hrefs.length).toBeGreaterThanOrEqual(3);
  for (const href of hrefs) {
    const res = await page.request.get(href);
    expect(res.status(), href).toBe(200);
  }
}

test('SPA declares and serves the favicon', async ({ page }) => {
  await page.goto('/');
  await checkIcons(page);
});

test('participant page declares and serves the favicon', async ({ page }) => {
  await page.goto(API_BASE_URL + '/p/');
  await checkIcons(page);
});
