/** Rich-text fields follow outside resets of their value even when the new
 *  value equals what the editor started with (the editor ignores echoes of
 *  its own edits, so such a reset needs a remount — see RichTextInput).
 *
 *  Runs as `demo` in the German UI; seeds its own "E2E …" rooms and deletes
 *  them. No AI calls. */
import { test, expect, API_BASE_URL } from './fixtures';
import { createRoomWithQuestions } from './helpers/seed';

test.use({ locale: 'de-DE', viewport: { width: 1280, height: 900 } });

test.beforeEach(async ({ page }) => {
  // Pro mode (set types to pick from) and no auto-starting tour.
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

const SEEDED_TEXT = 'Welche Antwort ist richtig? Eine etwas längere Frage, damit der Text umbricht.';

test('"Verwerfen & weiter" to a question with the same text shows that text, not the discarded edit', async ({
  page,
  trackRoom,
}) => {
  // Both seeded questions carry the identical text; the page is not
  // remounted between questions.
  const seed = await createRoomWithQuestions(
    page.request, ['single_choice', 'single_choice'], 'Reset', trackRoom, 'E2E Reset',
  );
  const [q1, q2] = seed.questions;
  await page.goto(`/sets/${seed.setId}/questions/${q1.id}`);
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toHaveText(SEEDED_TEXT);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' VERWORFEN');
  await expect(editor).toHaveText(`${SEEDED_TEXT} VERWORFEN`);

  await page.getByRole('button', { name: 'Nächste Frage' }).click();
  await page.getByRole('button', { name: 'Verwerfen & weiter' }).click();
  await expect(page).toHaveURL(new RegExp(`/questions/${q2.id}$`));
  await expect(editor).toHaveText(SEEDED_TEXT);
  // What is shown is what would be saved: no unsaved-changes prompt.
  await page.getByRole('button', { name: 'Vorherige Frage' }).click();
  await expect(page).toHaveURL(new RegExp(`/questions/${q1.id}$`));
  await expect(page.getByRole('button', { name: 'Verwerfen & weiter' })).toHaveCount(0);
});

test('picking another set type resets the new-set description in the editor too', async ({
  page,
  trackRoom,
}) => {
  const seed = await createRoomWithQuestions(page.request, [], 'Reset', trackRoom, 'E2E Reset');
  await page.goto(`/rooms/${seed.roomId}`);
  const pick = async (type: string) => {
    await page.getByRole('button', { name: /Neues Fragenset/ }).click();
    await page.getByRole('menuitem', { name: new RegExp(type) }).click();
  };
  await pick('Live-Umfrage');
  const description = page.getByRole('textbox', { name: 'Beschreibung', exact: true });
  await description.click();
  await page.keyboard.type('Entwurf, der beim Typwechsel verschwindet');
  await expect(description).toHaveText('Entwurf, der beim Typwechsel verschwindet');

  await pick('Quiz-Block');
  await expect(description).toHaveText('');
});
