/** Four-field matrix on the beamer (desktop): live cards, dragging with
 *  hysteresis (zone checked via the API), stacking by dropping onto a card,
 *  the card dialog (unstack, hide/show), "show hidden cards", a teacher card
 *  via the pencil handle, compact/detailed, keyboard moves with an aria-live
 *  announcement, footer segments + A/E, the "?" help labels, axe, and no
 *  overlap of axis labels / legend with cards.
 *
 *  Runs as `demo`; seeds its own "E2E Matrix Beamer" rooms and deletes them. */
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

test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/whoami\/(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    if (json.username) json.onboarding_tour_seen = true;
    await route.fulfill({ response, json });
  });
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
});

type Card = { id: number; zone: string; x: number; y: number; stack: number | null; hidden: boolean; teacher: boolean; title: string };

async function seed(page: Page, trackRoom: (id: number) => void) {
  const room = await createRoomWithQuestions(page.request, [], 'Matrix Beamer', trackRoom, 'E2E Matrix Beamer');
  const api = apiClient(page.request);
  const questionId = await createMatrixQuestion(api, room.setId);
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const tokens = await joinParticipants(page.request, room.code, 3);
  const csrf = await csrfToken(page.request);
  const add = async (token: string, zone: string, title: string, category: string, description = '') => {
    const response = await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/add/`, {
      data: { token, question: questionId, zone, title, category, description },
      headers: csrf ? { 'X-CSRFToken': csrf } : undefined,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).card_id as number;
  };
  const ids = {
    chatbot: await add(tokens[0], 'q1', 'Chatbot', 'blue', 'Beantwortet Fragen'),
    feedback: await add(tokens[1], 'q1', 'Feedback-Tool', 'blue'),
    altlast: await add(tokens[1], 'q3', 'Altlast', 'orange'),
    podcast: await add(tokens[0], 'q2', 'Podcast', 'orange'),
  };
  /** The server's view of a card (results payload of the running run). */
  const serverCard = async (id: number): Promise<Card> => {
    const body = await api.get(`/api/question-sets/${room.setId}/results/`);
    const run = body.results.find((r: { run: number }) => r.run === runId);
    const q = run.questions.find((x: { id: number }) => x.id === questionId);
    const card = q.matrix.cards.find((c: Card) => c.id === id);
    expect(card, `card ${id} on the server`).toBeTruthy();
    return card;
  };
  return { room, api, questionId, runId, tokens, add, ids, serverCard };
}

const board = (page: Page) => page.locator('[data-matrix-board]');
const card = (page: Page, id: number) => board(page).locator(`[data-card-id="${id}"]`);
const seg = (page: Page, id: string) => page.locator('footer').locator(`[data-help="${id}"]`);

async function openPresenter(page: Page, setId: number) {
  await page.goto(`/sets/${setId}/present?resume=continue`);
  await expect(board(page)).toBeVisible();
}

/** Pixel of a board point (x, y ∈ [−1, 1], y up). */
async function pointPx(page: Page, x: number, y: number) {
  const b = (await board(page).boundingBox())!;
  return { x: b.x + ((x + 1) / 2) * b.width, y: b.y + ((1 - y) / 2) * b.height };
}

async function centre(page: Page, id: number) {
  const b = (await card(page, id).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const isMove = (action: string) => (r: { url(): string; request(): { method(): string } }) =>
  r.request().method() === 'POST' && /\/matrix\/\d+\//.test(r.url()) && r.url().endsWith(`/${action}`);

/** Drag a card with the mouse; `before` runs while the button is still down. */
async function drag(page: Page, id: number, to: { x: number; y: number }, action = 'move', before?: () => Promise<void>) {
  const from = await centre(page, id);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  if (before) await before();
  const response = page.waitForResponse(isMove(action));
  await page.mouse.up();
  expect((await response).ok()).toBeTruthy();
}

test('live cards, dragging with hysteresis, stacking, dialog, hiding, teacher card', async ({ page, trackRoom }) => {
  test.setTimeout(120_000);
  const s = await seed(page, trackRoom);
  const { ids } = s;
  await openPresenter(page, s.room.setId);
  await expect(board(page).locator('[data-card-id]')).toHaveCount(4);
  // Cards are buttons with an accessible name (title, category, zone).
  await expect(card(page, ids.chatbot)).toHaveAccessibleName(/Chatbot.*Idee.*nützlich & modern/);

  // Live: a new participant card appears without reload.
  const fresh = await s.add(s.tokens[2], 'q4', 'Neue Idee', 'blue');
  await expect(card(page, fresh)).toBeVisible();
  await expect(card(page, fresh)).toHaveAttribute('data-zone', 'q4');

  // A little within its quadrant: stays in q1.
  await drag(page, ids.chatbot, await pointPx(page, 0.6, 0.55));
  expect((await s.serverCard(ids.chatbot)).zone).toBe('q1');
  expect((await s.serverCard(ids.chatbot)).x).toBeCloseTo(0.6, 1);

  // Far into another quadrant: q3; the target zone lights up while dragging.
  await drag(page, ids.chatbot, await pointPx(page, -0.6, -0.6), 'move', async () => {
    await expect(board(page).locator('[data-drop-zone="q3"]')).toBeVisible();
  });
  expect((await s.serverCard(ids.chatbot)).zone).toBe('q3');
  await expect(card(page, ids.chatbot)).toHaveAttribute('data-zone', 'q3');

  // Just past the border (inside the edge band, < hysteresis): unchanged.
  await drag(page, ids.chatbot, await pointPx(page, -0.05, -0.6), 'move', async () => {
    await expect(board(page).locator('[data-drop-zone="q3"]')).toBeVisible();
  });
  expect((await s.serverCard(ids.chatbot)).zone).toBe('q3');
  await expect(card(page, ids.chatbot)).toHaveAttribute('data-zone', 'q3');

  // Drop onto another card: a stack "×2" (the target stays on top).
  await drag(page, ids.feedback, await centre(page, ids.altlast), 'stack', async () => {
    await expect(card(page, ids.altlast)).toHaveAttribute('data-stack-target', 'true');
  });
  await expect(card(page, ids.altlast).getByTestId('matrix-stack-badge')).toHaveText('×2');
  await expect(card(page, ids.feedback)).toHaveCount(0);
  expect((await s.serverCard(ids.feedback)).stack).toBe(ids.altlast);

  // Click (no movement) opens the stack; "Herauslösen" splits it again.
  await card(page, ids.altlast).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Altlast' })).toBeVisible();
  await expect(dialog).toContainText('nicht nützlich & altbacken');
  await expect(dialog).toContainText('Risiko');
  const members = dialog.getByTestId('matrix-stack-list').locator('li');
  await expect(members).toHaveCount(2);
  const unstack = page.waitForResponse(isMove('unstack'));
  await members.filter({ hasText: 'Feedback-Tool' }).getByRole('button', { name: /herauslösen/i }).click();
  expect((await unstack).ok()).toBeTruthy();
  await expect(card(page, ids.feedback)).toBeVisible();
  await expect(card(page, ids.altlast).getByTestId('matrix-stack-badge')).toHaveCount(0);
  // Esc closes the dialog (not the presentation); focus back on the card.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(card(page, ids.altlast)).toBeFocused();
  await expect(page).toHaveURL(/\/present/);

  // Hide a card: gone from the board …
  await card(page, ids.podcast).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ausblenden' }).click();
  await expect(card(page, ids.podcast)).toHaveCount(0);
  expect((await s.serverCard(ids.podcast)).hidden).toBe(true);
  // … visible again (dimmed) with "Ausgeblendete anzeigen", and re-shown.
  await page.locator('[data-help="handle.mx-edit"]').click();
  const drawer = page.getByTestId('matrix-drawer');
  await drawer.getByRole('checkbox', { name: 'Ausgeblendete anzeigen' }).check();
  await expect(card(page, ids.podcast)).toHaveAttribute('data-hidden', 'true');
  await drawer.getByRole('button', { name: 'Schließen' }).click();
  await card(page, ids.podcast).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Einblenden' }).click();
  await expect(card(page, ids.podcast)).not.toHaveAttribute('data-hidden', 'true');
  expect((await s.serverCard(ids.podcast)).hidden).toBe(false);
  await page.keyboard.press('Escape');

  // Teacher card via the pencil handle.
  await page.locator('[data-help="handle.mx-edit"]').click();
  await drawer.getByLabel('Feld').selectOption({ label: 'nützlich & altbacken' });
  await drawer.getByLabel('Kategorie').selectOption({ label: 'Idee' });
  await drawer.getByLabel('Titel').fill('Lehrkarte');
  await drawer.getByLabel('Beschreibung').fill('Von der Lehrperson');
  const added = page.waitForResponse(isMove('add'));
  await drawer.getByRole('button', { name: 'Karte hinzufügen' }).click();
  const teacherId = (await (await added).json()).matrix.cards.find((c: Card) => c.title === 'Lehrkarte').id as number;
  await expect(card(page, teacherId)).toHaveAttribute('data-zone', 'q4');
  await drawer.getByRole('button', { name: 'Schließen' }).click();
  // Teacher cards can be deleted from their dialog.
  await card(page, teacherId).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Löschen' }).click();
  await expect(card(page, teacherId)).toHaveCount(0);
});

test('keyboard moves, footer views, help labels, zoom handle, axe, no overlap', async ({ page, trackRoom }) => {
  test.setTimeout(120_000);
  const s = await seed(page, trackRoom);
  const { ids } = s;
  await openPresenter(page, s.room.setId);

  // Footer: Frage · Matrix; the board is live while the vote is open.
  await expect(seg(page, 'view.question')).toBeVisible();
  await expect(seg(page, 'view.mx.raw')).toHaveAttribute('aria-checked', 'true');
  await expect(seg(page, 'view.mx.raw')).toHaveAttribute('title', /Matrix.*\(E\)/);

  // Keyboard: Tab order reaches the cards; arrows move the focused card,
  // never navigate the presentation; the zone is announced.
  await card(page, ids.podcast).focus();
  const start = await s.serverCard(ids.podcast);
  expect(start.zone).toBe('q2');
  let zone = 'q2';
  for (let i = 0; i < 40 && zone === 'q2'; i++) {
    const response = page.waitForResponse(isMove('move'));
    await page.keyboard.press('ArrowRight');
    await response;
    zone = (await card(page, ids.podcast).getAttribute('data-zone')) ?? '';
  }
  expect(zone).not.toBe('q2');
  expect((await s.serverCard(ids.podcast)).zone).toBe(zone);
  await expect(card(page, ids.podcast)).toBeFocused();
  await expect(page.getByTestId('matrix-live')).toHaveText(/^jetzt in: /);
  await expect(page.getByTestId('matrix-live')).not.toHaveText(/nicht nützlich & modern$/);
  await expect(board(page)).toBeVisible(); // → did not leave the question
  // Enter opens the dialog (and does not advance the presentation).
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page, ids.podcast)).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // Zoom handle: compact / detailed.
  await page.locator('[data-help="handle.mx-zoom"]').click();
  await expect(page.getByTestId('mx-compact')).toHaveAttribute('aria-checked', 'true');
  await expect(card(page, ids.chatbot)).not.toContainText('Beantwortet Fragen');
  await page.getByTestId('mx-detailed').click();
  await expect(card(page, ids.chatbot)).toContainText('Beantwortet Fragen');
  await page.locator('[data-help="handle.mx-zoom"]').click();

  // "?" labels the new controls.
  await page.keyboard.press('?');
  const helpFor = await page.getByTestId('help-card').evaluateAll((els) =>
    els.flatMap((e) => (e.getAttribute('data-help-for') ?? '').split(' ')),
  );
  expect(helpFor).toEqual(expect.arrayContaining(['view.mx.raw', 'handle.mx-edit', 'handle.mx-zoom']));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('presenter-help')).toHaveCount(0);

  // Axis labels and legend never overlap a card (present mode).
  await page.waitForTimeout(400);
  const rects = async (loc: ReturnType<Page['locator']>) =>
    Promise.all((await loc.all()).map(async (l) => (await l.boundingBox())!));
  const cards = await rects(board(page).locator('[data-card-id]'));
  const outside = [...(await rects(page.locator('[data-axis]'))), ...(await rects(page.getByTestId('matrix-legend')))];
  expect(outside.length).toBe(5);
  const hit = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const o of outside) for (const c of cards) expect(hit(o, c), JSON.stringify({ o, c })).toBe(false);

  // axe on the presenter page with the board.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(
    violations.map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) })),
  ).toEqual([]);

  // E closes onto the board, A switches to the question and back.
  await page.keyboard.press('e');
  await expect(seg(page, 'view.question')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(seg(page, 'view.mx.raw')).toHaveAttribute('aria-checked', 'true');
  await expect(board(page)).toBeVisible();
  await page.keyboard.press('a');
  await expect(seg(page, 'view.question')).toHaveAttribute('aria-checked', 'true');
  await expect(board(page)).toHaveCount(0);
  await page.keyboard.press('e');
  await expect(seg(page, 'view.mx.raw')).toHaveAttribute('aria-checked', 'true');
  await expect(board(page)).toBeVisible();
});
