/** Mind-map drifts aligned with the matrix (desktop, German UI): the editor's
 *  number fields keep an empty draft while typing and clamp on blur (like the
 *  matrix "Karten pro Person"), and the results ranking is a semantic list
 *  with a screen-reader rank and readable path text (axe). Runs as `demo`;
 *  seeds its own "E2E Mindmap Editor" rooms and deletes them. */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL, csrfToken } from './fixtures';
import { apiClient, control, createRoomWithQuestions, joinParticipants, startRun } from './helpers/seed';

test.use({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });

test.beforeEach(async ({ page }) => {
  // Expert mode (all settings visible) and no auto-starting tour.
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
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
});

/** Select-all + Backspace leaves the field empty (no snap to the minimum);
 *  leaving it clamps to `min`. */
async function expectClearThenClamp(page: Page, name: RegExp, min: string) {
  const field = page.getByRole('spinbutton', { name });
  await field.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await expect(field).toHaveValue('');
  await field.blur();
  await expect(field).toHaveValue(min);
}

test('mind-map and word-cloud number fields: clearing keeps the field empty, blur clamps to the minimum', async ({
  page,
  trackRoom,
}) => {
  const seed = await createRoomWithQuestions(
    page.request, ['mindmap', 'word_cloud'], 'Mindmap Editor', trackRoom, 'E2E Mindmap Editor',
  );
  const [mindmap, wordCloud] = seed.questions;

  await page.goto(`/sets/${seed.setId}/questions/${mindmap.id}`);
  await expect(page.locator('[data-tour="question.editor"]')).toBeVisible();
  await expectClearThenClamp(page, /^Tiefe/, '1');
  await expectClearThenClamp(page, /^Begriffe pro Person/, '0');
  await expectClearThenClamp(page, /^Punkte pro Person/, '1');
  // Typing past the maximum clamps on blur, too.
  const depth = page.getByRole('spinbutton', { name: /^Tiefe/ });
  await depth.fill('12');
  await depth.blur();
  await expect(depth).toHaveValue('8');

  await page.goto(`/sets/${seed.setId}/questions/${wordCloud.id}`);
  await expect(page.locator('[data-tour="question.editor"]')).toBeVisible();
  await expectClearThenClamp(page, /^Maximale Beiträge pro Person/, '0');
});

test('results ranking: ordered list with screen-reader ranks, passes axe', async ({ page, trackRoom }) => {
  const seed = await createRoomWithQuestions(
    page.request, ['mindmap'], 'Mindmap Rangliste', trackRoom, 'E2E Mindmap Editor',
  );
  const api = apiClient(page.request);
  const q = seed.questions[0];
  const runId = await startRun(api, seed.setId);
  await control(api, runId, 'open', q.id);
  const tokens = await joinParticipants(page.request, seed.code, 2);
  const csrf = await csrfToken(page.request);
  const headers = csrf ? { 'X-CSRFToken': csrf } : undefined;
  const add = async (text: string, parent: number | null) => {
    const r = await page.request.post(`${API_BASE_URL}/api/live/rooms/${seed.code}/mindmap/add/`, {
      data: { token: tokens[0], question: q.id, parent, text },
      headers,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).node_id as number;
  };
  const alpha = await add('Alpha', null);
  const beta = await add('Beta', alpha); // a sub-term: its path is shown
  await api.post(`/api/runs/${runId}/mindmap/${q.id}/stage`, { stage: 'rate', open: true });
  for (const [token, node] of [[tokens[0], beta], [tokens[1], beta], [tokens[1], alpha]] as const) {
    const r = await page.request.post(`${API_BASE_URL}/api/live/rooms/${seed.code}/mindmap/rate/`, {
      data: { token, question: q.id, node, delta: 1 },
      headers,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  await control(api, runId, 'results');

  await page.goto(`/sets/${seed.setId}/results`);
  const ranking = page.getByTestId('mindmap-ranking');
  await expect(ranking).toBeVisible();
  const list = ranking.getByRole('list', { name: 'Rangliste' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText('Platz 1:');
  await expect(list.getByRole('listitem').first()).toContainText('Beta');

  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const { violations } = await new AxeBuilder({ page })
    .include('[data-testid="mindmap-ranking"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }))).toEqual([]);
});
