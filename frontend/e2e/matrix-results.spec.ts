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

/** Seed a rated matrix: stack (Feedback-Tool on Chatbot), a hidden card, and
 *  ratings. `points`: Chatbot 4, Altlast 2, Podcast 1; `updown`: Chatbot +3/−0,
 *  Altlast +1/−2, Podcast +1/−0. `finish` false leaves the run in the rating
 *  stage (scores secret unless `live`). */
async function seedRated(
  page: Page,
  trackRoom: (id: number) => void,
  mode: 'points' | 'updown',
  opts: { finish?: boolean; live?: boolean } = {},
) {
  const finish = opts.finish ?? true;
  const room = await createRoomWithQuestions(page.request, [], 'Matrix Bewertung', trackRoom, 'E2E Matrix Rating');
  const api = apiClient(page.request);
  const questionId = await createMatrixQuestion(api, room.setId, {
    matrix_rating_mode: mode, matrix_rating_budget: 5, matrix_rating_multi: true, matrix_rating_live: opts.live ?? false,
  });
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const tokens = await joinParticipants(page.request, room.code, 3);
  const csrf = (await page.request.storageState()).cookies.find((c) => c.name === 'abstimmbar_csrftoken')?.value ?? '';
  const headers = { 'X-CSRFToken': csrf };
  const post = async (path: string, data: object) => {
    const response = await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/${path}/`, { data, headers });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const add = async (token: string, zone: string, title: string, category: string) =>
    (await post('add', { token, question: questionId, zone, title, category, description: '' })).card_id as number;
  const chatbot = await add(tokens[0], 'q1', 'Chatbot', 'blue');
  const feedback = await add(tokens[1], 'q1', 'Feedback-Tool', 'blue');
  const altlast = await add(tokens[1], 'q3', 'Altlast', 'orange');
  const podcast = await add(tokens[0], 'q2', 'Podcast', 'orange');
  const secret = await add(tokens[2], 'q4', 'Versteckte Idee', 'orange');
  await api.post(`/api/runs/${runId}/matrix/${questionId}/stack`, { card: feedback, onto: chatbot });
  await api.post(`/api/runs/${runId}/matrix/${questionId}/hide`, { card: secret, hidden: true });
  await api.post(`/api/runs/${runId}/matrix/${questionId}/stage`, { stage: 'rate' });
  const rate = (token: string, card: number, body: object) => post('rate', { token, question: questionId, card, ...body });
  if (mode === 'points') {
    for (const [token, card, n] of [[0, chatbot, 3], [1, chatbot, 1], [1, altlast, 2], [2, podcast, 1]] as const)
      for (let i = 0; i < n; i++) await rate(tokens[token], card, { delta: 1 });
  } else {
    for (const [token, card, value] of [
      [0, chatbot, 1], [1, chatbot, 1], [2, chatbot, 1],
      [0, altlast, 1], [1, altlast, -1], [2, altlast, -1],
      [0, podcast, 1],
    ] as const) await rate(tokens[token], card, { value });
  }
  if (finish) await control(api, runId, 'finished');
  return { room, chatbot, altlast, podcast, secret, api };
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

test('results: axis labels without arrows, four distinct tints (q1 green, q3 rose)', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  await login(page);
  const { room } = await seed(page, trackRoom);
  await page.goto(`/sets/${room.setId}/results`);
  await expect(page.locator('[data-matrix-board]')).toBeVisible();
  for (const name of ['y_to', 'y_from', 'x_to', 'x_from']) {
    expect((await page.locator(`[data-axis="${name}"] [data-axis-label]`).textContent()) ?? '').not.toMatch(/[↑↓←→]/);
  }
  const t = await page.locator('[data-matrix-board] [data-tint]').evaluateAll((els) =>
    Object.fromEntries(els.map((el) => [el.getAttribute('data-tint')!, getComputedStyle(el).backgroundColor])),
  );
  expect(new Set(Object.values(t)).size).toBe(4);
});

/** Ink colour of an element against the nearest opaque background behind it. */
async function inkContrast(loc: ReturnType<Page['locator']>) {
  return loc.evaluate((el) => {
    const toRgb = (css: string) => {
      const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d')!;
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    let bg = [255, 255, 255];
    for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
      const c = toRgb(getComputedStyle(n).backgroundColor);
      if (c[3] === 255) { bg = c.slice(0, 3); break; }
    }
    const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]: number[]) => 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    const [hi, lo] = [lum(toRgb(getComputedStyle(el).color)), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });
}

async function noAxe(page: Page, label: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(
    violations.map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.any[0]?.message ?? ''}`) })),
    label,
  ).toEqual([]);
}

const SHOTS = process.env.MATRIX_RESULTS_SHOTS ?? '';

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`matrix rating results (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('points: bars on cards, ranking order, score text, raters', async ({ page, trackRoom }) => {
      test.setTimeout(120_000);
      await login(page);
      const { room, chatbot, altlast, podcast, secret } = await seedRated(page, trackRoom, 'points');
      await page.goto(`/sets/${room.setId}/results`);
      const board = page.locator('[data-matrix-board]');
      await expect(board).toBeVisible();

      // Bars on the rated visible top cards only (not on the hidden card).
      for (const id of [chatbot, altlast, podcast]) await expect(board.locator(`[data-card-id="${id}"] [data-card-score]`)).toHaveCount(1);
      await expect(board.locator(`[data-card-id="${secret}"] [data-card-score]`)).toHaveCount(0);
      await expect(board.locator(`[data-card-id="${chatbot}"] [data-score-text]`)).toHaveText('4 Punkte');
      const share = (id: number) =>
        board.locator(`[data-card-id="${id}"]`).evaluate((el) => {
          const track = el.querySelector('[data-score-track]') as HTMLElement;
          const bar = el.querySelector('[data-score-bar]') as HTMLElement;
          return bar.getBoundingClientRect().width / track.getBoundingClientRect().width;
        });
      expect(await share(chatbot)).toBeGreaterThan(0.95);
      expect(await share(altlast)).toBeGreaterThan(0.4);
      expect(await share(altlast)).toBeLessThan(0.6);

      // Ranking list below, best first.
      const ranking = page.getByTestId('matrix-ranking');
      await expect(ranking).toBeVisible();
      await expect(page.getByText('Punkte · bewertet von 3')).toBeVisible();
      const rows = ranking.locator('[data-ranking-row]');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText('Chatbot');
      await expect(rows.nth(0)).toContainText('4 Punkte');
      await expect(rows.nth(1)).toContainText('Altlast');
      await expect(rows.nth(1)).toContainText('2 Punkte');
      await expect(rows.nth(2)).toContainText('Podcast');
      await expect(ranking.getByText('Versteckte Idee')).toHaveCount(0);
      // Contrast of the score text on the card (dark variant needed).
      expect(await inkContrast(board.locator(`[data-card-id="${chatbot}"] [data-score-text]`))).toBeGreaterThanOrEqual(4.5);
      expect(await inkContrast(rows.nth(0).locator('span.tabular-nums').last())).toBeGreaterThanOrEqual(4.5);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/results-points-${scheme}.png`, fullPage: true });
      await noAxe(page, `axe matrix rating results points (${scheme})`);
    });

    test('updown: plus/minus bars, balance ranking, contrast', async ({ page, trackRoom }) => {
      test.setTimeout(120_000);
      await login(page);
      const { room, chatbot, altlast } = await seedRated(page, trackRoom, 'updown');
      await page.goto(`/sets/${room.setId}/results`);
      const board = page.locator('[data-matrix-board]');
      await expect(board).toBeVisible();
      await expect(board.locator(`[data-card-id="${chatbot}"] [data-score-up]`)).toHaveCount(1);
      await expect(board.locator(`[data-card-id="${altlast}"] [data-score-down]`)).toHaveCount(1);
      await expect(board.locator(`[data-card-id="${altlast}"] [data-score-text]`)).toHaveText('+1 / −2');
      await expect(page.getByText('Plus/Minus · bewertet von 3')).toBeVisible();
      const ranking = page.getByTestId('matrix-ranking');
      const rows = ranking.locator('[data-ranking-row]');
      await expect(rows.nth(0)).toContainText('Chatbot');
      await expect(rows.nth(0)).toContainText('+3');
      await expect(rows.nth(2)).toContainText('Altlast');
      await expect(rows.nth(2)).toContainText('−1');
      for (const span of await board.locator(`[data-card-id="${altlast}"] [data-score-text] > span`).all())
        expect(await inkContrast(span)).toBeGreaterThanOrEqual(4.5);
      for (const span of await rows.nth(2).locator('[aria-hidden] > span').all())
        expect(await inkContrast(span)).toBeGreaterThanOrEqual(4.5);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/results-updown-${scheme}.png`, fullPage: true });
      await noAxe(page, `axe matrix rating results updown (${scheme})`);
    });
  });
}

test('hidden scores while rating is in progress: no bars, no ranking, a note', async ({ page, trackRoom }) => {
  test.setTimeout(120_000);
  await login(page);
  const { room, chatbot } = await seedRated(page, trackRoom, 'points', { finish: false, live: false });
  await page.goto(`/sets/${room.setId}/results`);
  await expect(page.locator('[data-matrix-board]')).toBeVisible();
  await expect(page.getByTestId('mx-rating-in-progress')).toContainText('Bewertung läuft noch');
  await expect(page.getByTestId('matrix-ranking')).toHaveCount(0);
  await expect(page.locator(`[data-card-id="${chatbot}"] [data-card-score]`)).toHaveCount(0);
  await expect(page.getByText('Punkte · bewertet von 3')).toBeVisible();
});

test('a matrix without rating mode shows no ranking section', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  await login(page);
  const { room } = await seed(page, trackRoom);
  await page.goto(`/sets/${room.setId}/results`);
  await expect(page.locator('[data-matrix-board]')).toBeVisible();
  await expect(page.getByTestId('matrix-ranking')).toHaveCount(0);
  await expect(page.getByTestId('mx-rating-in-progress')).toHaveCount(0);
});
