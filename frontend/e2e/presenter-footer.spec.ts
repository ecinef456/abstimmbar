/** Presenter footer (icon bar, desktop): only the controls that fit the
 *  question's state, one view switcher per kind (single choice with
 *  solution, likert, word cloud with/without AI views, mind map with the
 *  ranking after a rating), keys A/E/L, accessible names (axe), no
 *  horizontal overflow at 1280 px.
 *
 *  Runs as `demo` (logs in per test); seeds its own "E2E …"
 *  rooms and deletes them. No AI view is ever selected (no LLM calls).
 *  FOOTER_SHOTS=<dir> also saves a footer screenshot per kind. */
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL, csrfToken } from './fixtures';
import {
  apiClient,
  control,
  createRoomWithQuestions,
  joinParticipants,
  startRun,
  type Kind,
} from './helpers/seed';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } });

// Log in as `demo` (Keycloak dev realm) before each test, as tour.spec does —
// no dependency on the phone projects' storage states.
test.beforeEach(async ({ page }) => {
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
});

const footer = (page: Page) => page.locator('footer');
const seg = (page: Page, id: string) => footer(page).locator(`[data-help="${id}"]`);

/** data-help ids of the footer's controls, in DOM order. */
async function footerControls(page: Page): Promise<string[]> {
  return footer(page)
    .locator('[data-help]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-help') ?? ''));
}

async function expectActive(page: Page, id: string) {
  await expect(seg(page, id)).toHaveAttribute('aria-checked', 'true');
}

async function shot(page: Page, name: string) {
  const dir = process.env.FOOTER_SHOTS;
  if (dir) await footer(page).screenshot({ path: path.join(dir, `${name}.png`), animations: 'disabled' });
}

/** Footer fits at 1280 px; every control has a name (axe on the footer). */
async function expectFitsAndNamed(page: Page) {
  const { footerOverflow, pageOverflow } = await page.evaluate(() => {
    const f = document.querySelector('footer')!;
    return {
      footerOverflow: f.scrollWidth - f.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(footerOverflow).toBeLessThanOrEqual(0);
  expect(pageOverflow).toBeLessThanOrEqual(0);
  const axe = await new AxeBuilder({ page })
    .include('footer')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  // aria-label = name, title = name (+ key) on every icon control.
  for (const el of await footer(page).locator('button[data-help]').all()) {
    const label = (await el.getAttribute('aria-label')) ?? (await el.textContent()) ?? '';
    expect(label.trim().length, await el.getAttribute('data-help') ?? '').toBeGreaterThan(0);
    expect(await el.getAttribute('title')).toBeTruthy();
  }
}

/** Open the presenter and wait for its lobby (keys work from then on). */
async function openPresenter(page: Page, setId: number) {
  await page.goto(`/sets/${setId}/present`);
  await expect(page.locator('[data-tour="present.join"]')).toBeVisible();
}

async function seedSet(
  page: Page,
  kinds: Kind[],
  label: string,
  trackRoom: (id: number) => void,
  extra: Record<number, Record<string, unknown>> = {},
) {
  const seed = await createRoomWithQuestions(
    page.request, kinds, label, trackRoom, 'E2E Footer',
  );
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

test('single choice: Question · Results · Solution, keys A/E/L', async ({ page, trackRoom }) => {
  const seed = await seedSet(page, ['single_choice', 'likert'], 'SC', trackRoom);
  await openPresenter(page, seed.setId);
  // Lobby: no switcher, no Start/Stop of a question yet beyond the start.
  await expect(footer(page).locator('[data-help="view.question"]')).toHaveCount(0);
  await page.keyboard.press('ArrowRight'); // first question (opens: open_on_show)
  await expect(seg(page, 'view.solution')).toBeVisible();
  expect(await footerControls(page)).toEqual([
    'position', 'qr', 'view.question', 'view.results', 'view.solution',
    'toggle', 'end', 'prev', 'next', 'help',
  ]);
  await expect(footer(page).locator('[data-help="position"]')).toHaveText('1/2');
  await expectActive(page, 'view.question');
  await expect(seg(page, 'toggle')).toContainText('Stop');
  // A only looks: during an open vote with nothing live on screen it does
  // nothing (never closes the vote); Ctrl+A is the browser's, not ours.
  await page.keyboard.press('a');
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(1000);
  await expectActive(page, 'view.question');
  await expect(seg(page, 'toggle')).toContainText('Stop');
  await shot(page, 'single-choice-open');
  await expectFitsAndNamed(page);

  await page.keyboard.press('e'); // closes the vote onto the results
  await expectActive(page, 'view.results');
  await expect(seg(page, 'toggle')).toContainText('Start');
  await page.keyboard.press('l');
  await expectActive(page, 'view.solution');
  await shot(page, 'single-choice-solution');
  await page.keyboard.press('l'); // back to the results
  await expectActive(page, 'view.results');
  await page.keyboard.press('a'); // results → solution
  await expectActive(page, 'view.solution');
  await page.keyboard.press('a'); // solution → question (wraps)
  await expectActive(page, 'view.question');
  await page.keyboard.press('a');
  await expectActive(page, 'view.results');
  await page.keyboard.press('e'); // E on the results toggles to the question
  await expectActive(page, 'view.question');
  // Clicking a segment works like the keys.
  await seg(page, 'view.solution').click();
  await expectActive(page, 'view.solution');

  // Likert: Question · Results, no solution.
  await page.keyboard.press('ArrowRight');
  await expect(footer(page).locator('[data-help="position"]')).toHaveText('2/2');
  await expect(seg(page, 'view.solution')).toHaveCount(0);
  expect(await footerControls(page)).toEqual([
    'position', 'qr', 'view.question', 'view.results', 'toggle', 'end', 'prev', 'next', 'help',
  ]);
  await page.keyboard.press('e');
  await expectActive(page, 'view.results');
  await shot(page, 'likert-results');
  await page.keyboard.press('l'); // no solution: nothing happens
  await expectActive(page, 'view.results');
  await expectFitsAndNamed(page);
});

test('word cloud: Original only, AI views when the question has AI', async ({
  page,
  trackRoom,
}) => {
  const seed = await seedSet(page, ['word_cloud', 'word_cloud'], 'WC', trackRoom, {
    1: { wordcloud_ai_enabled: true },
  });
  await openPresenter(page, seed.setId);
  await page.keyboard.press('ArrowRight');
  // Open with the live cloud on screen: its view is current, "Question"
  // can't hide it.
  await expectActive(page, 'view.wc.raw');
  await expect(seg(page, 'view.question')).toHaveAttribute('aria-disabled', 'true');
  expect(await footerControls(page)).toEqual([
    'position', 'qr', 'view.question', 'view.wc.raw', 'toggle', 'end', 'prev', 'next', 'help',
  ]);
  await page.keyboard.press('a'); // one live view only: nothing to cycle, still open
  await expectActive(page, 'view.wc.raw');
  await expect(seg(page, 'toggle')).toContainText('Stop');
  await page.keyboard.press('s'); // stop → results, the cloud stays
  await expectActive(page, 'view.wc.raw');
  await expect(seg(page, 'view.question')).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('a');
  await expectActive(page, 'view.question');
  await shot(page, 'word-cloud');

  await page.keyboard.press('ArrowRight');
  await expect(footer(page).locator('[data-help="position"]')).toHaveText('2/2');
  await expect(seg(page, 'view.wc.grouped')).toBeVisible();
  expect(await footerControls(page)).toEqual([
    'position', 'qr', 'view.question', 'view.wc.raw', 'view.wc.consolidated',
    'view.wc.grouped', 'toggle', 'end', 'prev', 'next', 'help',
  ]);
  await expectActive(page, 'view.wc.raw');
  await shot(page, 'word-cloud-ai');
  await expectFitsAndNamed(page);
});

test('mind map: Mind map · Ranking after a rating, rating action as icon', async ({
  page,
  trackRoom,
}) => {
  const seed = await seedSet(page, ['mindmap'], 'MM', trackRoom, {
    0: { mindmap_descriptions: true },
  });
  const api = apiClient(page.request);
  const q = seed.questions[0];
  const runId = await startRun(api, seed.setId);
  await control(api, runId, 'open', q.id);
  const tokens = await joinParticipants(page.request, seed.code, 2);
  const token = await csrfToken(page.request);
  const headers = token ? { 'X-CSRFToken': token } : undefined;
  const nodes: number[] = [];
  for (const [i, text] of ['Alpha', 'Beta'].entries()) {
    const r = await page.request.post(`${API_BASE_URL}/api/live/rooms/${seed.code}/mindmap/add/`, {
      data: { token: tokens[i], question: q.id, parent: null, text },
      headers,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    const body = await r.json();
    nodes.push(body.node_id ?? body.node ?? body.id);
  }
  await api.post(`/api/runs/${runId}/mindmap/${q.id}/stage`, { stage: 'rate', open: true });
  for (const t of tokens) {
    const r = await page.request.post(`${API_BASE_URL}/api/live/rooms/${seed.code}/mindmap/rate/`, {
      data: { token: t, question: q.id, node: nodes[0], delta: 1 },
      headers,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  await control(api, runId, 'closed');

  // Closed rating, scores hidden: the map is on screen. Clicking its (active)
  // segment or pressing A must not reveal the scores — only E does.
  await page.goto(`/sets/${seed.setId}/present?resume=continue`);
  await expectActive(page, 'view.mm.raw');
  await expect(seg(page, 'view.mm.ranking')).toHaveCount(0);
  await seg(page, 'view.mm.raw').click();
  await page.keyboard.press('a');
  await page.waitForTimeout(1500); // give a (wrong) reveal time to arrive
  await expect(seg(page, 'view.mm.ranking')).toHaveCount(0);
  await expect(seg(page, 'view.question')).toHaveAttribute('aria-disabled', 'true');
  await expect(seg(page, 'view.question')).toHaveAttribute('title', /—/);
  await page.keyboard.press('e'); // reveal
  await expect(seg(page, 'view.mm.ranking')).toBeVisible();
  expect(await footerControls(page)).toEqual([
    'position', 'qr', 'view.question', 'view.mm.raw', 'view.mm.ranking',
    'mm.collect', 'toggle', 'end', 'prev', 'next', 'help',
  ]);
  await expectActive(page, 'view.mm.raw');
  // Compact / detailed moved into the zoom handle.
  await page.locator('[data-help="handle.zoom"]').click();
  await expect(page.getByTestId('mm-compact')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('mm-detailed').click();
  await expect(page.getByTestId('mm-detailed')).toHaveAttribute('aria-checked', 'true');
  const dir = process.env.FOOTER_SHOTS;
  if (dir) await page.screenshot({ path: path.join(dir, 'mind-map-zoom-handle.png'), animations: 'disabled' });
  await page.keyboard.press('a');
  await expectActive(page, 'view.mm.ranking');
  await expect(page.getByTestId('mm-ranking')).toBeVisible();
  await shot(page, 'mind-map-ranking');
  await expectFitsAndNamed(page);
  // The old "View" dropdown is gone.
  await expect(footer(page).locator('select')).toHaveCount(0);
});
