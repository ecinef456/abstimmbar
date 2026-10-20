/** Privacy page on the phone (#65): the generated data-collection table and
 *  an admin-authored wide table both stay inside the viewport and scroll in
 *  their own box. The page API is stubbed so no real content is modified. */
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers/layout';
import { AUTH } from './helpers/seed';

const cell = (s: string) => `<td>${s}</td>`;
const head = ['Verarbeitungstätigkeit', 'Datenkategorie', 'Rechtsgrundlage', 'Speicherdauer', 'Empfängerkategorie']
  .map((h) => `<th>${h}</th>`)
  .join('');
const row = ['Teilnahmeprotokollierung', 'Pseudonymisierte', 'Art.6Abs.1lit.e', 'Semesterende', 'Rechenzentrum'].map(cell).join('');
const BODY = `<p>Einleitung.</p><table><thead><tr>${head}</tr></thead><tbody><tr>${row}</tr></tbody></table><p>Ende.</p>`;

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`privacy page ${colorScheme}`, () => {
    test.use({ colorScheme, storageState: AUTH.demo });

    test('tables scroll inside their boxes, no page overflow, axe clean', async ({ page }) => {
      await page.route(/\/api\/pages\/datenschutz\/$/, (route) =>
        route.fulfill({
          json: {
            slug: 'datenschutz',
            title: { de: 'Datenschutz', en: 'Privacy' },
            body: { de: BODY, en: BODY },
          },
        }),
      );
      await page.route(/\/api\/whoami\/(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const json = await response.json();
        if (json.username) json.onboarding_tour_seen = true;
        await route.fulfill({ response, json });
      });
      await page.goto('/pages/datenschutz');
      await expect(page.locator('article table')).toHaveCount(2);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      const vw = page.viewportSize()!.width;
      const page_ = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
      }));
      expect(page_.sw, 'page scrollWidth').toBeLessThanOrEqual(Math.max(page_.iw, vw) + 1);
      await expectNoHorizontalOverflow(page, '/pages/datenschutz');

      // Generated table: in a scroller, hint visible.
      const generated = page.locator('article section table');
      const gBox = await generated.evaluate((t) => {
        const s = t.parentElement!;
        return { sw: s.scrollWidth, cw: s.clientWidth, ox: getComputedStyle(s).overflowX };
      });
      expect(gBox.sw).toBeGreaterThan(gBox.cw);
      expect(['auto', 'scroll']).toContain(gBox.ox);
      await expect(page.getByText(/Swipe sideways|seitlich/i)).toBeVisible();

      // Authored table: must not be wider than the viewport unless it sits in a scroller.
      const authored = page.locator('.overflow-x-auto table').first();
      const a = await authored.evaluate((t) => {
        let n: HTMLElement | null = t;
        let scroller: HTMLElement | null = null;
        while (n && n.tagName !== 'ARTICLE') {
          const ox = getComputedStyle(n).overflowX;
          if (ox === 'auto' || ox === 'scroll') { scroller = n; break; }
          n = n.parentElement;
        }
        return { right: t.getBoundingClientRect().right, scroller: !!scroller };
      });
      expect(a.scroller || a.right <= vw + 1, `authored table right=${a.right}`).toBe(true);

      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(violations.map((v) => [v.id, v.nodes.map((n) => n.target.join(' '))])).toEqual([]);

      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });
  });
}
