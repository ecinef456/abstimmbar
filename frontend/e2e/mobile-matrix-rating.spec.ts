/** Four-field matrix, rating stage on the participant page (phone, 324×756):
 *  list grouped by field, +/− points or thumbs, budget line, reload, closed.
 *  The file name starts with `mobile-` so only the phone projects pick it up.
 *  Seeds its own "E2E Matrix" room via the API and deletes it. */
import AxeBuilder from '@axe-core/playwright';
import type { Page, APIRequestContext } from '@playwright/test';
import { test, expect, API_BASE_URL, deleteRooms } from './fixtures';
import { AUTH, apiClient, control, createMatrixQuestion, createRoomWithQuestions, joinParticipants, startRun } from './helpers/seed';
import { expectNoHorizontalOverflow } from './helpers/layout';

const SHOTS = process.env.MATRIX_RATING_SHOTS ?? '';

async function seed(page: Page, demoApi: APIRequestContext, created: number[], overrides: Record<string, unknown>) {
  const room = await createRoomWithQuestions(demoApi, [], 'Matrix', (id) => created.push(id), 'E2E Matrix');
  const api = apiClient(demoApi);
  const questionId = await createMatrixQuestion(api, room.setId, { matrix_max_per_person: 3, ...overrides });
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const tokens = await joinParticipants(demoApi, room.code, 2);
  const csrf = (await demoApi.storageState()).cookies.find((c) => c.name === 'abstimmbar_csrftoken')?.value ?? '';
  const add = async (token: string, zone: string, title: string, category: string, description = '') => {
    const response = await demoApi.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/add/`, {
      data: { token, question: questionId, zone, title, category, description },
      headers: { 'X-CSRFToken': csrf },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()).card_id as number;
  };
  const a = await add(tokens[0], 'q1', 'Chatbot für die Lehre', 'blue', 'Beantwortet Fragen rund um die Uhr');
  const b = await add(tokens[0], 'q1', 'Stapelmitglied', 'blue');
  await add(tokens[0], 'q2', 'Feedback-Tool', 'orange');
  const d = await add(tokens[1], 'q3', 'Verstecktes', 'orange');
  await add(tokens[1], 'e_right', 'Randfall', 'blue', 'Liegt zwischen zwei Feldern');
  await api.post(`/api/runs/${runId}/matrix/${questionId}/stack`, { card: b, onto: a });
  await api.post(`/api/runs/${runId}/matrix/${questionId}/hide`, { card: d, hidden: true });
  // The page's own participant adds one card of its own.
  await page.goto(`${API_BASE_URL}/p/${room.code}/`);
  await expect(page.locator('#matrix')).toBeVisible();
  const own = await page.evaluate((k) => localStorage.getItem(k), `abstimmbar_token_${room.code}`);
  await add(own!, 'q4', 'Meine Idee', 'orange');
  await api.post(`/api/runs/${runId}/matrix/${questionId}/stage`, { stage: 'rate' });
  await page.reload(); // own cards are fetched once per page load
  return { room, api, questionId, runId, tokens, csrf, a };
}

const row = (page: Page, title: string) => page.locator('#mx-rate-list li', { hasText: title });

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`matrix rating participant (${scheme})`, () => {
    test.use({ colorScheme: scheme, storageState: { cookies: [], origins: [] } });

    test('points: grouped list, +/− updates, budget, reload, closed', async ({ page, playwright }) => {
      test.setTimeout(120_000);
      const demoApi = await playwright.request.newContext({ storageState: AUTH.demo });
      const created: number[] = [];
      try {
        const { api, runId, questionId } = await seed(page, demoApi, created, {
          matrix_rating_mode: 'points', matrix_rating_budget: 3, matrix_rating_multi: true,
        });
        const view = page.locator('#matrix');
        const list = page.locator('#mx-rate-list');
        await expect(list).toBeVisible();
        // The card form and own-card list are replaced.
        await expect(page.locator('#mx-form')).toBeHidden();
        await expect(page.locator('#mx-mine')).toBeHidden();
        await expect(view.getByText('Wohin gehört die Idee?')).toBeVisible();
        // Only visible tops, grouped by field in zone order.
        await expect(list.locator('li')).toHaveCount(4);
        await expect(list.getByText('Stapelmitglied')).toHaveCount(0);
        await expect(list.getByText('Verstecktes')).toHaveCount(0);
        const heads = await list.locator('h3').allTextContents();
        expect(heads).toEqual([
          'nützlich & modern',
          'nicht nützlich & modern',
          'nützlich & altbacken',
          'zwischen nützlich & modern und nützlich & altbacken',
        ]);
        // Each field group is a tinted block with a decorative icon.
        const tints = scheme === 'light'
          ? { q1: 'rgb(235, 246, 238)', q2: 'rgb(252, 245, 222)', q4: 'rgb(237, 240, 245)' }
          : { q1: 'rgba(52, 211, 153, 0.09)', q2: 'rgba(252, 211, 77, 0.08)', q4: 'rgba(148, 163, 184, 0.1)' };
        for (const [zone, colour] of Object.entries(tints)) {
          const block = list.locator(`.mx-rgroup[data-zone="${zone}"]`);
          await expect(block).toHaveCSS('background-color', colour);
          await expect(block.locator('h3 svg.mx-zico')).toHaveAttribute('aria-hidden', 'true');
        }
        const edge = list.locator('.mx-rgroup[data-zone="e_right"]');
        await expect(edge).toHaveCSS('background-image', /linear-gradient/);
        await expect(edge.locator('h3 svg.mx-zico')).toHaveAttribute('aria-hidden', 'true');
        await expect(edge.locator('h3 svg.mx-zico line')).toHaveCount(1);
        await expect(row(page, 'Meine Idee')).toContainText('Ihre Karte');
        await expect(row(page, 'Chatbot')).not.toContainText('Ihre Karte');
        await expect(row(page, 'Chatbot')).toContainText('Beantwortet Fragen');
        const status = page.locator('#mx-rate-status');
        await expect(status).toHaveAttribute('aria-live', 'polite');
        await expect(status).toHaveText('Noch 3 Punkte');

        const plus = (t: string) => row(page, t).getByRole('button', { name: /Punkt vergeben/ });
        const minus = (t: string) => row(page, t).getByRole('button', { name: /Punkt zurücknehmen/ });
        await expect(minus('Chatbot')).toBeDisabled();
        await plus('Chatbot').click();
        await expect(status).toHaveText('Noch 2 Punkte');
        await expect(row(page, 'Chatbot').locator('.mx-rval [aria-hidden]')).toHaveText('1');
        await plus('Chatbot').click();
        await expect(row(page, 'Chatbot').locator('.mx-rval [aria-hidden]')).toHaveText('2');
        await plus('Feedback-Tool').click();
        await expect(status).toHaveText('Keine Punkte mehr übrig');
        await expect(plus('Randfall')).toBeDisabled();
        await expect(plus('Chatbot')).toBeDisabled();
        await minus('Chatbot').click();
        await expect(status).toHaveText('Noch 1 Punkt');
        await expect(plus('Randfall')).toBeEnabled();

        // Touch targets and layout.
        for (const b of await list.locator('button').all()) {
          const box = (await b.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(43.5);
          expect(box.height).toBeGreaterThanOrEqual(43.5);
        }
        await expectNoHorizontalOverflow(page, `matrix rating (${scheme})`);
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
        expect(violations.map((v) => ({ rule: v.id, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')) }))).toEqual([]);
        if (SHOTS) {
          await page.screenshot({ path: `${SHOTS}/participant-points-${scheme}.png`, fullPage: true });
        }

        // The server agrees and reload restores the view.
        await page.reload();
        await expect(list.locator('li')).toHaveCount(4);
        await expect(status).toHaveText('Noch 1 Punkt');
        await expect(row(page, 'Chatbot').locator('.mx-rval [aria-hidden]')).toHaveText('1');
        await expect(row(page, 'Feedback-Tool').locator('.mx-rval [aria-hidden]')).toHaveText('1');

        // Closed: read-only (no buttons), own values stay visible.
        await control(api, runId, 'closed', questionId);
        await expect(page.locator('#mx-status')).toContainText(/geschlossen/);
        await expect(list.locator('button')).toHaveCount(0);
        await expect(row(page, 'Chatbot')).toContainText('1');
        await expectNoHorizontalOverflow(page, `matrix rating closed (${scheme})`);
      } finally {
        await page.close();
        await deleteRooms(demoApi, created);
        await demoApi.dispose();
      }
    });

    test('points without several per card: second point is blocked', async ({ page, playwright }) => {
      const demoApi = await playwright.request.newContext({ storageState: AUTH.demo });
      const created: number[] = [];
      try {
        await seed(page, demoApi, created, {
          matrix_rating_mode: 'points', matrix_rating_budget: 3, matrix_rating_multi: false,
        });
        await row(page, 'Chatbot').getByRole('button', { name: /Punkt vergeben/ }).click();
        await expect(row(page, 'Chatbot').getByRole('button', { name: /Punkt vergeben/ })).toBeDisabled();
        await expect(page.locator('#mx-rate-status')).toHaveText('Noch 2 Punkte');
      } finally {
        await page.close();
        await deleteRooms(demoApi, created);
        await demoApi.dispose();
      }
    });

    test('live scores show next to the cards', async ({ page, playwright }) => {
      const demoApi = await playwright.request.newContext({ storageState: AUTH.demo });
      const created: number[] = [];
      try {
        const { room, questionId, tokens, csrf, a } = await seed(page, demoApi, created, {
          matrix_rating_mode: 'points', matrix_rating_budget: 3, matrix_rating_live: true,
        });
        const r = await demoApi.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/rate/`, {
          data: { token: tokens[1], question: questionId, card: a, delta: 1 },
          headers: { 'X-CSRFToken': csrf },
        });
        expect(r.ok(), await r.text()).toBeTruthy();
        await expect(row(page, 'Chatbot').locator('.mx-rtotal')).toHaveText(/^Σ 1/);
        await expect(row(page, 'Chatbot').locator('.mx-rtotal .mx-sr')).toHaveText('Insgesamt 1');
        await expect(row(page, 'Feedback-Tool').locator('.mx-rtotal')).toBeHidden();
        await expect(row(page, 'Chatbot').locator('.mx-rval .mx-sr')).toHaveText('Ihre Punkte: 0');
        await expectNoHorizontalOverflow(page, `matrix rating scores (${scheme})`);
        if (SHOTS) {
          await page.screenshot({ path: `${SHOTS}/participant-scores-${scheme}.png`, fullPage: true });
        }
      } finally {
        await page.close();
        await deleteRooms(demoApi, created);
        await demoApi.dispose();
      }
    });

    test('live scores: taps survive other participants rating; error note is one live region', async ({ page, playwright }) => {
      test.setTimeout(90_000);
      const demoApi = await playwright.request.newContext({ storageState: AUTH.demo });
      const created: number[] = [];
      try {
        const { room, questionId, tokens, csrf, a } = await seed(page, demoApi, created, {
          matrix_rating_mode: 'points', matrix_rating_budget: 3, matrix_rating_live: true,
        });
        const plus = row(page, 'Chatbot').getByRole('button', { name: /Punkt vergeben/ });
        await expect(plus).toBeVisible();
        // Let the initial own-card / own-rating fetches settle (they rebuild once).
        await expect(row(page, 'Meine Idee')).toContainText('Ihre Karte');
        await expect(page.locator('#mx-rate-status')).toHaveText('Noch 3 Punkte');
        await page.waitForTimeout(500);
        await plus.evaluate((el) => { (el as HTMLElement).dataset.mark = 'same'; el.focus(); });
        const total = row(page, 'Chatbot').locator('.mx-rtotal');
        for (let i = 1; i <= 2; i++) {
          const r = await demoApi.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/rate/`, {
            data: { token: tokens[1], question: questionId, card: a, delta: 1 },
            headers: { 'X-CSRFToken': csrf },
          });
          expect(r.ok(), await r.text()).toBeTruthy();
          await expect(total).toHaveText(new RegExp(`^Σ ${i}`));
          // The pressed control is still the very same node, still focused.
          await expect(plus).toHaveAttribute('data-mark', 'same');
          expect(await plus.evaluate((el) => el === document.activeElement)).toBe(true);
        }
        await plus.click();
        await expect(row(page, 'Chatbot').locator('.mx-rval [aria-hidden]')).toHaveText('1');
        await expect(total).toHaveText(/^Σ 3/);
        // The error note is a persistent live region, not recreated per rebuild.
        expect(await page.locator('#mx-rate-note').getAttribute('aria-live')).toBe('polite');
        expect(await page.locator('#mx-rate-list [role=alert]').count()).toBe(0);
      } finally {
        await page.close();
        await deleteRooms(demoApi, created);
        await demoApi.dispose();
      }
    });

    test('plus/minus: thumbs toggle, budget, taking back', async ({ page, playwright }) => {
      test.setTimeout(90_000);
      const demoApi = await playwright.request.newContext({ storageState: AUTH.demo });
      const created: number[] = [];
      try {
        await seed(page, demoApi, created, { matrix_rating_mode: 'updown', matrix_rating_budget: 2 });
        const status = page.locator('#mx-rate-status');
        await expect(status).toHaveText('Noch 2 Bewertungen');
        const up = (t: string) => row(page, t).getByRole('button', { name: /^Gefällt mir —/ });
        const down = (t: string) => row(page, t).getByRole('button', { name: /^Gefällt mir nicht —/ });
        await up('Chatbot').click();
        await expect(up('Chatbot')).toHaveAttribute('aria-pressed', 'true');
        await expect(down('Chatbot')).toHaveAttribute('aria-pressed', 'false');
        await expect(status).toHaveText('Noch 1 Bewertung');
        await down('Feedback-Tool').click();
        await expect(status).toHaveText('Keine Bewertungen mehr übrig');
        await expect(up('Randfall')).toBeDisabled();
        await expect(down('Randfall')).toBeDisabled();
        // Switching an already rated card is still possible.
        await down('Chatbot').click();
        await expect(down('Chatbot')).toHaveAttribute('aria-pressed', 'true');
        await expect(up('Chatbot')).toHaveAttribute('aria-pressed', 'false');
        // Pressing the active one removes the rating.
        await down('Chatbot').click();
        await expect(down('Chatbot')).toHaveAttribute('aria-pressed', 'false');
        await expect(status).toHaveText('Noch 1 Bewertung');
        await up('Randfall').click();
        await expect(up('Randfall')).toHaveAttribute('aria-pressed', 'true');
        await page.reload();
        await expect(down('Feedback-Tool')).toHaveAttribute('aria-pressed', 'true');
        await expect(up('Randfall')).toHaveAttribute('aria-pressed', 'true');
        await expect(status).toHaveText('Keine Bewertungen mehr übrig');
        await expectNoHorizontalOverflow(page, 'matrix rating updown');
        if (SHOTS) {
          await page.screenshot({ path: `${SHOTS}/participant-updown-${scheme}.png`, fullPage: true });
        }
      } finally {
        await page.close();
        await deleteRooms(demoApi, created);
        await demoApi.dispose();
      }
    });
  });
}
