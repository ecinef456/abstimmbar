/** Beamer progress pill (bottom left, replaces the vote ring): connected
 *  participants, participants who have answered and — for item-based kinds —
 *  items against the capacity (participants × per-person limit), with a
 *  tinted fill + bar whose share is exposed as `data-share`. Choice question,
 *  multi-term word cloud, matrix collecting → rating (points), axe.
 *
 *  Connected participants are real SSE streams opened from Node (the hub
 *  counts connections); answers go through the public API. Runs as `demo`;
 *  seeds its own "E2E Progress" rooms and deletes them.
 *  PROGRESS_SHOTS=<dir> saves screenshots of the pill. */
import http from 'node:http';
import path from 'node:path';
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
  type Kind,
} from './helpers/seed';

const SHOTS = process.env.PROGRESS_SHOTS ?? '';

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

/** `n` participant SSE connections (closed by the returned function). */
function connect(code: string, n: number): () => void {
  const requests: http.ClientRequest[] = [];
  for (let i = 0; i < n; i++) {
    const req = http.get(`${API_BASE_URL}/api/live/rooms/${code}/stream/`, (res) => res.resume());
    req.on('error', () => undefined);
    requests.push(req);
  }
  return () => requests.forEach((r) => r.destroy());
}

const pill = (page: Page) => page.getByTestId('live-stats');
/** The number of a segment (its sr-only label is asserted separately). */
const seg = (page: Page, title: string) =>
  pill(page).locator(`[title="${title}"]`).locator('.tabular-nums');
const CONNECTED = 'Verbundene Teilnehmende';
const ANSWERED = 'Teilnehmende, die geantwortet haben';
const RATED = 'Teilnehmende, die bewertet haben';

async function share(page: Page) {
  return Number(await pill(page).getAttribute('data-share'));
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(700);
  const box = (await pill(page).boundingBox())!;
  await page.screenshot({
    path: path.join(SHOTS, `${name}.png`),
    clip: { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 },
  });
}

async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .include('[data-testid="live-stats"]')
    .analyze();
  expect(results.violations.map((v) => ({ rule: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);
}

async function seedSet(page: Page, trackRoom: (id: number) => void, kinds: Kind[], label: string) {
  const room = await createRoomWithQuestions(page.request, kinds, label, trackRoom, 'E2E Progress');
  const api = apiClient(page.request);
  const csrf = await csrfToken(page.request);
  const headers = csrf ? { 'X-CSRFToken': csrf } : undefined;
  const post = async (url: string, data: Record<string, unknown>) => {
    const r = await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/${url}`, { data, headers });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  return { room, api, post };
}

test('choice question: two numbers, fill share = answered / connected', async ({ page, trackRoom }) => {
  const { room, api, post } = await seedSet(page, trackRoom, ['single_choice'], 'Choice');
  const q = room.questions[0];
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', q.id);
  const close = connect(room.code, 4);
  try {
    await page.goto(`/sets/${room.setId}/present?resume=continue`);
    await expect(seg(page, CONNECTED)).toHaveText('4');
    await expect(seg(page, ANSWERED)).toHaveText('0');
    // No items segment for one answer per person.
    await expect(pill(page).locator('[data-progress-items]')).toHaveCount(0);
    await expect.poll(() => share(page)).toBe(0);

    const tokens = await joinParticipants(page.request, room.code, 3);
    await post('vote/', { token: tokens[0], question: q.id, options: [q.options[0]] });
    await expect(seg(page, ANSWERED)).toHaveText('1');
    await expect.poll(() => share(page)).toBe(0.25);
    await shot(page, 'pill-25');
    await post('vote/', { token: tokens[1], question: q.id, options: [q.options[1]] });
    await post('vote/', { token: tokens[2], question: q.id, options: [q.options[1]] });
    await expect(seg(page, ANSWERED)).toHaveText('3');
    await expect.poll(() => share(page)).toBe(0.75);
    await shot(page, 'pill-75');
    // Screen readers get a labelled group with a text label per number.
    await expect(pill(page)).toHaveAccessibleName('Beteiligung');
    await expect(pill(page).locator('.sr-only')).toHaveText([CONNECTED, ANSWERED]);
    await expectNoAxeViolations(page);
  } finally {
    close();
  }
});

test('word cloud with several terms: items against participants × max', async ({ page, trackRoom }) => {
  const { room, api, post } = await seedSet(page, trackRoom, [], 'Word cloud');
  const q = await api.post('/api/questions/', {
    question_set: room.setId,
    kind: 'word_cloud',
    text: { de: '<p>Begriffe?</p>', en: '' },
    allow_multiple: true,
    wordcloud_max_answers: 3,
  });
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', q.id);
  const close = connect(room.code, 2);
  try {
    await page.goto(`/sets/${room.setId}/present?resume=continue`);
    await expect(seg(page, CONNECTED)).toHaveText('2');
    const items = seg(page, 'Erstellte Begriffe von insgesamt möglichen');
    await expect(items).toHaveText('0 / 6');
    const tokens = await joinParticipants(page.request, room.code, 2);
    for (const text of ['Tablet', 'Laptop', 'Beamer']) await post('vote/', { token: tokens[0], question: q.id, text });
    await post('vote/', { token: tokens[1], question: q.id, text: 'Tafel' });
    await expect(seg(page, ANSWERED)).toHaveText('2');
    await expect(items).toHaveText('4 / 6');
    await expect.poll(() => share(page)).toBe(0.67);
    await post('vote/', { token: tokens[1], question: q.id, text: 'Kreide' });
    await post('vote/', { token: tokens[1], question: q.id, text: 'Schwamm' });
    await expect(items).toHaveText('6 / 6');
    await expect.poll(() => share(page)).toBe(1);
    await shot(page, 'pill-100');
    await expectNoAxeViolations(page);
  } finally {
    close();
  }
});

test('matrix: cards against capacity, then points against the budget while rating', async ({ page, trackRoom }) => {
  const { room, api, post } = await seedSet(page, trackRoom, [], 'Matrix');
  const questionId = await createMatrixQuestion(api, room.setId, {
    matrix_max_per_person: 2,
    matrix_rating_mode: 'points',
    matrix_rating_budget: 5,
    matrix_rating_multi: true,
  });
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const close = connect(room.code, 3);
  try {
    await page.goto(`/sets/${room.setId}/present?resume=continue`);
    await expect(page.locator('[data-matrix-board]')).toBeVisible();
    await expect(seg(page, CONNECTED)).toHaveText('3');
    const cards = seg(page, 'Erstellte Karten von insgesamt möglichen');
    await expect(cards).toHaveText('0 / 6');
    const tokens = await joinParticipants(page.request, room.code, 3);
    const add = async (token: string, title: string) =>
      (await post('matrix/add/', { token, question: questionId, zone: 'q1', title, category: 'blue', description: '' }))
        .card_id as number;
    const chatbot = await add(tokens[0], 'Chatbot');
    await add(tokens[0], 'Podcast');
    await add(tokens[1], 'Wiki');
    await expect(seg(page, ANSWERED)).toHaveText('2');
    await expect(cards).toHaveText('3 / 6');
    await expect.poll(() => share(page)).toBe(0.5);

    await api.post(`/api/runs/${runId}/matrix/${questionId}/stage`, { stage: 'rate', open: true });
    const points = seg(page, 'Vergebene Punkte von insgesamt möglichen');
    await expect(points).toHaveText('0 / 15');
    await expect(cards).toHaveCount(0);
    await expect(seg(page, ANSWERED)).toHaveCount(0);
    await expect(seg(page, RATED)).toHaveText('0');
    for (let i = 0; i < 3; i++) await post('matrix/rate/', { token: tokens[2], question: questionId, card: chatbot, delta: 1 });
    await expect(seg(page, RATED)).toHaveText('1');
    await expect(points).toHaveText('3 / 15');
    await expect.poll(() => share(page)).toBe(0.2);
    await expectNoAxeViolations(page);
  } finally {
    close();
  }
});
