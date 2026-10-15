/** Four-field matrix, rating stage on the beamer (desktop): the footer's
 *  "Bewertung starten" / "Zurück zum Sammeln", raters while the scores are
 *  hidden, fill bars + score text on the cards once they are shown (points
 *  and plus/minus), the "Rangliste" view, Stop/E with hidden scores, the
 *  stack lock (drag only moves, moderation hint, dialog), help labels, axe.
 *
 *  Runs as `demo`; seeds its own "E2E Matrix Rating" rooms and deletes them.
 *  MATRIX_RATING_SHOTS=<dir> saves screenshots. */
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

const SHOTS = process.env.MATRIX_RATING_SHOTS ?? '';

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

type Card = { id: number; zone: string; stack: number | null; hidden: boolean };

async function seed(page: Page, trackRoom: (id: number) => void, overrides: Record<string, unknown>) {
  const room = await createRoomWithQuestions(page.request, [], 'Matrix Rating', trackRoom, 'E2E Matrix Rating');
  const api = apiClient(page.request);
  const questionId = await createMatrixQuestion(api, room.setId, overrides);
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const tokens = await joinParticipants(page.request, room.code, 3);
  const csrf = await csrfToken(page.request);
  const headers = csrf ? { 'X-CSRFToken': csrf } : undefined;
  const add = async (token: string, zone: string, title: string, category: string) => {
    const response = await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/add/`, {
      data: { token, question: questionId, zone, title, category, description: '' },
      headers,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).card_id as number;
  };
  const ids = {
    chatbot: await add(tokens[0], 'q1', 'Chatbot', 'blue'),
    feedback: await add(tokens[1], 'q1', 'Feedback-Tool', 'blue'),
    altlast: await add(tokens[1], 'q3', 'Altlast', 'orange'),
    podcast: await add(tokens[0], 'q2', 'Podcast', 'orange'),
    member: await add(tokens[2], 'q4', 'Mitglied', 'blue'),
  };
  // A stack (Podcast on top) to show the lock in the moderation view.
  await api.post(`/api/runs/${runId}/matrix/${questionId}/stack`, { card: ids.member, onto: ids.podcast });
  const rate = async (token: string, cardId: number, body: { delta?: number; value?: number }) => {
    const response = await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/rate/`, {
      data: { token, question: questionId, card: cardId, ...body },
      headers,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const serverCard = async (id: number): Promise<Card> => {
    const body = await api.get(`/api/question-sets/${room.setId}/results/`);
    const run = body.results.find((r: { run: number }) => r.run === runId);
    const q = run.questions.find((x: { id: number }) => x.id === questionId);
    return q.matrix.cards.find((c: Card) => c.id === id);
  };
  return { room, api, questionId, runId, tokens, ids, rate, serverCard };
}

const board = (page: Page) => page.locator('[data-matrix-board]');
const card = (page: Page, id: number) => board(page).locator(`[data-card-id="${id}"]`);
const footer = (page: Page) => page.locator('footer');
const seg = (page: Page, id: string) => footer(page).locator(`[data-help="${id}"]`);
const raters = (page: Page) => page.locator('[title="Teilnehmende, die bewertet haben"]');

async function openPresenter(page: Page, setId: number) {
  await page.goto(`/sets/${setId}/present?resume=continue`);
  await expect(board(page)).toBeVisible();
}

/** Width of a card's score bar(s) relative to its track. */
async function barShare(page: Page, id: number, which = '[data-score-bar]') {
  return card(page, id).evaluate((el, sel) => {
    const track = el.querySelector('[data-score-track]') as HTMLElement;
    const bar = el.querySelector(sel) as HTMLElement | null;
    return bar ? bar.getBoundingClientRect().width / track.getBoundingClientRect().width : 0;
  }, which);
}

/** WCAG contrast of an element's text against the card body (sRGB via canvas). */
async function textContrast(page: Page, id: number, sel: string) {
  return card(page, id).evaluate((el, s) => {
    const toRgb = (css: string) => {
      const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d')!;
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const body = el.querySelector('[data-card-body]') as HTMLElement;
    const bg = lum(toRgb(getComputedStyle(body).backgroundColor));
    return Array.from(el.querySelectorAll<HTMLElement>(s)).map((t) => {
      const fg = lum(toRgb(getComputedStyle(t).color));
      const [hi, lo] = [fg, bg].sort((a, b) => b - a);
      return (hi + 0.05) / (lo + 0.05);
    });
  }, sel);
}

async function expectNoOverlap(page: Page) {
  await page.waitForTimeout(400);
  const boxes = await Promise.all(
    (await board(page).locator('[data-card-id]').all()).map(async (l) => (await l.boundingBox())!),
  );
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const hit = a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
      expect(hit, JSON.stringify({ a, b })).toBe(false);
    }
}

async function expectNoAxe(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }))).toEqual([]);
}

test('points, live: start via footer, bars + texts, ranking, stack lock, help, back to collecting', async ({ page, trackRoom }) => {
  test.setTimeout(150_000);
  const s = await seed(page, trackRoom, {
    matrix_rating_mode: 'points', matrix_rating_budget: 5, matrix_rating_multi: true, matrix_rating_live: true,
  });
  const { ids } = s;
  await openPresenter(page, s.room.setId);

  // Open and collecting: no "Bewertung starten" yet (like the mind map).
  const start = page.getByTestId('mx-start-rating');
  await expect(start).toHaveCount(0);
  // Stop (collecting) goes to the results; the board stays, and starting
  // the rating is the suggested next step.
  await page.keyboard.press('s');
  await expect(seg(page, 'view.question')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(board(page)).toBeVisible();
  await expect(start).toBeVisible();
  await expect(start).toHaveAccessibleName('Bewertung starten');
  await expect(start).toHaveAttribute('data-next-step', 'true');
  await expect(start).toHaveAttribute('title', /Punkte auf die Karten/);
  await expect(seg(page, 'view.mx.ranking')).toHaveCount(0);
  const toggle = page.locator('[data-help="toggle"]');
  await expect(toggle.getByTestId('toggle-rating-icon')).toHaveCount(0);
  const stage = page.waitForResponse((r) => r.request().method() === 'POST' && /\/matrix\/\d+\/stage$/.test(r.url()));
  await start.click();
  expect((await stage).ok()).toBeTruthy();
  // Rating stage: Start/Stop shows the thumbs icon and names the rating.
  await expect(toggle.getByTestId('toggle-rating-icon')).toBeVisible();
  await expect(toggle).toHaveAccessibleName(/^Bewertung (starten|stoppen)$/);
  const back = page.getByTestId('mx-back-to-collecting');
  await expect(back).toBeVisible();
  await expect(back).toHaveAccessibleName('Zurück zum Sammeln');
  await expect(start).toHaveCount(0);
  await expect(page.getByTestId('mx-rating-banner')).toContainText('5 Punkte pro Person');
  // Live display on, nothing rated yet: no bars.
  await expect(board(page).locator('[data-card-score]')).toHaveCount(0);

  // Ratings arrive live: bars relative to the best card + text.
  await s.rate(s.tokens[0], ids.chatbot, { delta: 1 });
  await s.rate(s.tokens[0], ids.chatbot, { delta: 1 });
  await s.rate(s.tokens[1], ids.chatbot, { delta: 1 });
  await s.rate(s.tokens[1], ids.feedback, { delta: 1 });
  await expect(raters(page)).toHaveText('2');
  await expect(card(page, ids.chatbot).locator('[data-score-text]')).toHaveText('3 Punkte');
  await expect(card(page, ids.feedback).locator('[data-score-text]')).toHaveText('1 Punkt');
  await expect(card(page, ids.altlast).locator('[data-card-score]')).toHaveCount(0);
  await expect(card(page, ids.podcast).locator('[data-card-score]')).toHaveCount(0);
  await expect.poll(() => barShare(page, ids.chatbot)).toBeCloseTo(1, 2);
  await expect.poll(() => barShare(page, ids.feedback)).toBeCloseTo(1 / 3, 1);
  // The bar takes the category colour (Idee = blue).
  const barColour = await card(page, ids.chatbot).locator('[data-score-bar]').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(barColour).toBe('rgb(0, 114, 178)');
  for (const c of await textContrast(page, ids.chatbot, '[data-score-text]')) expect(c).toBeGreaterThanOrEqual(4.5);
  // The accessible name carries the score.
  await expect(card(page, ids.chatbot)).toHaveAccessibleName(/Chatbot.*3 Punkte/);
  await expectNoOverlap(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/beamer-points-live.png` });

  // Ranking view: sorted by points, with rank, category, title, field, score.
  await expect(seg(page, 'view.mx.ranking')).toBeVisible();
  await seg(page, 'view.mx.ranking').click();
  const ranking = page.getByTestId('matrix-ranking');
  await expect(ranking).toBeVisible();
  const rows = ranking.locator('[data-ranking-row]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('1');
  await expect(rows.nth(0)).toContainText('Chatbot');
  await expect(rows.nth(0)).toContainText('Idee');
  await expect(rows.nth(0)).toContainText('nützlich & modern');
  await expect(rows.nth(0)).toContainText('3 Punkte');
  await expect(rows.nth(1)).toContainText('Feedback-Tool');
  await expect(rows.nth(1)).toContainText('1 Punkt');
  const titleSize = await rows.nth(0).locator('[data-ranking-title]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(titleSize).toBeGreaterThanOrEqual(20);
  await expectNoAxe(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/beamer-ranking-points.png` });
  // A goes back to the board (look only, vote stays open).
  await page.keyboard.press('a');
  await expect(seg(page, 'view.mx.raw')).toHaveAttribute('aria-checked', 'true');
  await expect(board(page)).toBeVisible();

  // Stacking is locked: a drop onto a card only moves it.
  const target = await card(page, ids.altlast).boundingBox();
  const from = await card(page, ids.feedback).boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2 + 6, from!.y + from!.height / 2 + 6, { steps: 2 });
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 10 });
  await expect(card(page, ids.altlast)).not.toHaveAttribute('data-stack-target', 'true');
  const moved = page.waitForResponse((r) => r.request().method() === 'POST' && /\/matrix\/\d+\/(move|stack)$/.test(r.url()));
  await page.mouse.up();
  expect((await moved).url()).toMatch(/\/move$/);
  expect((await s.serverCard(ids.feedback)).stack).toBeNull();

  // Moderation view: hint, stack actions disabled.
  await page.locator('[data-help="handle.mx-edit"]').click();
  const drawer = page.getByTestId('matrix-drawer');
  await drawer.getByRole('tab', { name: 'Moderieren' }).click();
  await expect(drawer.getByTestId('matrix-stacks-locked')).toHaveText('Stapeln und Löschen sind während der Bewertung gesperrt.');
  await expect(drawer.getByRole('button', { name: /Mitglied herauslösen/ })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: /Stapel Podcast auflösen/ })).toBeDisabled();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/beamer-moderation-locked.png` });
  await drawer.getByRole('button', { name: 'Schließen' }).click();
  // Card dialog: no unstack while rating (hiding stays possible).
  await card(page, ids.podcast).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('matrix-stacks-locked')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Mitglied herauslösen/ })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Ausblenden', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // "?" labels the new controls.
  await page.keyboard.press('?');
  const helpFor = await page.getByTestId('help-card').evaluateAll((els) =>
    els.flatMap((e) => (e.getAttribute('data-help-for') ?? '').split(' ')),
  );
  expect(helpFor).toEqual(expect.arrayContaining(['mx.collect', 'view.mx.ranking']));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('presenter-help')).toHaveCount(0);
  await expectNoAxe(page);

  // Back to collecting (vote open again): scores off the board; the start
  // button only returns once collecting is stopped.
  await back.click();
  await expect(back).toHaveCount(0);
  await expect(page.getByTestId('mx-start-rating')).toHaveCount(0);
  await expect(board(page).locator('[data-card-score]')).toHaveCount(0);
  await expect(seg(page, 'view.mx.ranking')).toHaveCount(0);

  // A server refusal (409, e.g. the rating started meanwhile) shows as a
  // German toast.
  await page.route(/\/matrix\/\d+\/unstack$/, (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'Stacks are locked while rating.' }) }),
  );
  await page.locator('[data-help="handle.mx-edit"]').click();
  await drawer.getByRole('tab', { name: 'Moderieren' }).click();
  await drawer.getByRole('button', { name: /Mitglied herauslösen/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stapel sind während der Bewertung gesperrt.' })).toBeVisible();
});

test('plus/minus, hidden: raters only, Stop closes, E reveals bars and ranking', async ({ page, trackRoom }) => {
  test.setTimeout(150_000);
  const s = await seed(page, trackRoom, {
    matrix_rating_mode: 'updown', matrix_rating_budget: 3, matrix_rating_live: false,
  });
  const { ids } = s;
  await s.api.post(`/api/runs/${s.runId}/matrix/${s.questionId}/stage`, { stage: 'rate', open: true });
  await s.rate(s.tokens[0], ids.chatbot, { value: 1 });
  await s.rate(s.tokens[1], ids.chatbot, { value: 1 });
  await s.rate(s.tokens[2], ids.chatbot, { value: -1 });
  await s.rate(s.tokens[0], ids.altlast, { value: -1 });
  await s.rate(s.tokens[1], ids.feedback, { value: 1 });
  await openPresenter(page, s.room.setId);

  // Hidden: only the number of raters, no bars, no ranking.
  await expect(raters(page)).toHaveText('3');
  await expect(page.getByTestId('mx-rating-banner')).toContainText('Ergebnisse folgen zum Schluss');
  await expect(board(page).locator('[data-card-score]')).toHaveCount(0);
  await expect(seg(page, 'view.mx.ranking')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/beamer-updown-hidden.png` });

  // Stop only closes (the board stays, scores still hidden).
  await page.keyboard.press('s');
  await expect(page.getByTestId('mx-rating-closed')).toBeVisible();
  await expect(board(page)).toBeVisible();
  // The rating has its own "closed" line: no generic "voting closed" below.
  await expect(page.getByText('Beantwortung geschlossen', { exact: true })).toHaveCount(0);
  await expect(board(page).locator('[data-card-score]')).toHaveCount(0);
  await page.keyboard.press('a');
  await page.waitForTimeout(1000);
  await expect(seg(page, 'view.mx.ranking')).toHaveCount(0);

  // E reveals: two-coloured bars with "+a / −b".
  await page.keyboard.press('e');
  await expect(card(page, ids.chatbot).locator('[data-score-text]')).toHaveText('+2 / −1');
  await expect(card(page, ids.altlast).locator('[data-score-text]')).toHaveText('+0 / −1');
  await expect(card(page, ids.feedback).locator('[data-score-text]')).toHaveText('+1 / −0');
  await expect(card(page, ids.podcast).locator('[data-card-score]')).toHaveCount(0);
  // Shares of the most-rated card (3 ratings).
  await expect.poll(() => barShare(page, ids.chatbot, '[data-score-up]')).toBeCloseTo(2 / 3, 1);
  await expect.poll(() => barShare(page, ids.chatbot, '[data-score-down]')).toBeCloseTo(1 / 3, 1);
  await expect.poll(() => barShare(page, ids.altlast, '[data-score-down]')).toBeCloseTo(1 / 3, 1);
  expect(await card(page, ids.altlast).locator('[data-score-up]').count()).toBe(0);
  for (const c of await textContrast(page, ids.chatbot, '[data-score-text] span')) expect(c).toBeGreaterThanOrEqual(4.5);
  await expectNoOverlap(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/beamer-updown-revealed.png` });

  await seg(page, 'view.mx.ranking').click();
  const rows = page.getByTestId('matrix-ranking').locator('[data-ranking-row]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Chatbot');
  await expect(rows.nth(1)).toContainText('Feedback-Tool');
  await expect(rows.nth(2)).toContainText('Altlast');
  await expect(rows.nth(2)).toContainText('Risiko');
  await expect(rows.nth(2)).toContainText('nicht nützlich & altbacken');
  await expectNoAxe(page);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/beamer-ranking-updown.png` });
});
