/** Four-field matrix: editor (type picker, axes, edges, categories, save and
 *  validation). Runs as `demo` in the German UI; seeds its own "E2E Matrix"
 *  rooms and deletes them. */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL } from './fixtures';
import { apiClient, createRoomWithQuestions } from './helpers/seed';

test.use({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });

test.beforeEach(async ({ page }) => {
  // Pro mode (both content languages visible) and no auto-starting tour.
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

async function openMatrixEditor(page: Page, setId: number) {
  await page.goto(`/sets/${setId}`);
  await page.getByRole('button', { name: /Neue Frage/ }).click();
  const group = page.getByRole('group', { name: 'Offen antworten' });
  await group.getByRole('menuitem', { name: /Vier-Felder-Matrix/ }).click();
  await expect(page.locator('[data-tour="question.editor"]')).toBeVisible();
}

async function fillQuestionText(page: Page, text: string) {
  const editor = page.locator('.ProseMirror').first();
  await editor.click();
  await page.keyboard.type(text);
}

test('create a matrix question with axes, edges and named categories; it persists', async ({
  page,
  trackRoom,
}) => {
  const seed = await createRoomWithQuestions(page.request, [], 'Matrix', trackRoom, 'E2E Matrix');
  await openMatrixEditor(page, seed.setId);

  await fillQuestionText(page, 'Wohin gehört die Idee?');
  await page.getByRole('textbox', { name: 'x-Achse von' }).fill('altbacken');
  await page.getByRole('textbox', { name: 'x-Achse bis' }).fill('modern');
  await page.getByRole('textbox', { name: 'y-Achse von' }).fill('nutzlos');
  await page.getByRole('textbox', { name: 'y-Achse bis' }).fill('nützlich');
  await page.getByRole('switch', { name: 'Kanten erlauben' }).click();

  await page.getByRole('radio', { name: 'mit Namen' }).click();
  await page.getByRole('textbox', { name: 'Name der Kategorie 1' }).fill('Idee');
  await page.getByRole('textbox', { name: 'Name der Kategorie 2' }).fill('Risiko');
  await page.getByRole('button', { name: '+ Kategorie' }).click();
  await page.getByRole('textbox', { name: 'Name der Kategorie 3' }).fill('Chance');

  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  // Saving a new question returns to the set page.
  await expect(page).toHaveURL(new RegExp(`/sets/${seed.setId}$`));
  const api = apiClient(page.request);
  const listed = await api.get(`/api/questions/?question_set=${seed.setId}`);
  const items = Array.isArray(listed) ? listed : listed.results;
  expect(items).toHaveLength(1);
  const questionId = items[0].id;

  const stored = await api.get(`/api/questions/${questionId}/`);
  expect(stored.kind).toBe('matrix');
  expect(stored.matrix_x_from.de).toBe('altbacken');
  expect(stored.matrix_x_to.de).toBe('modern');
  expect(stored.matrix_y_from.de).toBe('nutzlos');
  expect(stored.matrix_y_to.de).toBe('nützlich');
  expect(stored.matrix_edges).toBe(true);
  expect(stored.matrix_category_mode).toBe('named');
  expect(stored.matrix_categories.map((c: any) => [c.key, c.name.de])).toEqual([
    ['blue', 'Idee'],
    ['orange', 'Risiko'],
    ['green', 'Chance'],
  ]);

  await page.goto(`/sets/${seed.setId}/questions/${questionId}`);
  await expect(page.getByRole('textbox', { name: 'x-Achse von' })).toHaveValue('altbacken');
  await expect(page.getByRole('textbox', { name: 'y-Achse bis' })).toHaveValue('nützlich');
  await expect(page.getByRole('switch', { name: 'Kanten erlauben' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByRole('textbox', { name: 'Name der Kategorie 3' })).toHaveValue('Chance');
});

test('"Alle Felder übersetzen" fills every matrix field (axes and category names)', async ({
  page,
  trackRoom,
}) => {
  await page.route(/\/api\/translate\/$/, async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { translated: `EN ${body.text}` } });
  });
  const seed = await createRoomWithQuestions(page.request, [], 'Matrix', trackRoom, 'E2E Matrix');
  await openMatrixEditor(page, seed.setId);
  const fields = [
    ['x-Achse von', 'links'],
    ['x-Achse bis', 'rechts'],
    ['y-Achse von', 'unten'],
    ['y-Achse bis', 'oben'],
    ['Name der Kategorie 1', 'Idee'],
    ['Name der Kategorie 2', 'Risiko'],
  ] as const;
  await page.getByRole('radio', { name: 'mit Namen' }).click();
  for (const [name, de] of fields) {
    await page.getByRole('textbox', { name, exact: true }).first().fill(de);
  }
  await page.getByRole('button', { name: 'Alle Felder übersetzen' }).click();
  // After translating, each field shows its (now filled) English tab.
  for (const [name, de] of fields) {
    await page.getByRole('tablist', { name, exact: true }).getByRole('tab', { name: /^en/ }).click();
    await expect(page.getByRole('textbox', { name, exact: true })).toHaveValue(`EN ${de}`);
  }
});

test('the Bearbeiten/Vorschau switcher keeps icon and label on one line', async ({
  page,
  trackRoom,
}) => {
  const seed = await createRoomWithQuestions(page.request, [], 'Matrix', trackRoom, 'E2E Matrix');
  await openMatrixEditor(page, seed.setId);
  for (const width of [1280, 1024, 768, 324]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ['Bearbeiten', 'Vorschau']) {
      const radio = page.getByRole('radio', { name, exact: true });
      const icon = (await radio.locator('svg').boundingBox())!;
      const text = (await radio.locator('span').first().boundingBox())!;
      // Icon and label share a line: the icon's vertical centre lies within the
      // label's box (stacked, it would sit above it).
      expect(icon.y + icon.height / 2, `${name} icon centre at ${width}`).toBeGreaterThan(text.y);
      expect(icon.y + icon.height / 2, `${name} icon centre at ${width}`).toBeLessThan(
        text.y + text.height,
      );
      expect((await radio.boundingBox())!.height, `${name} height at ${width}`).toBeLessThan(34);
    }
    const group = (await page.getByRole('group', { name: 'Ansicht' }).boundingBox())!;
    expect(group.x + group.width).toBeLessThanOrEqual(width);
  }
});

test('saving with an empty axis label is blocked', async ({ page, trackRoom }) => {
  const seed = await createRoomWithQuestions(page.request, [], 'Matrix', trackRoom, 'E2E Matrix');
  await openMatrixEditor(page, seed.setId);
  await fillQuestionText(page, 'Frage ohne Achsen');
  await page.getByRole('textbox', { name: 'x-Achse von' }).fill('links');
  await page.getByRole('textbox', { name: 'x-Achse bis' }).fill('rechts');
  await page.getByRole('textbox', { name: 'y-Achse von' }).fill('unten');
  // y-axis end left empty.
  await expect(page.getByText('Bitte beschriften Sie beide Enden beider Achsen.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeDisabled();
  await expect(page).toHaveURL(/\/questions\/new/);
  // Labelling the last end lifts the block.
  await page.getByRole('textbox', { name: 'y-Achse bis' }).fill('oben');
  await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeEnabled();
});

test('a self-paced set does not offer the matrix', async ({ page, trackRoom }) => {
  const seed = await createRoomWithQuestions(page.request, [], 'Matrix', trackRoom, 'E2E Matrix');
  const api = apiClient(page.request);
  const set = await api.post('/api/question-sets/', {
    room: seed.roomId,
    type: 'self_paced',
    title: { de: 'E2E Stillarbeit', en: 'E2E self-paced' },
  });
  await page.goto(`/sets/${set.id}`);
  await page.getByRole('button', { name: /Neue Frage/ }).click();
  await expect(page.getByRole('menuitem', { name: /Einzelauswahl|Single Choice/ }).first()).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Vier-Felder-Matrix/ })).toHaveCount(0);
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe ${scheme}`, () => {
  test.use({ colorScheme: scheme });
  test(`matrix editor (${scheme})`, async ({ page, trackRoom }) => {
    const seed = await createRoomWithQuestions(page.request, [], 'Matrix', trackRoom, 'E2E Matrix');
    await page.addInitScript((s) => {
      try {
        localStorage.setItem('abstimmbar_theme', s);
      } catch {
        /* ignore */
      }
    }, scheme);
    await openMatrixEditor(page, seed.setId);
    await page.getByRole('radio', { name: 'mit Namen' }).click();
    await page.getByRole('textbox', { name: 'Name der Kategorie 1' }).fill('Idee');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // Let finite transitions (segmented-control thumb) finish before measuring.
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ).then(() => undefined),
    );
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      violations.map((v) => ({
        rule: v.id,
        nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')} — ${n.any[0]?.message ?? ''}`),
      })),
    ).toEqual([]);
  });
  });
}
