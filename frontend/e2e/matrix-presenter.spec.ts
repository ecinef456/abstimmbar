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

async function seed(
  page: Page,
  trackRoom: (id: number) => void,
  opts: { overrides?: Record<string, unknown>; tokens?: number } = {},
) {
  const room = await createRoomWithQuestions(page.request, [], 'Matrix Beamer', trackRoom, 'E2E Matrix Beamer');
  const api = apiClient(page.request);
  const questionId = await createMatrixQuestion(api, room.setId, opts.overrides);
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const tokens = await joinParticipants(page.request, room.code, opts.tokens ?? 3);
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

const ZONE = {
  q1: 'nützlich & modern',
  q2: 'nicht nützlich & modern',
  q3: 'nicht nützlich & altbacken',
  q4: 'nützlich & altbacken',
  e_top: 'zwischen nicht nützlich & modern und nützlich & modern',
  e_right: 'zwischen nützlich & modern und nützlich & altbacken',
  e_bottom: 'zwischen nicht nützlich & altbacken und nützlich & altbacken',
  e_left: 'zwischen nicht nützlich & modern und nicht nützlich & altbacken',
} as const;

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

/** "rgb(r, g, b)" → [r, g, b]. */
const rgb = (css: string) => (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number) as [number, number, number];
/** WCAG contrast ratio of two computed colours. */
function contrast(a: string, b: string) {
  const lum = (css: string) => {
    const [r, g, bl] = rgb(css).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Computed colours of a card: tab background + text, body background, title colour/size. */
async function cardColours(page: Page, id: number) {
  return card(page, id).evaluate((el) => {
    // Computed colours may be oklch(): paint them to read sRGB back.
    const toRgb = (css: string) => {
      const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d')!;
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    };
    const tab = el.querySelector('[data-card-tab]') as HTMLElement;
    const body = el.querySelector('[data-card-body]') as HTMLElement;
    const title = el.querySelector('[data-card-title]') as HTMLElement;
    return {
      tab: toRgb(getComputedStyle(tab).backgroundColor),
      tabText: tab.textContent ?? '',
      tabColor: toRgb(getComputedStyle(tab).color),
      body: toRgb(getComputedStyle(body).backgroundColor),
      text: toRgb(getComputedStyle(title).color),
      titleSize: parseFloat(getComputedStyle(title).fontSize),
    };
  });
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

  // Card colouring (named mode): the tab carries the full category colour
  // (no letter), the body a light tint of it; the text stays dark.
  const chatbotStyle = await cardColours(page, ids.chatbot);
  expect(chatbotStyle.tab).toBe('rgb(0, 114, 178)'); // Idee = blue
  expect(chatbotStyle.tabText).toBe('');
  expect(chatbotStyle.body).not.toBe('rgb(255, 255, 255)');
  const [r, , b] = rgb(chatbotStyle.body);
  expect(b).toBeGreaterThan(r); // tinted towards the blue
  expect(contrast(chatbotStyle.text, chatbotStyle.body)).toBeGreaterThanOrEqual(4.5);
  // Beamer-sized title.
  expect(chatbotStyle.titleSize).toBeGreaterThanOrEqual(18);

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
  // Opened with the mouse: no card is left focused (it would be :focus-visible
  // after Esc and the clicker's arrows would move it).
  await expect(card(page, ids.altlast)).not.toBeFocused();
  await expect(page).toHaveURL(/\/present/);

  // Hide a card: gone from the board …
  await card(page, ids.podcast).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ausblenden' }).click();
  await expect(card(page, ids.podcast)).toHaveCount(0);
  // Focus lands on the board (nearest card or the board), never on body.
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-matrix-board]')))
    .toBe(true);
  expect((await s.serverCard(ids.podcast)).hidden).toBe(true);
  // … visible again (dimmed) with "Ausgeblendete anzeigen", and re-shown.
  await page.locator('[data-help="handle.mx-edit"]').click();
  const drawer = page.getByTestId('matrix-drawer');
  await drawer.getByRole('tab', { name: 'Moderieren' }).click();
  await drawer.getByRole('checkbox', { name: 'Ausgeblendete anzeigen' }).check();
  await expect(card(page, ids.podcast)).toHaveAttribute('data-hidden', 'true');
  await drawer.getByRole('button', { name: 'Schließen' }).click();
  await card(page, ids.podcast).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Einblenden' }).click();
  await expect(card(page, ids.podcast)).not.toHaveAttribute('data-hidden', 'true');
  expect((await s.serverCard(ids.podcast)).hidden).toBe(false);
  await page.keyboard.press('Escape');

  // Teacher card via the pencil handle: the same axis-cross picker as the
  // participants (4 fields + 4 edges with written-out names, "+" until chosen).
  await page.locator('[data-help="handle.mx-edit"]').click();
  const picker = drawer.getByRole('group', { name: 'Feld wählen' });
  await expect(picker.getByRole('button')).toHaveCount(8);
  for (const name of Object.values(ZONE)) {
    await expect(picker.getByRole('button', { name, exact: true })).toBeVisible();
  }
  for (const end of ['nicht nützlich', 'nützlich', 'altbacken', 'modern']) {
    await expect(drawer.locator('[data-picker-axis]', { hasText: end }).first()).toBeVisible();
  }
  const q4 = picker.getByRole('button', { name: ZONE.q4, exact: true });
  await expect(q4.locator('[data-icon="plus"]')).toBeVisible();
  await q4.click();
  await expect(q4).toHaveAttribute('aria-pressed', 'true');
  await expect(q4.locator('[data-icon="check"]')).toBeVisible();
  await expect(q4.locator('[data-icon="plus"]')).toHaveCount(0);
  await expect(picker.locator('[aria-pressed="true"]')).toHaveCount(1);
  const ideaChip = drawer.getByRole('radiogroup', { name: 'Kategorie wählen' }).getByRole('radio', { name: 'Idee' });
  await ideaChip.click();
  await expect(ideaChip).toHaveAttribute('aria-checked', 'true');
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

  // Pencil opened from the keyboard: focus moves in; Esc returns it.
  await page.locator('[data-help="handle.mx-edit"]').focus();
  await page.keyboard.press('Enter');
  // (the selected field of the picker)
  await expect(
    page.getByTestId('matrix-drawer').getByRole('button', { name: ZONE.q1, exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-help="handle.mx-edit"]')).toBeFocused();
  await expect(page).toHaveURL(/\/present/);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // Zoom handle: compact / detailed.
  await page.locator('[data-help="handle.mx-zoom"]').click();
  // Compact / detailed are icon toggles (tooltip, accessible name, aria-pressed).
  await expect(page.getByTestId('mx-compact')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('mx-compact')).toHaveAccessibleName('Kompakt');
  await expect(page.getByTestId('mx-compact')).toHaveAttribute('title', 'Kompakt');
  await expect(page.getByTestId('mx-compact')).toHaveText('');
  await expect(page.getByTestId('mx-compact').locator('svg')).toBeVisible();
  await expect(page.getByTestId('mx-detailed')).toHaveAccessibleName('Ausführlich');
  await expect(page.getByTestId('mx-detailed')).toHaveAttribute('aria-pressed', 'false');
  await expect(card(page, ids.chatbot)).not.toContainText('Beantwortet Fragen');
  await page.getByTestId('mx-detailed').click();
  await expect(page.getByTestId('mx-detailed')).toHaveAttribute('aria-pressed', 'true');
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

  // Axis labels: presentation-sized; the x ends run vertically (left reads
  // bottom-to-top, right top-to-bottom), the y ends horizontally.
  const axis = (name: string) =>
    page.locator(`[data-axis="${name}"]`).evaluate((el) => {
      const text = (el.querySelector('[data-axis-text]') ?? el) as HTMLElement;
      const cs = getComputedStyle(text);
      const r = text.getBoundingClientRect();
      return { mode: cs.writingMode, transform: cs.transform, size: parseFloat(cs.fontSize), w: r.width, h: r.height };
    });
  for (const name of ['x_from', 'x_to']) {
    const a = await axis(name);
    expect(a.mode, name).toBe('vertical-rl');
    expect(a.h, name).toBeGreaterThan(a.w);
    expect(a.size, name).toBeGreaterThanOrEqual(18);
  }
  expect((await axis('x_from')).transform).not.toBe('none'); // rotated: bottom-to-top
  for (const name of ['y_from', 'y_to']) {
    const a = await axis(name);
    expect(a.mode, name).toBe('horizontal-tb');
    expect(a.size, name).toBeGreaterThanOrEqual(18);
  }
  // Legend: the app's legend look, presentation-sized on the beamer (like
  // the axis labels: text-xl, 16px rounded square swatches).
  const legendStyle = await page.getByTestId('matrix-legend').evaluate((el) => {
    const swatch = el.querySelector('[data-swatch]') as HTMLElement;
    return {
      size: parseFloat(getComputedStyle(el).fontSize),
      swatch: [swatch.getBoundingClientRect().width, swatch.getBoundingClientRect().height],
    };
  });
  expect(legendStyle).toEqual({ size: 20, swatch: [16, 16] });

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

test('after a keyboard move, a click ends the keyboard session: → navigates again', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  const s = await seed(page, trackRoom);
  await openPresenter(page, s.room.setId);
  await card(page, s.ids.podcast).focus();
  const moved = page.waitForResponse(isMove('move'));
  await page.keyboard.press('ArrowRight');
  await moved;
  // Click outside the cards (the question text), then an SSE frame arrives.
  await page.locator('main').getByText('Wohin gehört die Idee?').click();
  const fresh = await s.add(s.tokens[2], 'q4', 'Nach dem Klick', 'blue');
  await expect(card(page, fresh)).toBeVisible();
  await page.waitForTimeout(300);
  const moves: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/matrix\/\d+\/move$/.test(r.url())) moves.push(r.url());
  });
  await page.keyboard.press('ArrowRight');
  // The presentation moves on (last question → closing slide): board gone.
  // Moving on from an open vote asks first — the presenter navigated.
  await expect(page.getByRole('heading', { name: 'Abstimmung läuft noch' })).toBeVisible();
  expect(moves).toEqual([]);
});

test('new-card highlight expires for every batch, also when batches arrive 600 ms apart', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  const s = await seed(page, trackRoom);
  await openPresenter(page, s.room.setId);
  await expect(board(page).locator('[data-card-id]')).toHaveCount(4);
  const first = await s.add(s.tokens[2], 'q4', 'Erste neue', 'blue');
  await page.waitForTimeout(600);
  const second = await s.add(s.tokens[2], 'q4', 'Zweite neue', 'blue');
  await expect(card(page, first)).toBeVisible();
  await expect(card(page, second)).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(board(page).locator('[data-fresh]')).toHaveCount(0);
});

test('dropping onto a hidden card does not stack (and the server refuses it)', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  const s = await seed(page, trackRoom);
  const { ids } = s;
  await s.api.post(`/api/runs/${s.runId}/matrix/${s.questionId}/hide`, { card: ids.altlast, hidden: true });
  const refused = await page.request.post(`${API_BASE_URL}/api/runs/${s.runId}/matrix/${s.questionId}/stack`, {
    data: { card: ids.feedback, onto: ids.altlast },
    headers: { 'X-CSRFToken': (await csrfToken(page.request)) ?? '' },
  });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).detail).toBe('Cannot stack onto a hidden card.');

  await openPresenter(page, s.room.setId);
  await page.locator('[data-help="handle.mx-edit"]').click();
  const drawer = page.getByTestId('matrix-drawer');
  await drawer.getByRole('tab', { name: 'Moderieren' }).click();
  await drawer.getByRole('checkbox', { name: 'Ausgeblendete anzeigen' }).check();
  await drawer.getByRole('button', { name: 'Schließen' }).click();
  await expect(card(page, ids.altlast)).toHaveAttribute('data-hidden', 'true');
  const stacks: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/matrix\/\d+\/stack$/.test(r.url())) stacks.push(r.url());
  });
  await drag(page, ids.feedback, await centre(page, ids.altlast), 'move');
  expect(stacks).toEqual([]);
  expect((await s.serverCard(ids.feedback)).stack).toBeNull();
  expect((await s.serverCard(ids.feedback)).hidden).toBe(false);
});

test('mouse-closed drawer leaves no handle focused', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  const s = await seed(page, trackRoom);
  await openPresenter(page, s.room.setId);
  const focusedInHandles = () =>
    page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && a !== document.body && !!a.closest('[data-help^="handle."], [data-testid="matrix-drawer"], [data-beamer-inset]');
    });
  await page.locator('[data-help="handle.mx-edit"]').click();
  const drawer = page.getByTestId('matrix-drawer');
  await drawer.getByLabel('Titel').click(); // focus inside the drawer
  await drawer.getByRole('button', { name: 'Schließen' }).click();
  await expect(drawer).toHaveAttribute('inert', '');
  expect(await focusedInHandles()).toBe(false);
});

test('colour mode: lettered tabs with contrast, tinted bodies; crowded boards scale the cards down', async ({ page, trackRoom }) => {
  test.setTimeout(120_000);
  const s = await seed(page, trackRoom, {
    tokens: 8,
    overrides: {
      matrix_category_mode: 'colors',
      matrix_categories: [
        { key: 'green', name: { de: '', en: '' } },
        { key: 'blue', name: { de: '', en: '' } },
        { key: 'red', name: { de: '', en: '' } },
        { key: 'orange', name: { de: '', en: '' } },
      ],
    },
  });
  await openPresenter(page, s.room.setId);
  await expect(board(page).locator('[data-card-id]')).toHaveCount(4);
  await page.waitForTimeout(400);
  // The seed's "blue" cards are category B (letters follow the list position).
  const chatbot = await cardColours(page, s.ids.chatbot);
  expect(chatbot.tab).toBe('rgb(0, 114, 178)');
  expect(chatbot.tabText).toBe('B');
  expect(contrast(chatbot.tabColor, chatbot.tab)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(chatbot.text, chatbot.body)).toBeGreaterThanOrEqual(4.5);
  const roomy = chatbot.titleSize;
  expect(roomy).toBeGreaterThanOrEqual(18);
  const altlast = await cardColours(page, s.ids.altlast);
  expect(altlast.tabText).toBe('D'); // orange: near-black letter
  expect(contrast(altlast.tabColor, altlast.tab)).toBeGreaterThanOrEqual(4.5);

  // Every palette colour used gets a readable letter (white or near-black).
  const extra: number[] = [];
  const zones = ['q1', 'q1', 'q1', 'q2', 'q2', 'q3', 'q4', 'q4', 'q4', 'q1'];
  const cats = ['green', 'red', 'blue'];
  for (let i = 0; i < zones.length; i++) {
    extra.push(await s.add(s.tokens[3 + Math.floor(i / 2)], zones[i], `Idee Nummer ${i + 1}`, cats[i % 3]));
  }
  await expect(board(page).locator('[data-card-id]')).toHaveCount(14);
  await s.api.post(`/api/runs/${s.runId}/matrix/${s.questionId}/stack`, { card: extra[9], onto: extra[0] });
  await expect(board(page).locator('[data-card-id]')).toHaveCount(13);
  await page.waitForTimeout(600);
  for (const id of extra.slice(0, 3)) {
    const c = await cardColours(page, id);
    expect(['A', 'B', 'C']).toContain(c.tabText);
    expect(contrast(c.tabColor, c.tab), `letter contrast ${c.tab}`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.text, c.body)).toBeGreaterThanOrEqual(4.5);
  }
  // Crowded: smaller cards, but not tiny; all inside the plot box.
  const crowded = (await cardColours(page, s.ids.chatbot)).titleSize;
  expect(crowded).toBeLessThan(roomy);
  expect(crowded).toBeGreaterThanOrEqual(12);
  const plot = (await board(page).boundingBox())!;
  for (const loc of await board(page).locator('[data-card-id]').all()) {
    const b = (await loc.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(plot.x - 0.5);
    expect(b.y).toBeGreaterThanOrEqual(plot.y - 0.5);
    expect(b.x + b.width).toBeLessThanOrEqual(plot.x + plot.width + 0.5);
    expect(b.y + b.height).toBeLessThanOrEqual(plot.y + plot.height + 0.5);
  }
  // Legend shows the letters.
  await expect(page.getByTestId('matrix-legend').getByRole('button')).toHaveText(['A', 'B', 'C', 'D']);
});

/** The transform of the zoomable board (scale, translate x/y). */
async function boardView(page: Page) {
  return page.getByTestId('matrix-viewport').evaluate((el) => {
    const world = el.querySelector('[data-matrix-world]') as HTMLElement;
    const m = new DOMMatrix(getComputedStyle(world).transform);
    return { s: m.a, x: m.e, y: m.f, focus: el.getAttribute('data-focus') };
  });
}

type Rect = { x: number; y: number; width: number; height: number };
const inside = (a: Rect, b: Rect, tol = 0.5) =>
  a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.width <= b.x + b.width + tol && a.y + a.height <= b.y + b.height + tol;
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const OUTER: Record<string, [string, string]> = {
  q1: ['y_to', 'x_to'],
  q2: ['y_to', 'x_from'],
  q3: ['y_from', 'x_from'],
  q4: ['y_from', 'x_to'],
};

/** A focused quadrant is framed exactly: its rect fully inside the stage
 *  (the viewport, clear of the edge handles / overlays and the focus bar),
 *  its two outer axis labels fully visible, the other quadrants' interiors
 *  not visible (a few px at the inner axis lines at most). */
async function expectFramed(page: Page, q: 'q1' | 'q2' | 'q3' | 'q4') {
  const vp = (await page.getByTestId('matrix-viewport').boundingBox())!;
  const plot = (await board(page).boundingBox())!;
  const right = q === 'q1' || q === 'q4';
  const bottom = q === 'q3' || q === 'q4';
  const quad = { x: plot.x + (right ? plot.width / 2 : 0), y: plot.y + (bottom ? plot.height / 2 : 0), width: plot.width / 2, height: plot.height / 2 };
  expect(inside(quad, vp), `${q} inside the viewport: ${JSON.stringify({ quad, vp })}`).toBe(true);
  const blockers = [
    ...(await page.locator('[data-beamer-inset]').all()),
    page.getByTestId('matrix-focus-bar'),
  ];
  for (const el of blockers) {
    if (!(await el.isVisible())) continue;
    const b = await el.boundingBox();
    if (b && b.width > 0) expect(intersects(quad, b), `${q} under an overlay: ${JSON.stringify(b)}`).toBe(false);
  }
  for (const name of OUTER[q]) {
    const label = page.locator(`[data-axis="${name}"] [data-axis-label]`);
    const b = (await label.boundingBox())!;
    expect(inside(b, vp), `${q}: label ${name} inside the viewport`).toBe(true);
    // Fully visible: every corner hits the label (not clipped, not covered).
    const corners = [
      [b.x + 2, b.y + 2],
      [b.x + b.width - 2, b.y + 2],
      [b.x + 2, b.y + b.height - 2],
      [b.x + b.width - 2, b.y + b.height - 2],
    ];
    for (const [x, y] of corners) {
      const hit = await page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return el?.closest('[data-axis]')?.getAttribute('data-axis') ?? el?.tagName ?? null;
      }, [x, y]);
      expect(hit, `${q}: label ${name} visible at ${x},${y}`).toBe(name);
    }
  }
  // The other quadrants' interiors are not visible 8 px past the inner axes.
  const ax = plot.x + plot.width / 2;
  const ay = plot.y + plot.height / 2;
  const sx = right ? -1 : 1;
  const sy = bottom ? -1 : 1;
  const qcx = quad.x + quad.width / 2;
  const qcy = quad.y + quad.height / 2;
  const probes = [
    [ax + sx * 8, qcy],
    [qcx, ay + sy * 8],
    [ax + sx * 8, ay + sy * 8],
  ];
  for (const [x, y] of probes) {
    if (x < vp.x || x > vp.x + vp.width || y < vp.y || y > vp.y + vp.height) continue;
    const inWorld = await page.evaluate(([px, py]) => !!document.elementFromPoint(px, py)?.closest('[data-matrix-world]'), [x, y]);
    expect(inWorld, `${q}: neighbour visible at ${x},${y}`).toBe(false);
  }
}

test('whole-board zoom and pan, quadrant focus with next/previous/overview, drag while zoomed', async ({ page, trackRoom }) => {
  test.setTimeout(120_000);
  const s = await seed(page, trackRoom);
  const { ids } = s;
  await openPresenter(page, s.room.setId);
  await expect(board(page).locator('[data-card-id]')).toHaveCount(4);
  const settle = () => page.waitForTimeout(700);
  await settle();
  const before = (await card(page, ids.chatbot).boundingBox())!;
  const labelBefore = (await page.locator('[data-axis="y_to"]').boundingBox())!;
  expect((await boardView(page)).s).toBeCloseTo(1, 2);

  // + zooms the whole board: cards AND labels grow together.
  await page.locator('[data-help="handle.mx-zoom"]').click();
  await page.getByRole('button', { name: 'Vergrößern (+)' }).click();
  await settle();
  const zoomed = await boardView(page);
  expect(zoomed.s).toBeGreaterThan(1.1);
  const after = (await card(page, ids.chatbot).boundingBox())!;
  expect(after.width / before.width).toBeCloseTo(zoomed.s, 1);
  const labelAfter = (await page.locator('[data-axis="y_to"]').boundingBox())!;
  expect(labelAfter.height / labelBefore.height).toBeCloseTo(zoomed.s, 1);
  // Reset (fit) returns to the overview.
  await page.getByRole('button', { name: 'An Bildschirm anpassen (0)' }).click();
  await settle();
  expect((await boardView(page)).s).toBeCloseTo(1, 2);
  await page.locator('[data-help="handle.mx-zoom"]').click();

  // Keys: + zooms, Shift+arrows pan (and don't navigate), 0 fits.
  await page.keyboard.press('+');
  await settle();
  const k = await boardView(page);
  expect(k.s).toBeGreaterThan(1.1);
  await page.keyboard.press('Shift+ArrowRight');
  await settle();
  expect((await boardView(page)).x).toBeLessThan(k.x);
  await expect(board(page)).toBeVisible(); // still on the matrix question
  await page.keyboard.press('0');
  await settle();
  expect((await boardView(page)).s).toBeCloseTo(1, 2);

  // Wheel over the board zooms at the pointer.
  const bb = (await board(page).boundingBox())!;
  await page.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height * 0.3);
  await page.mouse.wheel(0, -400);
  await settle();
  expect((await boardView(page)).s).toBeGreaterThan(1.05);
  // Drag on empty space pans.
  const pv = await boardView(page);
  await page.mouse.move(bb.x + bb.width * 0.45, bb.y + bb.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * 0.45 - 120, bb.y + bb.height * 0.75 - 40, { steps: 8 });
  await page.mouse.up();
  const panned = await boardView(page);
  expect(panned.x).toBeLessThan(pv.x - 50);
  await page.keyboard.press('0');
  await settle();

  // Quadrant magnifier: fills the screen with the field.
  const vp = (await page.getByTestId('matrix-viewport').boundingBox())!;
  await page.getByRole('button', { name: 'Feld „nützlich & modern“ vergrößern' }).click();
  await settle();
  let v = await boardView(page);
  expect(v.focus).toBe('q1');
  expect(v.s).toBeGreaterThan(1.6);
  const toolbar = page.getByTestId('matrix-focus-bar');
  await expect(toolbar).toContainText('nützlich & modern');
  // The quadrant now spans (almost) the stage's width or height.
  const plot = (await board(page).boundingBox())!;
  const qw = plot.width / 2;
  const qh = plot.height / 2;
  expect(Math.max(qw / vp.width, qh / vp.height)).toBeGreaterThan(0.7);
  await expectFramed(page, 'q1');

  // Drag still lands where the pointer is (board coordinates under zoom).
  await drag(page, ids.chatbot, await pointPx(page, 0.7, 0.6));
  const moved = await s.serverCard(ids.chatbot);
  expect(moved.zone).toBe('q1');
  expect(moved.x).toBeCloseTo(0.7, 1);
  expect(moved.y).toBeCloseTo(0.6, 1);
  // A click still opens the card.
  await card(page, ids.chatbot).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await boardView(page)).focus).toBe('q1'); // Esc closed only the dialog

  // Next / previous field in reading order q2 → q1 → q3 → q4: buttons and ] / [.
  await toolbar.getByRole('button', { name: 'Nächstes Feld' }).click();
  await settle();
  expect((await boardView(page)).focus).toBe('q3');
  await expectFramed(page, 'q3');
  // "." / "," work unmodified on German keyboards; [ / ] also with Option /
  // AltGr (which is how they are typed there).
  await page.keyboard.press('.');
  await settle();
  expect((await boardView(page)).focus).toBe('q4');
  await expectFramed(page, 'q4');
  await page.keyboard.press(']');
  await settle();
  expect((await boardView(page)).focus).toBe('q2');
  await expectFramed(page, 'q2');
  await page.keyboard.press(',');
  await settle();
  expect((await boardView(page)).focus).toBe('q4');
  await toolbar.getByRole('button', { name: 'Vorheriges Feld' }).click();
  await settle();
  expect((await boardView(page)).focus).toBe('q3');
  await page.keyboard.press('Alt+[');
  await settle();
  expect((await boardView(page)).focus).toBe('q1');
  await page.keyboard.press('Control+Alt+]');
  await settle();
  expect((await boardView(page)).focus).toBe('q3');
  await page.keyboard.press('[');
  await settle();
  expect((await boardView(page)).focus).toBe('q1');

  // "?" labels the new controls.
  await page.keyboard.press('?');
  const helpFor = await page.getByTestId('help-card').evaluateAll((els) =>
    els.flatMap((e) => (e.getAttribute('data-help-for') ?? '').split(' ')),
  );
  expect(helpFor).toEqual(expect.arrayContaining(['mx.prev-field', 'mx.next-field', 'mx.overview']));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('presenter-help')).toHaveCount(0);

  // Esc returns to the overview — it does not leave the presentation.
  await page.keyboard.press('Escape');
  await settle();
  v = await boardView(page);
  expect(v.focus).toBeNull();
  expect(v.s).toBeCloseTo(1, 2);
  await expect(toolbar).toHaveCount(0);
  await expect(page).toHaveURL(/\/present/);
  await expect(page.getByRole('heading', { name: 'Abstimmung läuft noch' })).toHaveCount(0);
  await expect(board(page)).toBeVisible();
  // Overview: the magnifier is labelled in the help overlay.
  await page.keyboard.press('?');
  const helpOverview = await page.getByTestId('help-card').evaluateAll((els) =>
    els.flatMap((e) => (e.getAttribute('data-help-for') ?? '').split(' ')),
  );
  expect(helpOverview).toEqual(expect.arrayContaining(['mx.focus']));
  await page.keyboard.press('Escape');
});

test('crowded board: drawn cards never overlap (collision avoidance within the zone)', async ({ page, trackRoom }) => {
  test.setTimeout(120_000);
  const s = await seed(page, trackRoom, { tokens: 8 });
  const titles: [string, string][] = [
    ['q1', 'Lernvideos zum Nacharbeiten'],
    ['q1', 'Peer-Review'],
    ['q1', 'Umfrage-Tool'],
    ['q2', 'VR-Labor'],
    ['q3', 'Overhead-Folien'],
    ['q3', 'Faxformular'],
    ['q4', 'Klausur auf Papier'],
    ['q4', 'Sprechstunde'],
    ['e_top', 'Wiki'],
    ['e_left', 'E-Mail-Verteiler'],
  ];
  const extra: number[] = [];
  for (let i = 0; i < titles.length; i++) {
    extra.push(await s.add(s.tokens[3 + Math.floor(i / 2)], titles[i][0], titles[i][1], i % 2 ? 'blue' : 'orange'));
  }
  // A stack in the crowded quadrant.
  await s.api.post(`/api/runs/${s.runId}/matrix/${s.questionId}/stack`, { card: extra[2], onto: s.ids.chatbot });
  await openPresenter(page, s.room.setId);
  await expect(board(page).locator('[data-card-id]')).toHaveCount(13);
  await page.waitForTimeout(900);
  // Boxes incl. a stack's paper offset (6 px right/bottom, box-shadow).
  const boxes = await Promise.all(
    (await board(page).locator('[data-card-id]').all()).map(async (l) => {
      const b = (await l.boundingBox())!;
      const pad = Number(await l.getAttribute('data-stack-size')) > 1 ? 6 : 0;
      return {
        id: await l.getAttribute('data-card-id'),
        zone: await l.getAttribute('data-zone'),
        x: b.x,
        y: b.y,
        width: b.width + pad,
        height: b.height + pad,
      };
    }),
  );
  expect(boxes.some((b) => b.id === String(s.ids.chatbot))).toBe(true); // the stack is drawn
  const hit = (a: (typeof boxes)[number], b: (typeof boxes)[number]) =>
    a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) expect(hit(boxes[i], boxes[j]), JSON.stringify([boxes[i], boxes[j]])).toBe(false);
  // Every card (with its paper offset) lies fully inside the plot border.
  const plot = (await board(page).boundingBox())!;
  for (const b of boxes) {
    expect(b.x, JSON.stringify(b)).toBeGreaterThanOrEqual(plot.x + 1);
    expect(b.y, JSON.stringify(b)).toBeGreaterThanOrEqual(plot.y + 1);
    expect(b.x + b.width, JSON.stringify(b)).toBeLessThanOrEqual(plot.x + plot.width - 1);
    expect(b.y + b.height, JSON.stringify(b)).toBeLessThanOrEqual(plot.y + plot.height - 1);
  }
  // Quadrant cards stay in their quadrant (centre on the right side of the axes).
  const cx = plot.x + plot.width / 2;
  const cy = plot.y + plot.height / 2;
  for (const b of boxes) {
    const mx = b.x + b.width / 2;
    const my = b.y + b.height / 2;
    if (b.zone === 'q1') expect(mx > cx && my < cy, JSON.stringify(b)).toBe(true);
    if (b.zone === 'q2') expect(mx < cx && my < cy, JSON.stringify(b)).toBe(true);
    if (b.zone === 'q3') expect(mx < cx && my > cy, JSON.stringify(b)).toBe(true);
    if (b.zone === 'q4') expect(mx > cx && my > cy, JSON.stringify(b)).toBe(true);
  }
  // The stored positions are untouched (only the drawing is nudged).
  const stored = await s.serverCard(extra[0]);
  expect(stored.zone).toBe('q1');
});

/** Four field tints as computed sRGB, keyed by quadrant. */
async function fieldTints(page: Page) {
  return page.locator('[data-matrix-board] [data-tint]').evaluateAll((els) =>
    Object.fromEntries(
      els.map((el) => [el.getAttribute('data-tint')!, getComputedStyle(el).backgroundColor.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number)]),
    ),
  ) as Promise<Record<string, [number, number, number]>>;
}

test('axis labels carry no arrow glyphs; four distinct semantic field tints', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  const s = await seed(page, trackRoom);
  await openPresenter(page, s.room.setId);
  for (const name of ['y_to', 'y_from', 'x_to', 'x_from']) {
    const text = (await page.locator(`[data-axis="${name}"] [data-axis-label]`).textContent()) ?? '';
    expect(text, name).not.toMatch(/[↑↓←→⬆⬇]/);
    expect(text.trim().length, name).toBeGreaterThan(0);
  }
  const t = await fieldTints(page);
  expect(Object.keys(t).sort()).toEqual(['q1', 'q2', 'q3', 'q4']);
  const key = (c: number[]) => c.join(',');
  expect(new Set(Object.values(t).map(key)).size).toBe(4);
  // q1 greenish, q3 reddish, q2 warm yellow (red & green over blue), q4 bluish grey.
  expect(t.q1[1]).toBeGreaterThan(t.q1[0]);
  expect(t.q1[1]).toBeGreaterThan(t.q1[2]);
  expect(t.q3[0]).toBeGreaterThan(t.q3[1]);
  expect(t.q3[0]).toBeGreaterThan(t.q3[2]);
  expect(Math.min(t.q2[0], t.q2[1]) - t.q2[2]).toBeGreaterThanOrEqual(10);
  expect(t.q4[2]).toBeGreaterThan(t.q4[0]);
  // Light enough for the cards and their text (contrast of near-black text).
  for (const c of Object.values(t)) expect(contrast('rgb(15, 23, 42)', `rgb(${c.join(', ')})`)).toBeGreaterThanOrEqual(12);
});

test('card font is one step smaller than before', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  const s = await seed(page, trackRoom);
  await openPresenter(page, s.room.setId);
  await page.waitForTimeout(400);
  const w = (await board(page).boundingBox())!.width;
  const size = await card(page, s.ids.chatbot).locator('[data-card-title]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  // Previously 0.02 × plot width (clamped 14–30); now about 0.017.
  expect(size).toBeLessThanOrEqual(Math.max(13, w * 0.0175));
  expect(size).toBeGreaterThanOrEqual(13);
});

test('moderation view: hidden cards restore, stacks release members / dissolve', async ({ page, trackRoom }) => {
  test.setTimeout(120_000);
  const s = await seed(page, trackRoom);
  await openPresenter(page, s.room.setId);
  await page.locator('[data-help="handle.mx-edit"]').click();
  const drawer = page.getByTestId('matrix-drawer');
  // Two views behind a labelled switch; "Karte hinzufügen" is the default.
  const views = drawer.getByRole('tablist');
  await expect(views.getByRole('tab', { name: 'Karte hinzufügen' })).toHaveAttribute('aria-selected', 'true');
  await expect(drawer.getByRole('textbox', { name: 'Titel' })).toBeVisible();
  await views.getByRole('tab', { name: 'Moderieren' }).click();
  await expect(drawer.getByText('Noch nichts moderiert.')).toBeVisible();
  await expect(drawer.getByRole('checkbox', { name: 'Ausgeblendete anzeigen' })).toBeVisible();
  await expect(drawer.getByRole('textbox', { name: 'Titel' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Schließen' }).click();

  // Hide Podcast via the dialog, stack Feedback-Tool onto Altlast? (Altlast is q3, Feedback q1: stacking is zone-free.)
  await card(page, s.ids.podcast).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ausblenden' }).click();
  await expect(card(page, s.ids.podcast)).toHaveCount(0);
  await drag(page, s.ids.feedback, await centre(page, s.ids.altlast), 'stack');
  await page.locator('[data-help="handle.mx-edit"]').click();
  await drawer.getByRole('tab', { name: 'Moderieren' }).click();
  await expect(drawer.getByText('Noch nichts moderiert.')).toHaveCount(0);
  await drawer.getByRole('tab', { name: 'Karte hinzufügen' }).click();
  await drawer.getByRole('tab', { name: 'Moderieren' }).click();
  const hiddenSection = drawer.getByRole('region', { name: 'Ausgeblendet' });
  await expect(hiddenSection.getByText('Podcast')).toBeVisible();
  const stackSection = drawer.getByRole('region', { name: 'Stapel' });
  await expect(stackSection).toContainText('Altlast');
  await expect(stackSection).toContainText('2');
  await expect(stackSection.getByText('Feedback-Tool')).toBeVisible();

  // Wieder anzeigen restores the hidden card.
  const show = page.waitForResponse(isMove('hide'));
  await hiddenSection.getByRole('button', { name: /Podcast.*anzeigen|Wieder anzeigen/ }).click();
  expect((await show).ok()).toBeTruthy();
  expect((await s.serverCard(s.ids.podcast)).hidden).toBe(false);
  await expect(drawer.getByRole('region', { name: 'Ausgeblendet' })).toHaveCount(0);

  // Herauslösen releases one member.
  const un = page.waitForResponse(isMove('unstack'));
  await stackSection.getByRole('button', { name: /Feedback-Tool herauslösen/ }).click();
  expect((await un).ok()).toBeTruthy();
  expect((await s.serverCard(s.ids.feedback)).stack).toBeNull();
  await expect(drawer.getByRole('region', { name: 'Stapel' })).toHaveCount(0);

  // Stack again with two members, then "Stapel auflösen" releases all.
  await drawer.getByRole('button', { name: 'Schließen' }).click();
  await drag(page, s.ids.feedback, await centre(page, s.ids.altlast), 'stack');
  await drag(page, s.ids.podcast, await centre(page, s.ids.altlast), 'stack');
  await page.locator('[data-help="handle.mx-edit"]').click();
  await drawer.getByRole('tab', { name: 'Moderieren' }).click();
  await expect(drawer.getByRole('region', { name: 'Stapel' }).locator('li')).toHaveCount(2);
  await drawer.getByRole('button', { name: /Stapel Altlast auflösen/ }).click();
  await expect.poll(async () => (await s.serverCard(s.ids.feedback)).stack).toBeNull();
  await expect.poll(async () => (await s.serverCard(s.ids.podcast)).stack).toBeNull();
  await expect(drawer.getByRole('region', { name: 'Stapel' })).toHaveCount(0);

  // "?" labels the drawer's view switch.
  await page.keyboard.press('?');
  const helpFor = await page.getByTestId('help-card').evaluateAll((els) =>
    els.flatMap((e) => (e.getAttribute('data-help-for') ?? '').split(' ')),
  );
  expect(helpFor).toContain('mx.drawer-views');
  await page.keyboard.press('Escape');
});
