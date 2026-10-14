/** Four-field matrix on the participant page (phone, 324×756): zone picker,
 *  category chips, card form, own cards. The file name starts with `mobile-`
 *  so only the phone projects pick it up. Seeds its own "E2E Matrix" room
 *  via the API and deletes it. */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL, deleteRooms } from './fixtures';
import { AUTH, apiClient, control, createMatrixQuestion, createRoomWithQuestions, startRun } from './helpers/seed';
import { expectNoHorizontalOverflow } from './helpers/layout';

const ZONE = {
  q1: 'nützlich & modern',
  q2: 'nützlich & altbacken',
  q3: 'nutzlos & altbacken',
  q4: 'nutzlos & modern',
  e_top: 'zwischen nützlich & altbacken und nützlich & modern',
  e_right: 'zwischen nützlich & modern und nutzlos & modern',
  e_bottom: 'zwischen nutzlos & altbacken und nutzlos & modern',
  e_left: 'zwischen nützlich & altbacken und nutzlos & altbacken',
} as const;

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ).then(() => undefined),
  );
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`matrix participant (${scheme})`, () => {
    test.use({ colorScheme: scheme, storageState: { cookies: [], origins: [] } });

    test('zone picker, card form, own cards, closing', async ({ page, playwright }) => {
      test.setTimeout(90_000);
      const demoApi = await playwright.request.newContext({ storageState: AUTH.demo });
      const created: number[] = [];
      try {
        const room = await createRoomWithQuestions(demoApi, [], 'Matrix', (id) => created.push(id), 'E2E Matrix');
        const api = apiClient(demoApi);
        const questionId = await createMatrixQuestion(api, room.setId);
        const runId = await startRun(api, room.setId);
        await control(api, runId, 'open', questionId);

        await page.goto(`${API_BASE_URL}/p/${room.code}/`);
        const view = page.locator('#matrix');
        await expect(view).toBeVisible();
        await expect(view.getByText('Wohin gehört die Idee?')).toBeVisible();

        // Zone picker: 4 quadrants + 4 edges, each with a written-out name.
        const zones = view.locator('#mx-zones button');
        await expect(zones).toHaveCount(8);
        for (const name of Object.values(ZONE)) {
          await expect(view.getByRole('button', { name, exact: true })).toBeVisible();
        }
        // Axis ends sit outside the board.
        for (const end of ['altbacken', 'modern', 'nutzlos', 'nützlich']) {
          await expect(view.locator('.mx-axis', { hasText: end }).first()).toBeVisible();
        }
        // Touch targets.
        for (const button of await zones.all()) {
          const box = await button.boundingBox();
          expect(box!.width).toBeGreaterThanOrEqual(43.5);
          expect(box!.height).toBeGreaterThanOrEqual(43.5);
        }

        const add = view.getByRole('button', { name: 'Karte hinzufügen' });
        const title = view.getByRole('textbox', { name: 'Titel' });
        const description = view.getByRole('textbox', { name: /Beschreibung/ });
        await expect(add).toBeDisabled();

        // Disabled until zone + category + title are all set.
        await title.fill('Erste Idee');
        await expect(add).toBeDisabled();
        const q1 = view.getByRole('button', { name: ZONE.q1, exact: true });
        await q1.click();
        await expect(q1).toHaveAttribute('aria-pressed', 'true');
        await expect(add).toBeDisabled();
        const idea = view.getByRole('radio', { name: /Idee/ });
        const risk = view.getByRole('radio', { name: /Risiko/ });
        await expect(idea).toHaveAttribute('aria-checked', 'false');
        await idea.click();
        await expect(idea).toHaveAttribute('aria-checked', 'true');
        await expect(add).toBeEnabled();

        await expectNoHorizontalOverflow(page, `matrix form (${scheme})`);
        await settle(page);
        const { violations } = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        expect(
          violations.map((v) => ({
            rule: v.id,
            nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.any[0]?.message ?? ''}`),
          })),
          `axe on matrix form (${scheme})`,
        ).toEqual([]);

        // Card 1 in q1, with a description. Zone and category stay selected.
        await description.fill('Eine längere Beschreibung der ersten Idee');
        await add.click();
        const cards = view.locator('#mx-mine li');
        await expect(cards).toHaveCount(1);
        await expect(view.getByRole('heading', { name: /Ihre Karten \(1 von 2\)/ })).toBeVisible();
        await expect(title).toHaveValue('');
        await expect(description).toHaveValue('');
        await expect(q1).toHaveAttribute('aria-pressed', 'true');
        await expect(idea).toHaveAttribute('aria-checked', 'true');
        await expect(add).toBeDisabled(); // title is empty again

        // Card 2 on the top edge with the other category → at the limit.
        const top = view.getByRole('button', { name: ZONE.e_top, exact: true });
        await top.click();
        await expect(top).toHaveAttribute('aria-pressed', 'true');
        await expect(q1).toHaveAttribute('aria-pressed', 'false'); // exactly one zone
        await risk.click();
        await title.fill('Zweite Idee');
        await add.click();
        await expect(cards).toHaveCount(2);
        await expect(view.getByRole('heading', { name: /Ihre Karten \(2 von 2\)/ })).toBeVisible();
        await expect(add).toBeDisabled();
        await expect(title).toBeDisabled();
        await expect(view.locator('#mx-limit')).toBeVisible();
        await expect(cards.first()).toContainText('Erste Idee');
        await expect(cards.first()).toContainText(ZONE.q1);
        await expect(cards.nth(1)).toContainText(ZONE.e_top);
        await expectNoHorizontalOverflow(page, `matrix at the limit (${scheme})`);

        // The server holds both cards, in the chosen zones.
        const tokenKey = `abstimmbar_token_${room.code}`;
        const token = await page.evaluate((k) => localStorage.getItem(k), tokenKey);
        const mine = async () =>
          (
            await (
              await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/matrix/mine/`, {
                data: { token, question: questionId },
              })
            ).json()
          ).mine as { title: string; zone: string; category: string }[];
        expect((await mine()).map((c) => [c.title, c.zone, c.category]).sort()).toEqual([
          ['Erste Idee', 'q1', 'blue'],
          ['Zweite Idee', 'e_top', 'orange'],
        ]);

        // Delete one → form is usable again.
        await view.getByRole('button', { name: 'Karte „Erste Idee“ löschen' }).click();
        await expect(cards).toHaveCount(1);
        await expect(view.getByRole('heading', { name: /Ihre Karten \(1 von 2\)/ })).toBeVisible();
        await expect(title).toBeEnabled();
        await expect(view.locator('#mx-limit')).toBeHidden();
        expect(await mine()).toHaveLength(1);

        // Reload restores my own card.
        await page.reload();
        await expect(page.locator('#matrix')).toBeVisible();
        await expect(page.locator('#mx-mine li')).toHaveCount(1);
        await expect(page.locator('#mx-mine li')).toContainText('Zweite Idee');

        // Closing: form disabled, the card stays (no delete).
        await control(api, runId, 'closed', questionId);
        await expect(page.locator('#mx-status')).toContainText(/geschlossen/);
        await expect(page.getByRole('button', { name: 'Karte hinzufügen' })).toBeDisabled();
        await expect(page.locator('#mx-zones button').first()).toBeDisabled();
        await expect(page.locator('#mx-mine li')).toHaveCount(1);
        await expect(page.locator('#mx-mine li button')).toHaveCount(0);
        await expectNoHorizontalOverflow(page, `matrix closed (${scheme})`);
      } finally {
        await page.close();
        await deleteRooms(demoApi, created);
        await demoApi.dispose();
      }
    });

    test('colour categories and no edges', async ({ page, playwright }) => {
      const demoApi = await playwright.request.newContext({ storageState: AUTH.demo });
      const created: number[] = [];
      try {
        const room = await createRoomWithQuestions(demoApi, [], 'Matrix', (id) => created.push(id), 'E2E Matrix');
        const api = apiClient(demoApi);
        const questionId = await createMatrixQuestion(api, room.setId, {
          matrix_edges: false,
          matrix_descriptions: false,
          matrix_category_mode: 'colors',
          matrix_categories: [
            { key: 'blue', name: { de: '', en: '' } },
            { key: 'orange', name: { de: '', en: '' } },
            { key: 'green', name: { de: '', en: '' } },
          ],
        });
        const runId = await startRun(api, room.setId);
        await control(api, runId, 'open', questionId);
        await page.goto(`${API_BASE_URL}/p/${room.code}/`);
        const view = page.locator('#matrix');
        await expect(view.locator('#mx-zones button')).toHaveCount(4);
        await expect(view.getByRole('radio')).toHaveCount(3);
        await expect(view.getByRole('radio', { name: 'Farbe 2' })).toBeVisible();
        await expect(view.getByRole('textbox', { name: /Beschreibung/ })).toHaveCount(0);
        await view.getByRole('button', { name: ZONE.q4, exact: true }).click();
        await view.getByRole('radio', { name: 'Farbe 3' }).click();
        await view.getByRole('textbox', { name: 'Titel' }).fill('Grün unten rechts');
        await view.getByRole('button', { name: 'Karte hinzufügen' }).click();
        await expect(view.locator('#mx-mine li')).toHaveCount(1);
        await expectNoHorizontalOverflow(page, 'matrix colours, no edges');
      } finally {
        await page.close();
        await deleteRooms(demoApi, created);
        await demoApi.dispose();
      }
    });
  });
}
