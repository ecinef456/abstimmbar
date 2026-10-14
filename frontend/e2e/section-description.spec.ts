/** Section description: authored in the set outline (Sections mode, rich
 *  text, saved on blur) and shown under the section title on the presenter's
 *  interstitial slide.
 *
 *  Runs as `demo` (logs in per test); seeds its own "E2E …" room and
 *  deletes it. No AI calls. SECTION_SHOTS=<dir> saves screenshots. */
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL } from './fixtures';
import { apiClient, createRoomWithQuestions } from './helpers/seed';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  // Pro mode (sections are a Pro feature) and no auto-starting tour,
  // regardless of what the demo user has stored.
  await page.route(/\/api\/whoami\/(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    if (json.username) {
      json.onboarding_tour_seen = true;
      json.easy_mode = false;
    }
    await route.fulfill({ response, json });
  });
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
});

async function shot(page: Page, name: string) {
  const dir = process.env.SECTION_SHOTS;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`), animations: 'disabled' });
}

test('edit a section description; the presenter interstitial shows it', async ({ page, trackRoom }) => {
  const seed = await createRoomWithQuestions(
    page.request, ['single_choice', 'single_choice'], 'Section', trackRoom, 'E2E Section',
  );
  const api = apiClient(page.request);
  const section = await api.post('/api/sections/', {
    question_set: seed.setId,
    title: { de: 'Teil A: Grundlagen', en: 'Part A: Basics' },
  });
  // Put the section header above the first question.
  await api.post(`/api/question-sets/${seed.setId}/reorder-outline/`, {
    items: [
      { type: 'section', id: section.id },
      ...seed.questions.map((q) => ({ type: 'question', id: q.id })),
    ],
  });

  await page.goto(`/sets/${seed.setId}`);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.getByRole('button', { name: '+ Add description' }).click();
  const field = page.getByTestId(`section-description-${section.id}`);
  await expect(field.getByText('Optional – shown on the interstitial slide below the title.')).toBeVisible();
  const editor = field.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type('Heute geht es um die Grundbegriffe.');

  const saved = page.waitForResponse(
    (r) => r.url().includes(`/api/sections/${section.id}/`) && r.request().method() === 'PATCH',
  );
  // Leaving the field saves it.
  await page.getByRole('heading', { level: 1 }).first().click();
  expect((await saved).ok()).toBeTruthy();
  await shot(page, 'editor-field');

  const stored = await api.get(`/api/sections/${section.id}/`);
  // English UI → the English tab is active; German stays empty.
  expect(stored.description.en).toContain('Heute geht es um die Grundbegriffe.');
  expect(stored.description.de).toBe('');

  // Presenter: entering the section shows title + description.
  await page.goto(`/sets/${seed.setId}/present`);
  await expect(page.locator('[data-tour="present.join"]')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  const slide = page.getByTestId('section-interstitial');
  await expect(slide.getByRole('heading', { name: 'Part A: Basics' })).toBeVisible();
  await expect(slide.getByText('Heute geht es um die Grundbegriffe.')).toBeVisible();
  // The section footer variant is still in place.
  await expect(page.locator('footer')).toBeVisible();
  await shot(page, 'presenter-interstitial');

  // Confirming moves on to the first question.
  await page.keyboard.press('ArrowRight');
  await expect(slide).toHaveCount(0);
});
