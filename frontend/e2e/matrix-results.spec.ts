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

async function seed(page: Page, trackRoom: (id: number) => void) {
  const room = await createRoomWithQuestions(page.request, [], 'Matrix Ergebnisse', trackRoom, 'E2E Matrix');
  const api = apiClient(page.request);
  const questionId = await createMatrixQuestion(api, room.setId);
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const [t1, t2, t3] = await joinParticipants(page.request, room.code, 3);
  const add = async (token: string, zone: string, title: string, category: string, description = '') => {
    const response = await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/add/`, {
      data: { token, question: questionId, zone, title, category, description },
      headers: { 'X-CSRFToken': (await page.request.storageState()).cookies.find((c) => c.name === 'abstimmbar_csrftoken')?.value ?? '' },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).card_id as number;
  };
  const chatbot = await add(t1, 'q1', 'Chatbot', 'blue', 'Beantwortet Fragen');
  const feedback = await add(t2, 'q1', 'Feedback-Tool', 'blue');
  const altlast = await add(t3, 'q3', 'Altlast', 'orange');
  const secret = await add(t1, 'q2', 'Versteckte Idee', 'orange');
  const url = (action: string) => `/api/runs/${runId}/matrix/${questionId}/${action}`;
  await api.post(url('stack'), { card: feedback, onto: chatbot });
  await api.post(url('hide'), { card: secret, hidden: true });
  await control(api, runId, 'finished');
  return { room, chatbot, altlast, secret };
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
        await expect(board.locator('[data-axis]', { hasText: end }).first()).toBeVisible();
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
      const legend = board.getByTestId('matrix-legend');
      await expect(legend.getByRole('button', { name: 'Idee' })).toBeVisible();
      await expect(legend.getByRole('button', { name: 'Risiko' })).toBeVisible();
      await legend.getByRole('button', { name: 'Risiko' }).click();
      await expect(board.locator(`[data-card-id="${altlast}"]`)).toHaveCount(0);
      await legend.getByRole('button', { name: 'Risiko' }).click();
      await expect(board.locator(`[data-card-id="${altlast}"]`)).toHaveCount(1);

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
