/** Four-field matrix in the management results view: the read-only board
 *  (axis labels, card positions, stack badge, hidden marker, legend) and the
 *  list grouped by field, in light and dark. Seeds its own "E2E Matrix" room
 *  through the API (participant cards, presenter stack/hide) and deletes it. */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL } from './fixtures';
import {
  apiClient,
  control,
  createMatrixQuestion,
  createRoomWithQuestions,
  joinParticipants,
  startRun,
} from './helpers/seed';

test.use({ locale: 'de-DE', viewport: { width: 1280, height: 1000 } });

/** WCAG contrast ratio of two computed "rgb(...)" colours. */
function contrast(a: string, b: string) {
  const lum = (css: string) => {
    const [r, g, bl] = (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

async function login(page: Page) {
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
}

async function seed(page: Page, trackRoom: (id: number) => void, opts: { tokens?: number; finish?: boolean } = {}) {
  const room = await createRoomWithQuestions(page.request, [], 'Matrix Ergebnisse', trackRoom, 'E2E Matrix');
  const api = apiClient(page.request);
  const questionId = await createMatrixQuestion(api, room.setId);
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const tokens = await joinParticipants(page.request, room.code, opts.tokens ?? 3);
  const [t1, t2, t3] = tokens;
  const add = async (token: string, zone: string, title: string, category: string, description = '') => {
    const response = await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/add/`, {
      data: { token, question: questionId, zone, title, category, description },
      headers: { 'X-CSRFToken': (await page.request.storageState()).cookies.find((c) => c.name === 'abstimmbar_csrftoken')?.value ?? '' },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).card_id as number;
  };
  const url = (action: string) => `/api/runs/${runId}/matrix/${questionId}/${action}`;
  if (opts.finish === false) return { room, add, api, url, tokens, runId };
  const chatbot = await add(t1, 'q1', 'Chatbot', 'blue', 'Beantwortet Fragen');
  const feedback = await add(t2, 'q1', 'Feedback-Tool', 'blue');
  const altlast = await add(t3, 'q3', 'Altlast', 'orange');
  const secret = await add(t1, 'q2', 'Versteckte Idee', 'orange');
  await api.post(url('stack'), { card: feedback, onto: chatbot });
  await api.post(url('hide'), { card: secret, hidden: true });
  await control(api, runId, 'finished');
  return { room, chatbot, altlast, secret, add, api, url, tokens, runId };
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`matrix results (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('board, stack, hidden card, legend and zone list', async ({ page, trackRoom }) => {
      test.setTimeout(90_000);
      await login(page);
      const { room, chatbot, altlast, secret } = await seed(page, trackRoom);
      await page.goto(`/sets/${room.setId}/results`);

      const board = page.locator('[data-matrix-board]');
      await expect(board).toBeVisible();
      for (const end of ['nicht nützlich', 'nützlich', 'altbacken', 'modern']) {
        await expect(page.locator('[data-axis]', { hasText: end }).first()).toBeVisible();
      }

      // Quadrants: compare card centres with the board centre.
      const boardBox = (await board.boundingBox())!;
      const cx = boardBox.x + boardBox.width / 2;
      const cy = boardBox.y + boardBox.height / 2;
      const center = async (id: number) => {
        const b = (await board.locator(`[data-card-id="${id}"]`).boundingBox())!;
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      };
      const top = await center(chatbot);
      expect(top.x).toBeGreaterThan(cx);
      expect(top.y).toBeLessThan(cy);
      const low = await center(altlast);
      expect(low.x).toBeLessThan(cx);
      expect(low.y).toBeGreaterThan(cy);

      // Stack: one card with a ×2 badge; its member is not drawn separately.
      await expect(board.locator(`[data-card-id="${chatbot}"]`).getByTestId('matrix-stack-badge')).toHaveText('×2');
      await expect(board.locator('[data-card-id]')).toHaveCount(3);

      // Hidden card: shown with the marker in the results view.
      const hidden = board.locator(`[data-card-id="${secret}"]`);
      await expect(hidden.getByTestId('matrix-hidden-marker')).toHaveText('ausgeblendet');

      // Legend with both categories; toggling hides a category's cards.
      const legend = page.getByTestId('matrix-legend');
      // App size here (the beamer uses presentation size).
      expect(await legend.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(14);
      await expect(legend.getByRole('button', { name: 'Idee' })).toBeVisible();
      await expect(legend.getByRole('button', { name: 'Risiko' })).toBeVisible();
      await legend.getByRole('button', { name: 'Risiko' }).click();
      await expect(board.locator(`[data-card-id="${altlast}"]`)).toHaveCount(0);
      await legend.getByRole('button', { name: 'Risiko' }).click();
      await expect(board.locator(`[data-card-id="${altlast}"]`)).toHaveCount(1);

      // Card colouring: full-colour tab, tinted body, readable text.
      const colours = await board.locator(`[data-card-id="${altlast}"]`).evaluate((el) => {
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
          body: toRgb(getComputedStyle(body).backgroundColor),
          text: toRgb(getComputedStyle(title).color),
        };
      });
      expect(colours.tab).toBe('rgb(230, 159, 0)'); // Risiko = orange
      expect(colours.body).not.toBe(scheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(30, 41, 59)');
      expect(contrast(colours.text, colours.body)).toBeGreaterThanOrEqual(4.5);
      // The x ends run vertically, outside the plot.
      for (const name of ['x_from', 'x_to']) {
        const mode = await page
          .locator(`[data-axis="${name}"] [data-axis-text]`)
          .evaluate((el) => getComputedStyle(el).writingMode);
        expect(mode).toBe('vertical-rl');
      }

      // Counts are not 0 (4 participant cards).
      await expect(page.getByText(/^4 Stimmen/)).toBeVisible();

      // List grouped by field, x part first.
      const list = page.getByTestId('matrix-list');
      await expect(list.getByRole('heading', { name: 'nützlich & modern', exact: true })).toBeVisible();
      await expect(list.getByRole('heading', { name: 'nicht nützlich & altbacken', exact: true })).toBeVisible();
      await expect(list.getByRole('heading', { name: 'nicht nützlich & modern', exact: true })).toBeVisible();
      await expect(list.locator(`[data-card-id="${chatbot}"]`)).toContainText('Beantwortet Fragen');
      await expect(list.getByText('gestapelt auf „Chatbot“')).toBeVisible();
      await expect(list.locator(`[data-card-id="${secret}"]`)).toContainText('(ausgeblendet)');

      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(
        violations.map((v) => ({
          rule: v.id,
          nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.any[0]?.message ?? ''}`),
        })),
        `axe on matrix results (${scheme})`,
      ).toEqual([]);
    });
  });
}

test('legend toggle never promotes the members of a hidden top', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  await login(page);
  const { room, add, api, url, tokens } = await seed(page, trackRoom, { finish: false });
  const top = await add(tokens[0], 'q4', 'Geheimer Stapel', 'orange');
  const member = await add(tokens[1], 'q4', 'Mitglied im Stapel', 'blue');
  await api.post(url('stack'), { card: member, onto: top });
  await api.post(url('hide'), { card: top, hidden: true });
  await page.goto(`/sets/${room.setId}/results`);
  const board = page.locator('[data-matrix-board]');
  await expect(board.locator(`[data-card-id="${top}"]`)).toHaveCount(1);
  await expect(board.locator(`[data-card-id="${member}"]`)).toHaveCount(0);
  const legend = page.getByTestId('matrix-legend');
  await legend.getByRole('button', { name: 'Risiko' }).click();
  // The hidden top is filtered out by its category; its member must not appear.
  await expect(board.locator(`[data-card-id="${top}"]`)).toHaveCount(0);
  await expect(board.locator(`[data-card-id="${member}"]`)).toHaveCount(0);
  await expect(board.getByText('Mitglied im Stapel')).toHaveCount(0);
});

test('axis labels and legend never overlap cards (extreme auto-place slots)', async ({ page, trackRoom }) => {
  test.setTimeout(120_000);
  await login(page);
  const { room, add, api, runId, tokens } = await seed(page, trackRoom, { tokens: 22, finish: false });
  // Fill the extreme slots: edges (6 on top/bottom, 3 left/right) and the
  // outermost quadrant rows.
  const plan: [string, number][] = [['e_top', 6], ['e_bottom', 6], ['e_left', 3], ['e_right', 3], ['q1', 6], ['q2', 6], ['q3', 6], ['q4', 6]];
  const used = new Map<string, number>();
  let n = 0;
  for (const [zone, count] of plan) {
    for (let i = 0; i < count; i++) {
      // max 2 cards per person: walk through the tokens.
      const token = tokens[Math.floor(n / 2) % tokens.length];
      const key = token;
      if ((used.get(key) ?? 0) >= 2) throw new Error('out of tokens');
      used.set(key, (used.get(key) ?? 0) + 1);
      await add(token, zone, `X${n} Karte mit längerem Titel`, n % 2 ? 'blue' : 'orange', 'Beschreibung');
      n++;
    }
  }
  await control(api, runId, 'finished');
  await page.goto(`/sets/${room.setId}/results`);
  const board = page.locator('[data-matrix-board]');
  await expect(board).toBeVisible();
  await expect(board.locator('[data-card-id]')).toHaveCount(n);
  await page.waitForTimeout(600); // let the position transition settle
  const rects = async (loc: ReturnType<Page['locator']>) =>
    Promise.all((await loc.all()).map(async (l) => (await l.boundingBox())!));
  const cards = await rects(board.locator('[data-card-id]'));
  const outside = [
    ...(await rects(page.locator('[data-axis]'))),
    ...(await rects(page.getByTestId('matrix-legend'))),
  ];
  expect(outside.length).toBe(5);
  const hit = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  for (const o of outside) for (const c of cards) expect(hit(o, c), JSON.stringify({ o, c })).toBe(false);
});
