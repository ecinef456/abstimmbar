/** Presenter "?" help (desktop): opens with the "?" button, ? and H; closes
 *  with a click, Esc, ? and H; one label card per visible footer control /
 *  right-edge handle (switcher segments and ‹ › share a card), cards don't
 *  overlap; Esc closes only the help (the presentation keeps running) and no
 *  presenter shortcut fires while it is open; axe on the open overlay.
 *
 *  Runs as `demo`; seeds its own "E2E Help …" rooms and deletes them. No AI
 *  view is ever selected (no LLM calls).
 *  HELP_SHOTS=<dir> saves a full-page screenshot per kind. */
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL, csrfToken } from './fixtures';
import { createRoomWithQuestions, type Kind } from './helpers/seed';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
});

const footer = (page: Page) => page.locator('footer');
const help = (page: Page) => page.getByTestId('presenter-help');
const ctl = (page: Page, id: string) => footer(page).locator(`[data-help="${id}"]`);

async function seedSet(
  page: Page,
  kinds: Kind[],
  label: string,
  trackRoom: (id: number) => void,
  extra: Record<number, Record<string, unknown>> = {},
) {
  const seed = await createRoomWithQuestions(page.request, kinds, label, trackRoom, 'E2E Help');
  const token = await csrfToken(page.request);
  const patch = async (url: string, data: Record<string, unknown>) => {
    const r = await page.request.fetch(`${API_BASE_URL}${url}`, {
      method: 'PATCH',
      headers: token ? { 'X-CSRFToken': token } : undefined,
      data,
    });
    expect(r.ok(), `${url}: ${await r.text()}`).toBeTruthy();
  };
  await patch(`/api/question-sets/${seed.setId}/`, { reveal_answers: 'after_close' });
  for (const [index, fields] of Object.entries(extra)) {
    await patch(`/api/questions/${seed.questions[Number(index)].id}/`, fields);
  }
  return seed;
}

async function openPresenter(page: Page, setId: number) {
  await page.goto(`/sets/${setId}/present`);
  await expect(page.locator('[data-tour="present.join"]')).toBeVisible();
}

/** Every visible `[data-help]` control has a card; cards don't overlap each
 *  other or the key list and stay inside the viewport. */
async function expectCardsCoverControls(page: Page) {
  await expect(help(page)).toBeVisible();
  await page.waitForTimeout(500); // handles fade; the overlay re-collects
  const result = await page.evaluate(() => {
    const shown = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
      for (let e: HTMLElement | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
      }
      return true;
    };
    const visible = Array.from(document.querySelectorAll<HTMLElement>('[data-help]'))
      .filter((el) => !el.closest('[data-help-overlay]') && shown(el))
      .map((el) => el.dataset.help ?? '');
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="help-card"]'));
    const covered = cards.flatMap((c) => (c.dataset.helpFor ?? '').split(' '));
    const boxes = [...cards, document.querySelector<HTMLElement>('[data-testid="help-keys"]')!].map((e) =>
      e.getBoundingClientRect(),
    );
    const overlaps: string[] = [];
    boxes.forEach((a, i) =>
      boxes.slice(i + 1).forEach((b, k) => {
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
          overlaps.push(`${i}×${i + 1 + k}`);
      }),
    );
    const outside = boxes.filter((b) => b.left < 0 || b.top < 0 || b.right > innerWidth || b.bottom > innerHeight).length;
    return { visible, covered, overlaps, outside };
  });
  expect(result.visible.length).toBeGreaterThan(4);
  expect([...new Set(result.covered)].sort()).toEqual([...new Set(result.visible)].sort());
  expect(result.covered.length).toBe(new Set(result.covered).size); // one card per control
  expect(result.overlaps).toEqual([]);
  expect(result.outside).toBe(0);
}

async function shot(page: Page, name: string) {
  const dir = process.env.HELP_SHOTS;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`), animations: 'disabled' });
}

test('single choice: open/close by button, ?, H, click and Esc; no shortcuts while open', async ({
  page,
  trackRoom,
}) => {
  const seed = await seedSet(page, ['single_choice', 'likert'], 'SC', trackRoom);
  await openPresenter(page, seed.setId);
  // Lobby: the help works there too.
  await page.keyboard.press('h');
  await expectCardsCoverControls(page);
  await page.keyboard.press('h');
  await expect(help(page)).toBeHidden();

  await page.keyboard.press('ArrowRight'); // first question, opens
  await expect(ctl(page, 'toggle')).toContainText('Stop');
  await ctl(page, 'help').click();
  await expectCardsCoverControls(page);
  // Switcher segments share one card.
  await expect(page.locator('[data-testid="help-card"][data-help-for^="view."]')).toHaveCount(1);
  await expect(
    page.locator('[data-testid="help-card"][data-help-for="view.question view.results view.solution"]'),
  ).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="presenter-help"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await shot(page, 'single-choice');
  // Open vote, nothing live: A does nothing, so the key list doesn't offer it.
  await expect(page.getByTestId('help-keys')).not.toContainText('Cycle through the views');

  // Presenter keys are suspended while the help is open.
  await page.keyboard.press('s');
  await page.keyboard.press('e');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(800);
  await expect(help(page)).toBeVisible();
  await expect(ctl(page, 'position')).toHaveText('1/2');
  await expect(ctl(page, 'toggle')).toContainText('Stop');
  await expect(ctl(page, 'view.question')).toHaveAttribute('aria-checked', 'true');

  // Esc closes only the help — the presentation keeps running.
  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(/\/sets\/\d+\/present/);
  await expect(ctl(page, 'toggle')).toContainText('Stop');
  await expect(ctl(page, 'position')).toHaveText('1/2');

  // Focus is trapped in the help: Shift+Tab never reaches the footer behind
  // the dim layer, Enter activates nothing there (only the help's close).
  await page.keyboard.press('?');
  await expect(help(page)).toBeVisible();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('[data-help-overlay]') != null)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(help(page)).toBeHidden();
  await page.waitForTimeout(800);
  await expect(ctl(page, 'position')).toHaveText('1/2');
  await expect(ctl(page, 'toggle')).toContainText('Stop');
  // Focus returns to where it was when the help opened.
  await ctl(page, 'next').focus();
  await page.keyboard.press('?');
  await expect(help(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  await expect(ctl(page, 'next')).toBeFocused();
  await page.locator('body').click({ position: { x: 640, y: 120 } }); // drop focus again

  // "?" toggles; a click anywhere closes.
  await page.keyboard.press('?');
  await expect(help(page)).toBeVisible();
  await page.keyboard.press('?');
  await expect(help(page)).toBeHidden();
  await page.keyboard.press('Shift+H');
  await expect(help(page)).toBeVisible();
  await page.mouse.click(640, 300);
  await expect(help(page)).toBeHidden();
  // Ctrl+H stays with the browser.
  await page.keyboard.press('Control+h').catch(() => undefined);
  await expect(help(page)).toBeHidden();

  // State-aware: on the likert there is no solution segment.
  await page.keyboard.press('s'); // close the vote first (no "still running" prompt)
  await expect(ctl(page, 'toggle')).toContainText('Start');
  await page.keyboard.press('ArrowRight');
  await expect(ctl(page, 'position')).toHaveText('2/2', { timeout: 10_000 });
  await page.keyboard.press('?');
  await expectCardsCoverControls(page);
  await expect(
    page.locator('[data-testid="help-card"][data-help-for="view.question view.results"]'),
  ).toBeVisible();
  await expect(page.getByTestId('help-keys')).not.toContainText('Solution');
  // Segment rows only carry direct keys (E, L) — no per-row A.
  await expect(
    page.locator('[data-testid="help-card"][data-help-for^="view."] li').first().locator('kbd'),
  ).toHaveCount(0);
});

test('word cloud with AI views: one card per visible control and handle', async ({ page, trackRoom }) => {
  const seed = await seedSet(page, ['word_cloud'], 'WC', trackRoom, {
    0: { wordcloud_ai_enabled: true },
  });
  await openPresenter(page, seed.setId);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('s'); // stop → results; the AI segments show
  await expect(ctl(page, 'view.wc.grouped')).toBeVisible();
  await page.keyboard.press('?');
  await expectCardsCoverControls(page);
  await shot(page, 'word-cloud-ai');
});

test('mind map: the zoom handle gets its card', async ({ page, trackRoom }) => {
  const seed = await seedSet(page, ['mindmap'], 'MM', trackRoom);
  await openPresenter(page, seed.setId);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-help="handle.zoom"]')).toBeVisible();
  await page.keyboard.press('?');
  await expectCardsCoverControls(page);
  await expect(page.locator('[data-testid="help-card"][data-help-for="handle.zoom"]')).toBeVisible();
  await expect(page.getByTestId('help-keys')).toContainText('Zoom');
  await shot(page, 'mind-map');
  // Zoom keys don't reach the map while the help is open; Esc closes it.
  await page.keyboard.press('Escape');
  await expect(help(page)).toBeHidden();
  await expect(ctl(page, 'toggle')).toContainText('Stop');
});
