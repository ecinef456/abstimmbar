/** Guided tour v4 (desktop): sections with progress, Back (also across a page
 *  change), "Skip section", ←/→, and the mind map step (shown only when the
 *  example set has a mind map — example rooms created before it was added
 *  don't, and are not backfilled).
 *
 *  Runs as `demo` on the user's own example room (read-only: the tour only
 *  navigates; if the example room is missing it is restored, like the tour's
 *  own restore step). Nothing else of the user is touched. */
import type { Locator, Page } from '@playwright/test';
import { test, expect, API_BASE_URL, csrfToken } from './fixtures';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 860 } });

async function login(page: Page) {
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill(process.env.TOUR_USER ?? 'demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo'); // password is 'demo' for all dev users
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
}

/** The example set's question kinds (restoring the example room if missing). */
async function exampleKinds(page: Page): Promise<string[]> {
  let whoami = await (await page.request.get(`${API_BASE_URL}/api/whoami/`)).json();
  if (whoami.example_set_id == null) {
    const token = await csrfToken(page.request);
    const res = await page.request.post(`${API_BASE_URL}/api/whoami/example-room/`, {
      headers: token ? { 'X-CSRFToken': token } : undefined,
    });
    expect(res.ok()).toBeTruthy();
    whoami = await (await page.request.get(`${API_BASE_URL}/api/whoami/`)).json();
  }
  const list = await (
    await page.request.get(`${API_BASE_URL}/api/questions/?question_set=${whoami.example_set_id}`)
  ).json();
  return (list.results as { kind: string }[]).map((q) => q.kind);
}

const popover = (page: Page) => page.locator('.driver-popover');
const head = (page: Page) => popover(page).locator('.tour-section-head');
const title = (page: Page) => popover(page).locator('.driver-popover-title');

async function next(page: Page) {
  await popover(page).getByRole('button', { name: 'Next' }).click();
}

/** Wait until the popover shows `section · n of m` (n/m may be regexes). */
async function expectHead(page: Page, text: RegExp) {
  await expect(head(page)).toHaveText(text, { timeout: 15_000 });
}

async function headParts(locator: Locator) {
  const text = (await locator.textContent()) ?? '';
  const m = text.match(/^(.*) · (\d+) of (\d+)$/);
  expect(m, `section header "${text}"`).not.toBeNull();
  return { section: m![1], current: Number(m![2]), total: Number(m![3]) };
}

test('tour: sections, progress, Back across pages, skip section, arrow keys, mind map step', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page);
  const kinds = await exampleKinds(page);
  const hasMindmap = kinds.includes('mindmap');
  const hasMatrix = kinds.includes('matrix');

  await page.goto('/');
  // A fresh account (TOUR_USER) gets the welcome dialog first.
  const skip = page.getByRole('dialog').getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2000 }).catch(() => false)) await skip.click();
  await page.getByRole('button', { name: 'Help' }).click();
  await page.getByRole('menuitem', { name: 'Start tour' }).click();

  // First step: section header, no Back.
  await expectHead(page, /^Rooms · 1 of 4$/);
  await expect(popover(page).getByRole('button', { name: 'Back' })).toBeHidden();

  // → / ← move between steps.
  await page.keyboard.press('ArrowRight');
  await expectHead(page, /^Rooms · 2 of 4$/);
  await page.keyboard.press('ArrowLeft');
  await expectHead(page, /^Rooms · 1 of 4$/);

  // Next to the last rooms step, then into the example room (page change).
  for (let i = 0; i < 3; i++) await next(page);
  await expectHead(page, /^Rooms · 4 of 4$/);
  await next(page);
  await expectHead(page, /^Question sets · 1 of \d+$/);
  await expect(page).toHaveURL(/\/rooms\/\d+$/);

  // Back across the page change: back on the overview, previous step.
  await popover(page).getByRole('button', { name: 'Back' }).click();
  await expectHead(page, /^Rooms · 4 of 4$/);
  await expect(title(page)).toHaveText('Create your own room');
  await expect(page).toHaveURL(/localhost:5174\/$/);

  // Skip section: Rooms → first step of "Question sets".
  await popover(page).getByRole('button', { name: 'Skip section' }).click();
  await expectHead(page, /^Question sets · 1 of \d+$/);
  await expect(title(page)).toHaveText('Sets and their types');

  // The type-list step opens the "New question" menu; Back to the step
  // before closes it again.
  const typeMenu = page.locator('[data-tour="set.type-list"]');
  for (let i = 0; i < 6 && (await title(page).textContent()) !== 'Question types'; i++) {
    const before = await head(page).textContent();
    await next(page);
    await expect(head(page)).not.toHaveText(before ?? '', { timeout: 15_000 });
  }
  await expect(title(page)).toHaveText('Question types');
  await expect(typeMenu).toBeVisible();
  await popover(page).getByRole('button', { name: 'Back' }).click();
  await expect(title(page)).toHaveText('Add a question');
  await expect(typeMenu).toBeHidden();

  // … and again: "Question sets" → the first question-type step.
  await popover(page).getByRole('button', { name: 'Skip section' }).click();
  await expectHead(page, /^Question types · 1 of \d+$/);
  await expect(title(page)).toHaveText('Single Choice');
  await expect(page).toHaveURL(/\/sets\/\d+\/questions\/\d+$/);

  // Walk the question-type section: progress counts up to the total, and the
  // mind map step appears exactly when the example set has a mind map.
  const titles: string[] = [];
  let parts = await headParts(head(page));
  const total = parts.total;
  for (;;) {
    expect(parts.section).toBe('Question types');
    expect(parts.current).toBe(titles.length + 1);
    titles.push((await title(page).textContent()) ?? '');
    await next(page);
    await expect(head(page)).not.toHaveText(`Question types · ${parts.current} of ${total}`, {
      timeout: 15_000,
    });
    parts = await headParts(head(page));
    if (parts.section !== 'Question types') break;
  }
  expect(titles.length).toBe(total);
  if (hasMindmap) {
    expect(titles).toContain('Mind map');
    expect(titles.indexOf('Mind map')).toBe(titles.indexOf('Ordering') + 1);
  } else {
    expect(titles).not.toContain('Mind map');
  }
  if (hasMatrix) {
    expect(titles).toContain('Four-field matrix');
    expect(titles.indexOf('Four-field matrix')).toBe(titles.indexOf('Mind map') + 1);
  }
  expect(parts.section).toBe('Presenting');
  expect(parts.current).toBe(1);

  // Back from the next section returns to the last question-type step, on
  // its question page.
  await page.keyboard.press('ArrowLeft');
  await expectHead(page, new RegExp(`^Question types · ${total} of ${total}$`));
  await expect(title(page)).toHaveText(titles[titles.length - 1]);
  await expect(page).toHaveURL(/\/sets\/\d+\/questions\/\d+$/);

  // Through the presenter to the results, then Back into the presenter: the
  // last presenter step shows the first question again, not the lobby.
  await page.keyboard.press('ArrowRight');
  await expectHead(page, /^Presenting · 1 of \d+$/);
  const presentTitles: string[] = [];
  for (let i = 0; i < 8; i++) {
    const current = await headParts(head(page));
    if (current.section === 'Results') break;
    presentTitles.push((await title(page).textContent()) ?? '');
    // Each presenter step highlights its (visible) target control.
    if (current.current > 1) {
      await expect(page.locator('.driver-active-element')).toBeVisible();
    }
    const before = await head(page).textContent();
    await next(page);
    await expect(head(page)).not.toHaveText(before ?? '', { timeout: 15_000 });
  }
  await expectHead(page, /^Results · 1 of \d+$/);
  expect(presentTitles).toEqual([
    'Start the presentation',
    'Joining',
    'Start and stop voting',
    'Choose what the projector shows',
    'Next question and leave',
    'Help on the projector',
  ]);
  await expect(page).toHaveURL(/\/sets\/\d+$/);
  await popover(page).getByRole('button', { name: 'Back' }).click();
  await expect(title(page)).toHaveText('Help on the projector', { timeout: 15_000 });
  await expect(page.locator('[data-tour="present.help"]')).toBeVisible();
  await expect(page).toHaveURL(/\/sets\/\d+\/present/);
  // Footer position "1/N" (its tooltip/name: "Question 1/N").
  await expect(page.locator('footer [data-help="position"]')).toHaveText(/^1\/\d+$/, { timeout: 10_000 });
  await expect(page.locator('[data-tour="present.reveal"]')).toBeVisible();

  // End the tour (✕).
  await popover(page).locator('.driver-popover-close-btn').click();
  await expect(popover(page)).toBeHidden();
});
