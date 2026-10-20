/** Results page: the AI actions of a word cloud / free text only show when the
 *  question's own AI switch is on (the backend rejects them otherwise); with
 *  the switch off a muted hint takes their place. Seeds an "E2E Results AI"
 *  room and deletes it. */
import { test, expect, API_BASE_URL } from './fixtures';
import { apiClient, castAnswers, control, createRoomWithQuestions, joinParticipants, startRun } from './helpers/seed';

test.use({ locale: 'de-DE', viewport: { width: 1280, height: 1000 } });

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/whoami\/(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    if (json.username) Object.assign(json, { onboarding_tour_seen: true, easy_mode: false, ai_enabled: true });
    await route.fulfill({ response, json });
  });
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
});

test('AI buttons follow the question\'s AI switch; hint when it is off', async ({ page, trackRoom }) => {
  test.setTimeout(90_000);
  const room = await createRoomWithQuestions(page.request, [], 'Ergebnis KI', trackRoom, 'E2E Results AI');
  const api = apiClient(page.request);
  const text = (de: string) => ({ de, en: de });
  const make = async (kind: 'word_cloud' | 'open_text', ai: boolean) => {
    const q = await api.post('/api/questions/', {
      question_set: room.setId,
      kind,
      text: text(`<p>${kind} ${ai ? 'mit' : 'ohne'} KI</p>`),
      options: [],
      wordcloud_ai_enabled: ai,
    });
    return { id: q.id as number, kind, options: [] as number[] };
  };
  const questions = [
    await make('word_cloud', false),
    await make('open_text', false),
    await make('word_cloud', true),
    await make('open_text', true),
  ];
  const runId = await startRun(api, room.setId);
  const tokens = await joinParticipants(page.request, room.code, 2);
  for (const q of questions) {
    await control(api, runId, 'open', q.id);
    await castAnswers(page.request, room.code, q, tokens);
  }
  await control(api, runId, 'finished');
  await page.goto(`/sets/${room.setId}/results`);

  // Two questions with the switch off, two with it on.
  await expect(page.getByText('Die KI ist für diese Frage ausgeschaltet.')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Mit KI optimieren' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Antworten auswerten' })).toHaveCount(1);
});
