/** Four-field matrix, AI grouping on the beamer (desktop): the ✦ handle
 *  (expert mode, AI configured, the question's AI switch on), the panel —
 *  level choice, "Vorschlag holen", groups with editable summary title /
 *  description / category, skipped groups with their reason, hints with a
 *  board highlight — "Übernehmen" (summary card marked on the board),
 *  "Rückgängig" (also refused once a stack changed), errors, the rating
 *  lock, help labels, axe.
 *
 *  Never calls the LLM: `/ai-propose` is route-mocked with a body the
 *  backend simulated and signed itself (`helpers/matrixAi.ts`), so apply
 *  and undo run for real. Runs as `demo`; seeds "E2E Matrix KI" rooms and
 *  deletes them. MATRIX_AI_SHOTS=<dir> saves screenshots. */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL, csrfToken } from './fixtures';
import {
  apiClient,
  control,
  createMatrixQuestion,
  createRoomWithQuestions,
  joinParticipants,
  startRun,
} from './helpers/seed';
import { signedProposal } from './helpers/matrixAi';

const SHOTS = process.env.MATRIX_AI_SHOTS ?? '';

test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

/** whoami as the beamer reads it: tour seen, expert mode (unless `easy`),
 *  AI configured. */
async function routeWhoami(page: Page, opts: { easy?: boolean } = {}) {
  await page.route(/\/api\/whoami\/(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    if (json.username) {
      json.onboarding_tour_seen = true;
      json.easy_mode = !!opts.easy;
      json.ai_enabled = true;
    }
    await route.fulfill({ response, json });
  });
}

async function login(page: Page, opts: { easy?: boolean } = {}) {
  await routeWhoami(page, opts);
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
}

type Card = { id: number; stack: number | null; summary: boolean; title: string; category: string };

async function seed(page: Page, trackRoom: (id: number) => void, overrides: Record<string, unknown> = {}) {
  const room = await createRoomWithQuestions(page.request, [], 'Matrix KI', trackRoom, 'E2E Matrix KI');
  const api = apiClient(page.request);
  const questionId = await createMatrixQuestion(api, room.setId, {
    wordcloud_ai_enabled: true,
    matrix_max_per_person: 5,
    ...overrides,
  });
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const tokens = await joinParticipants(page.request, room.code, 3);
  const csrf = await csrfToken(page.request);
  const add = async (token: string, zone: string, title: string, category: string) => {
    const response = await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/add/`, {
      data: { token, question: questionId, zone, title, category, description: '' },
      headers: csrf ? { 'X-CSRFToken': csrf } : undefined,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).card_id as number;
  };
  const ids = {
    chatbot: await add(tokens[0], 'q1', 'Chatbot', 'blue'),
    chatbot2: await add(tokens[1], 'q1', 'Chat-Bot', 'blue'),
    chatbot3: await add(tokens[2], 'q1', 'chatbot', 'orange'),
    assistant: await add(tokens[1], 'q3', 'KI-Assistent', 'orange'),
    podcast: await add(tokens[0], 'q2', 'Podcast', 'orange'),
    altlast: await add(tokens[2], 'q3', 'Altlast', 'orange'),
  };
  const cards = async (): Promise<Card[]> => {
    const body = await api.get(`/api/question-sets/${room.setId}/results/`);
    const run = body.results.find((r: { run: number }) => r.run === runId);
    return run.questions.find((x: { id: number }) => x.id === questionId).matrix.cards;
  };
  return { room, api, questionId, runId, ids, cards };
}

const board = (page: Page) => page.locator('[data-matrix-board]');
const card = (page: Page, id: number) => board(page).locator(`[data-card-id="${id}"]`);
const handle = (page: Page) => page.locator('[data-help="handle.mx-ai"]');
const panel = (page: Page) => page.getByTestId('mx-ai-panel');

async function openPresenter(page: Page, setId: number) {
  await page.goto(`/sets/${setId}/present?resume=continue`);
  await expect(board(page)).toBeVisible();
}

async function expectNoAxe(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }))).toEqual([]);
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('propose (mocked), edit, hint highlight, apply → summary card, undo, undo refused', async ({ page, trackRoom }) => {
  test.setTimeout(150_000);
  await login(page);
  const s = await seed(page, trackRoom);
  const { ids } = s;
  const body = signedProposal(
    s.runId,
    s.questionId,
    [
      { cards: [ids.chatbot, ids.chatbot2, ids.chatbot3], title: 'Chatbot', reason: 'Gleiche Idee, andere Schreibweise.' },
      { cards: [ids.podcast, ids.altlast], title: 'Medien' },
    ],
    [{ cards: [ids.chatbot, ids.assistant], reason: 'Beide meinen einen Chatbot.' }],
  );
  const levels: string[] = [];
  await page.route(/\/api\/runs\/\d+\/matrix\/\d+\/ai-propose$/, async (route) => {
    levels.push(route.request().postDataJSON().level);
    await route.fulfill({ json: body });
  });
  await openPresenter(page, s.room.setId);

  await expect(handle(page)).toBeVisible();
  await expect(handle(page)).toHaveAccessibleName('KI-Zusammenfassen');
  // "?" labels the handle.
  await page.keyboard.press('?');
  await expect(page.locator('[data-testid="help-card"][data-help-for~="handle.mx-ai"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('presenter-help')).toHaveCount(0);

  await handle(page).click();
  await expect(panel(page)).toBeInViewport();
  // Level: a segmented choice with a one-line explanation; "same" by default.
  const level = panel(page).getByRole('radiogroup', { name: 'Was soll zusammengefasst werden?' });
  await expect(level.getByRole('radio', { name: 'Inhaltlich gleich' })).toBeChecked();
  await level.getByRole('radio', { name: 'Nur Schreibweise' }).check();
  await expect(panel(page)).toContainText('Tippfehler');
  await panel(page).getByRole('button', { name: 'Vorschlag holen' }).click();
  expect(levels).toEqual(['spelling']);

  const groups = panel(page).getByTestId('mx-ai-group');
  await expect(groups).toHaveCount(2);
  const ok = groups.nth(0);
  await expect(ok.getByRole('checkbox')).toBeChecked();
  await expect(ok).toContainText('nützlich & modern');
  await expect(ok).toContainText('Chat-Bot');
  await expect(ok).toContainText('(Idee)');
  await expect(ok).toContainText('Gleiche Idee, andere Schreibweise.');
  const title = ok.getByRole('textbox', { name: 'Titel der Sammelkarte' });
  await expect(title).toHaveValue('Chatbot');
  await expect(title).toHaveAttribute('maxlength', '60');
  // Descriptions are on in the seeded question; categories too (Idee = the
  // most frequent of the group).
  await expect(ok.getByRole('textbox', { name: 'Beschreibung der Sammelkarte' })).toBeVisible();
  await expect(ok.getByRole('combobox', { name: 'Kategorie der Sammelkarte' })).toHaveValue('blue');
  await title.fill('Chatbots');
  // The skipped group: greyed out, not selectable, with its reason.
  const skipped = groups.nth(1);
  await expect(skipped.getByRole('checkbox')).toBeDisabled();
  await expect(skipped.getByRole('checkbox')).not.toBeChecked();
  await expect(skipped).toContainText('Die Karten liegen in verschiedenen Feldern.');

  // Hint: same content in different fields → highlight on the board.
  const hints = panel(page).getByTestId('mx-ai-hints');
  await expect(hints).toContainText('Inhaltlich gleich, aber unterschiedlich eingeordnet');
  await expect(hints).toContainText('Beide meinen einen Chatbot.');
  const show = hints.getByRole('button', { name: 'Zeigen' });
  await show.click();
  await expect(show).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page, ids.chatbot)).toHaveAttribute('data-ai-highlight', 'true');
  await expect(card(page, ids.assistant)).toHaveAttribute('data-ai-highlight', 'true');
  await expect(card(page, ids.podcast)).not.toHaveAttribute('data-ai-highlight', 'true');
  await expectNoAxe(page);
  await shot(page, 'mx-ai-panel');
  await show.click();
  await expect(card(page, ids.chatbot)).not.toHaveAttribute('data-ai-highlight', 'true');

  // Apply: a summary card on top of the three, marked on the board.
  const apply = panel(page).getByRole('button', { name: 'Übernehmen (1)' });
  const applied = page.waitForResponse((r) => /\/ai-apply$/.test(r.url()));
  await apply.click();
  const applyRes = await applied;
  expect(applyRes.ok()).toBeTruthy();
  expect(applyRes.request().postDataJSON()).toMatchObject({
    selected: [0],
    edits: { '0': { title: 'Chatbots', category: 'blue' } },
  });
  await expect(page.getByRole('status').filter({ hasText: '1 Vorschlag übernommen' })).toBeVisible();
  let server = await s.cards();
  const summary = server.find((c) => c.summary)!;
  expect(summary).toMatchObject({ title: 'Chatbots', category: 'blue', stack: null });
  expect(server.filter((c) => c.stack === summary.id).map((c) => c.id).sort()).toEqual(
    [ids.chatbot, ids.chatbot2, ids.chatbot3].sort(),
  );
  const top = card(page, summary.id);
  await expect(top).toHaveAttribute('data-summary', 'true');
  await expect(top.locator('[data-card-summary]')).toHaveText('Zusammenfassung');
  // The badge counts the cards beneath the summary card.
  await expect(top.getByTestId('matrix-stack-badge')).toHaveText('×3');
  await expect(card(page, ids.podcast).locator('[data-card-summary]')).toHaveCount(0);
  await shot(page, 'mx-ai-applied');

  // Undo restores the loose cards and removes the summary card.
  await panel(page).getByRole('button', { name: 'Rückgängig' }).click();
  await expect(card(page, summary.id)).toHaveCount(0);
  await expect(card(page, ids.chatbot)).toBeVisible();
  server = await s.cards();
  expect(server.some((c) => c.summary)).toBe(false);
  expect(server.every((c) => c.stack === null)).toBe(true);
  await expect(panel(page).getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);

  // Again, then the stack changes → undo is refused with the server's reason.
  await panel(page).getByRole('button', { name: 'Vorschlag holen' }).click();
  await panel(page).getByRole('button', { name: 'Übernehmen (1)' }).click();
  await expect(panel(page).getByRole('button', { name: 'Rückgängig' })).toBeVisible();
  server = await s.cards();
  const again = server.find((c) => c.summary)!;
  expect(again.title).toBe('Chatbot');
  await s.api.post(`/api/runs/${s.runId}/matrix/${s.questionId}/unstack`, { card: ids.chatbot2 });
  await panel(page).getByRole('button', { name: 'Rückgängig' }).click();
  await expect(panel(page).getByRole('alert')).toContainText('Rückgängig ist nicht mehr möglich');
  // A refused undo is gone for good: the button disappears, the message stays.
  await expect(panel(page).getByRole('button', { name: 'Rückgängig' })).toHaveCount(0);
  await expect(panel(page).getByRole('alert')).toBeVisible();
  expect((await s.cards()).some((c) => c.id === again.id)).toBe(true);

  // Closing the panel; the summary card on the board passes axe (violet
  // label on the category tint).
  await page.keyboard.press('Escape');
  await expect(panel(page)).not.toBeInViewport();
  await page.waitForTimeout(1200); // the new-card flash is over
  await expectNoAxe(page);
  await shot(page, 'mx-ai-board');
});

test('keyboard opening focuses the level; skipped groups keep the edited title; category fallback', async ({
  page,
  trackRoom,
}) => {
  test.setTimeout(90_000);
  await login(page);
  const s = await seed(page, trackRoom);
  const { ids } = s;
  const body = signedProposal(s.runId, s.questionId, [
    { cards: [ids.chatbot, ids.chatbot2], title: 'Chatbot' },
    { cards: [ids.assistant, ids.altlast], title: 'Assistenz' },
  ]) as { groups: { category?: string }[] };
  // A preview whose category is not one of the question's (e.g. categories
  // changed meanwhile): the select shows the first category and sends it.
  body.groups[1].category = '';
  await page.route(/\/api\/runs\/\d+\/matrix\/\d+\/ai-propose$/, (route) => route.fulfill({ json: body }));
  await openPresenter(page, s.room.setId);

  await handle(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('radio', { name: 'Inhaltlich gleich' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(panel(page).getByRole('radio', { name: 'Konzeptionell ähnlich' })).toBeFocused();
  await expect(panel(page).getByRole('radio', { name: 'Konzeptionell ähnlich' })).toBeChecked();

  await panel(page).getByRole('button', { name: 'Vorschlag holen' }).click();
  const groups = panel(page).getByTestId('mx-ai-group');
  await expect(groups).toHaveCount(2);
  const category = groups.nth(1).getByRole('combobox', { name: 'Kategorie der Sammelkarte' });
  await expect(category).toHaveValue('blue');
  await expect(category.locator('option:checked')).toHaveText('Idee');
  await groups.nth(1).getByRole('textbox', { name: 'Titel der Sammelkarte' }).fill('Assistenz-Ideen');
  // Meanwhile a card of the second group is hidden → skipped on apply.
  await s.api.post(`/api/runs/${s.runId}/matrix/${s.questionId}/hide`, { card: ids.altlast, hidden: true });
  const applied = page.waitForResponse((r) => /\/ai-apply$/.test(r.url()));
  await panel(page).getByRole('button', { name: 'Übernehmen (2)' }).click();
  const req = (await applied).request().postDataJSON();
  expect(req.edits['1']).toMatchObject({ title: 'Assistenz-Ideen', category: 'blue' });
  const toast = page.getByRole('status').filter({ hasText: '1 Vorschlag übernommen' });
  await expect(toast).toContainText('Übersprungen: Assistenz-Ideen – Eine Karte ist ausgeblendet.');
  // A summary card over a single card shows no badge.
  const summary = (await s.cards()).find((c) => c.summary)!;
  await expect(card(page, summary.id).getByTestId('matrix-stack-badge')).toHaveText('×2');
  await s.api.post(`/api/runs/${s.runId}/matrix/${s.questionId}/unstack`, { card: ids.chatbot2 });
  await expect(card(page, summary.id).getByTestId('matrix-stack-badge')).toHaveCount(0);
  await expect(card(page, summary.id).locator('[data-card-summary]')).toBeVisible();
});

test('AI error and too few cards', async ({ page, trackRoom }) => {
  await login(page);
  const s = await seed(page, trackRoom);
  await page.route(/\/api\/runs\/\d+\/matrix\/\d+\/ai-propose$/, (route) =>
    route.fulfill({ status: 502, json: { detail: 'KI-Fehler: timeout' } }),
  );
  await openPresenter(page, s.room.setId);
  await handle(page).click();
  await panel(page).getByRole('button', { name: 'Vorschlag holen' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText('KI-Fehler: timeout');
  await expect(panel(page).getByRole('button', { name: 'Erneut versuchen' })).toBeVisible();
  // Fewer than 3 visible cards: the button explains why it is off.
  for (const id of [s.ids.chatbot, s.ids.chatbot2, s.ids.chatbot3, s.ids.assistant]) {
    await s.api.post(`/api/runs/${s.runId}/matrix/${s.questionId}/hide`, { card: id, hidden: true });
  }
  await expect(panel(page).getByRole('button', { name: /Vorschlag holen|Erneut versuchen/ })).toBeDisabled();
  await expect(panel(page)).toContainText('Dafür sind mindestens 3 Karten nötig.');
});

test('gating: easy mode, AI switch off, rating stage', async ({ page, trackRoom }) => {
  await login(page, { easy: true });
  const easy = await seed(page, trackRoom);
  await openPresenter(page, easy.room.setId);
  await expect(page.locator('[data-help="handle.mx-edit"]')).toBeVisible();
  await expect(handle(page)).toHaveCount(0);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await routeWhoami(page);
  const off = await seed(page, trackRoom, { wordcloud_ai_enabled: false });
  await openPresenter(page, off.room.setId);
  await expect(page.locator('[data-help="handle.mx-edit"]')).toBeVisible();
  await expect(handle(page)).toHaveCount(0);

  const rating = await seed(page, trackRoom, { matrix_rating_mode: 'points', matrix_rating_budget: 3 });
  await rating.api.post(`/api/runs/${rating.runId}/matrix/${rating.questionId}/stage`, { stage: 'rate', open: true });
  await openPresenter(page, rating.room.setId);
  await expect(page.getByTestId('mx-rating-banner')).toBeVisible();
  await handle(page).click();
  await expect(panel(page)).toContainText('Stapeln und Löschen sind während der Bewertung gesperrt.');
  await expect(panel(page).getByRole('button', { name: 'Vorschlag holen' })).toBeDisabled();
});
