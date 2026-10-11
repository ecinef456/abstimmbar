/** Desktop smoke test for the floating translation controls (@basicbar/ui
 *  0.8): the pill can be dragged by its handle, keeps its spot across a
 *  reload (localStorage), and a double-click on the handle resets it.
 *
 *  Uses the "+ New room" form (translatable Name/Description) so no data is
 *  created. Phones dock the controls instead — see T4 in
 *  mobile-layout.spec.ts. */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const OFFSET_KEY = 'basicbar_translation_controls_offset';

/** Open the new-room form, whose translatable fields show the controls. */
async function openNewRoomForm(page: Page) {
  await page.getByRole('button', { name: '+ New room' }).click();
  const controls = page.locator('.translation-controls');
  await expect(controls).toBeVisible();
  return controls;
}

test('translation controls: drag by the handle, kept after reload, double-click resets', async ({ page }) => {
  // Experte (fields in both languages → controls shown) and no auto-starting
  // tour, regardless of what the demo user has stored.
  await page.route(/\/api\/whoami\/(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    if (json.username) {
      json.onboarding_tour_seen = true;
      json.easy_mode = false;
    }
    await route.fulfill({ response, json });
  });

  await page.goto('/');
  await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
  await page.getByRole('textbox', { name: 'Username or email' }).fill('demo');
  await page.getByRole('textbox', { name: 'Password' }).fill('demo');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('button', { name: '+ New room' })).toBeVisible();
  await page.evaluate((key) => localStorage.removeItem(key), OFFSET_KEY);
  await page.reload();

  let controls = await openNewRoomForm(page);
  expect(await controls.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  const start = (await controls.boundingBox())!;

  // Drag the handle 300px left and 200px up.
  const handle = controls.getByRole('button', { name: 'Move translation controls' });
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 150, h.y + h.height / 2 - 100, { steps: 5 });
  await page.mouse.move(h.x + h.width / 2 - 300, h.y + h.height / 2 - 200, { steps: 5 });
  await page.mouse.up();

  const moved = (await controls.boundingBox())!;
  expect(Math.round(moved.x - start.x)).toBe(-300);
  expect(Math.round(moved.y - start.y)).toBe(-200);
  expect(await page.evaluate((key) => localStorage.getItem(key), OFFSET_KEY)).toBe(
    JSON.stringify({ x: -300, y: -200 }),
  );

  // Kept across a reload.
  await page.reload();
  controls = await openNewRoomForm(page);
  const reloaded = (await controls.boundingBox())!;
  expect(Math.round(reloaded.x)).toBe(Math.round(moved.x));
  expect(Math.round(reloaded.y)).toBe(Math.round(moved.y));

  // Double-click on the handle resets to the anchor and forgets the spot.
  await controls.getByRole('button', { name: 'Move translation controls' }).dblclick();
  const reset = (await controls.boundingBox())!;
  expect(Math.round(reset.x)).toBe(Math.round(start.x));
  expect(Math.round(reset.y)).toBe(Math.round(start.y));
  expect(await page.evaluate((key) => localStorage.getItem(key), OFFSET_KEY)).toBeNull();
});
