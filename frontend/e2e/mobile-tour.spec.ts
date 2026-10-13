/** Guided tour at phone width (#179 device): the popover with its section
 *  header, Back/Next and "Skip section" stays inside the screen, light and
 *  dark. Read-only — the tour only navigates (demo's example room). */
import { test, expect } from './fixtures';
import { expectInViewport, expectNoHorizontalOverflow } from './helpers/layout';
import { AUTH } from './helpers/seed';

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`tour popover (${colorScheme})`, () => {
    test.use({ colorScheme, storageState: AUTH.demo });

    test('tour popover controls fit the phone width', async ({ page }) => {
      test.setTimeout(60_000);
      await page.goto('/');
      await page.getByRole('button', { name: /Help|Hilfe/ }).click();
      await page.getByRole('menuitem', { name: /Start tour|Rundgang starten/ }).click();
      const popover = page.locator('.driver-popover');
      // Second and third step: Back + Next + "Skip section" + a long text.
      for (let i = 0; i < 3; i++) {
        await expect(popover.locator('.tour-section-head')).toBeVisible({ timeout: 15_000 });
        if (i > 0) {
          await expect(popover.locator('.driver-popover-prev-btn')).toBeVisible();
          await expectInViewport(popover.locator('.driver-popover-prev-btn'), 'Back');
        }
        await expectInViewport(popover, 'tour popover');
        await expectInViewport(popover.locator('.driver-popover-next-btn'), 'Next');
        await expectInViewport(popover.locator('.tour-skip-section'), 'Skip section');
        await expectNoHorizontalOverflow(page, `tour step ${i + 1}`);
        if (i < 2) {
          const before = await popover.locator('.tour-section-head').textContent();
          await popover.locator('.driver-popover-next-btn').click();
          await expect(popover.locator('.tour-section-head')).not.toHaveText(before ?? '', {
            timeout: 15_000,
          });
        }
      }
      await popover.locator('.driver-popover-close-btn').click();
      await expect(popover).toBeHidden();
    });
  });
}
