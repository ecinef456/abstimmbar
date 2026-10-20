/** Four-field matrix results board on the phone (324×756): no horizontal
 *  overflow, cards compact (titles only), the "×n" badge inside its card,
 *  the grouped list below as the readable alternative; light, dark, axe.
 *  The file name starts with `mobile-` so only the phone projects pick it up.
 *  Seeds its own "E2E Matrix" room via the API and deletes it. */
import AxeBuilder from '@axe-core/playwright';
import { test, expect, API_BASE_URL, deleteRooms } from './fixtures';
import { AUTH, apiClient, control, createMatrixQuestion, createRoomWithQuestions, joinParticipants, startRun } from './helpers/seed';
import { expectNoHorizontalOverflow } from './helpers/layout';

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`matrix results phone (${scheme})`, () => {
    test.use({ colorScheme: scheme, storageState: AUTH.demo });

    test('board without overflow, compact cards, badge inside, list below', async ({ page, playwright }) => {
      test.setTimeout(90_000);
      const demoApi = await playwright.request.newContext({ storageState: AUTH.demo });
      const created: number[] = [];
      try {
        const room = await createRoomWithQuestions(demoApi, [], 'Matrix', (id) => created.push(id), 'E2E Matrix');
        const api = apiClient(demoApi);
        const questionId = await createMatrixQuestion(api, room.setId);
        const runId = await startRun(api, room.setId);
        await control(api, runId, 'open', questionId);
        const tokens = await joinParticipants(demoApi, room.code, 4);
        const csrf = (await demoApi.storageState()).cookies.find((c) => c.name === 'abstimmbar_csrftoken')?.value ?? '';
        const add = async (n: number, zone: string, title: string, category: string, description = '') => {
          const response = await demoApi.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/add/`, {
            data: { token: tokens[Math.floor(n / 2)], question: questionId, zone, title, category, description },
            headers: { 'X-CSRFToken': csrf },
          });
          expect(response.ok(), await response.text()).toBeTruthy();
          return (await response.json()).card_id as number;
        };
        const long = 'Donaudampfschifffahrtsgesellschaftskapitän';
        const a = await add(0, 'q1', 'Chatbot für die Lehre', 'blue', 'Beantwortet Fragen rund um die Uhr');
        const b = await add(1, 'q1', long, 'blue', 'Eine sehr lange Beschreibung, die auf dem Telefon nicht angezeigt werden soll');
        const c = await add(2, 'q1', 'Feedback-Tool', 'orange');
        await add(3, 'q2', 'Idee mit etwas längerem Titel', 'orange');
        await add(4, 'q3', 'Altlast', 'orange', 'Beschreibung');
        await add(5, 'e_right', 'Randfall', 'blue');
        await api.post(`/api/runs/${runId}/matrix/${questionId}/stack`, { card: b, onto: a });
        await api.post(`/api/runs/${runId}/matrix/${questionId}/stack`, { card: c, onto: a });
        await control(api, runId, 'finished');

        await page.goto(`/sets/${room.setId}/results`);
        const board = page.locator('[data-matrix-board]');
        await expect(board).toBeVisible();
        await expect(board.locator('[data-card-id]')).toHaveCount(4);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.waitForTimeout(600); // position transition

        await expectNoHorizontalOverflow(page, `matrix results (${scheme})`);

        // Compact: no card shows its description on the phone board.
        await expect(board.getByText('Beantwortet Fragen rund um die Uhr')).toHaveCount(0);
        await expect(board.getByText('Eine sehr lange Beschreibung')).toHaveCount(0);

        // Compact type size on the phone (the beamer sizing does not apply).
        const titleSize = await board
          .locator(`[data-card-id="${a}"] [data-card-title]`)
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect(titleSize).toBeLessThanOrEqual(12);

        // The badge stays inside its card.
        const cardBox = (await board.locator(`[data-card-id="${a}"]`).boundingBox())!;
        const badgeBox = (await board.locator(`[data-card-id="${a}"]`).getByTestId('matrix-stack-badge').boundingBox())!;
        expect(badgeBox.x).toBeGreaterThanOrEqual(cardBox.x - 0.5);
        expect(badgeBox.y).toBeGreaterThanOrEqual(cardBox.y - 0.5);
        expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
        expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);

        // The list below carries the details.
        const list = page.getByTestId('matrix-list');
        await expect(list.locator(`[data-card-id="${a}"]`)).toContainText('Beantwortet Fragen rund um die Uhr');
        // Reading order like the zone pickers: q2, q1, q3, q4, then the edges.
        await expect(list.locator('h4')).toHaveText([
          'nicht nützlich & modern', 'nützlich & modern', 'nicht nützlich & altbacken',
          'zwischen nützlich & modern und nützlich & altbacken',
        ]);

        const { violations } = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        expect(
          violations.map((v) => ({
            rule: v.id,
            nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.any[0]?.message ?? ''}`),
          })),
          `axe on matrix results phone (${scheme})`,
        ).toEqual([]);
      } finally {
        await deleteRooms(demoApi, created);
        await demoApi.dispose();
      }
    });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`matrix rating results phone (${scheme})`, () => {
    test.use({ colorScheme: scheme, storageState: AUTH.demo });

    for (const mode of ['points', 'updown'] as const) {
      test(`${mode}: bars and ranking without overflow, readable, axe`, async ({ page, playwright }) => {
        test.setTimeout(90_000);
        const demoApi = await playwright.request.newContext({ storageState: AUTH.demo });
        const created: number[] = [];
        try {
          const room = await createRoomWithQuestions(demoApi, [], 'Matrix', (id) => created.push(id), 'E2E Matrix Rating');
          const api = apiClient(demoApi);
          const questionId = await createMatrixQuestion(api, room.setId, {
            matrix_rating_mode: mode, matrix_rating_budget: 5, matrix_rating_multi: true,
          });
          const runId = await startRun(api, room.setId);
          await control(api, runId, 'open', questionId);
          const tokens = await joinParticipants(demoApi, room.code, 3);
          const csrf = (await demoApi.storageState()).cookies.find((c) => c.name === 'abstimmbar_csrftoken')?.value ?? '';
          const post = async (path: string, data: object) => {
            const response = await demoApi.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/${path}/`, {
              data, headers: { 'X-CSRFToken': csrf },
            });
            expect(response.ok(), await response.text()).toBeTruthy();
            return response.json();
          };
          const long = 'Donaudampfschifffahrtsgesellschaftskapitän';
          const a = (await post('add', { token: tokens[0], question: questionId, zone: 'q1', title: 'Chatbot für die Lehre', category: 'blue', description: '' })).card_id;
          const b = (await post('add', { token: tokens[1], question: questionId, zone: 'q3', title: long, category: 'orange', description: '' })).card_id;
          await api.post(`/api/runs/${runId}/matrix/${questionId}/stage`, { stage: 'rate' });
          for (const [token, card] of [[0, a], [1, a], [2, b]] as const)
            await post('rate', mode === 'points'
              ? { token: tokens[token], question: questionId, card, delta: 1 }
              : { token: tokens[token], question: questionId, card, value: card === a ? 1 : -1 });
          await control(api, runId, 'finished');

          await page.goto(`/sets/${room.setId}/results`);
          const board = page.locator('[data-matrix-board]');
          await expect(board).toBeVisible();
          await expect(board.locator(`[data-card-id="${a}"] [data-card-score]`)).toHaveCount(1);
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.waitForTimeout(600);
          await expect(page.getByTestId('matrix-ranking').locator('[data-ranking-row]')).toHaveCount(2);
          await expectNoHorizontalOverflow(page, `matrix rating results ${mode} (${scheme})`);
          // The score row stays inside its card.
          const cardBox = (await board.locator(`[data-card-id="${a}"]`).boundingBox())!;
          const scoreBox = (await board.locator(`[data-card-id="${a}"] [data-card-score]`).boundingBox())!;
          expect(scoreBox.x).toBeGreaterThanOrEqual(cardBox.x - 0.5);
          expect(scoreBox.x + scoreBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
          if (process.env.MATRIX_RESULTS_SHOTS)
            await page.screenshot({ path: `${process.env.MATRIX_RESULTS_SHOTS}/results-${mode}-phone-${scheme}.png`, fullPage: true });
          const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          expect(
            violations.map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.any[0]?.message ?? ''}`) })),
            `axe on matrix rating results phone (${mode}, ${scheme})`,
          ).toEqual([]);
        } finally {
          await deleteRooms(demoApi, created);
          await demoApi.dispose();
        }
      });
    }
  });
}
