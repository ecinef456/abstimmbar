/** Leaving vs. ending (spec "PR 2"): the presenter's red ✕ / Esc only
 *  LEAVES — an open vote is closed, the run stays unfinished, participants
 *  see „paused" (+ "View my answers") and jump back to the question as soon
 *  as a new vote opens (also out of the review). Presenting again resumes.
 *  The survey is ended in the set overview („Umfrage beenden"), after which
 *  participants see the closing screen.
 *
 *  Runs as `demo` (logs in per test); seeds its own "E2E Leave …" rooms and
 *  deletes them. No AI calls. */
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL } from './fixtures';
import {
  apiClient,
  castAnswers,
  control,
  createRoomWithQuestions,
  joinParticipants,
  startRun,
} from './helpers/seed';

test.use({ locale: 'en-US', viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
});

const PAUSED = /presentation is paused|Präsentation ist gerade pausiert/;
const endButton = (page: Page) => page.locator('footer [data-help="end"]');
const position = (page: Page) => page.locator('footer [data-help="position"]');

async function openPresenterOnFirstQuestion(page: Page, setId: number) {
  await page.goto(`/sets/${setId}/present`);
  await expect(page.locator('[data-tour="present.join"]')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(position(page)).toHaveText('1/2');
}

async function liveStatus(page: Page, setId: number) {
  return apiClient(page.request).get<{ active_run: number | null }>(
    `/api/question-sets/${setId}/live-status/`,
  );
}

test('✕ leaves without ending; participant pauses and jumps back; resume', async ({
  page,
  browser,
  trackRoom,
}) => {
  const seed = await createRoomWithQuestions(
    page.request, ['single_choice', 'single_choice'], 'X', trackRoom, 'E2E Leave',
  );
  const participantCtx = await browser.newContext({ locale: 'en-US' });
  const p = await participantCtx.newPage();
  try {
    await p.goto(`${API_BASE_URL}/p/${seed.code}/`);
    await expect(p.locator('#waiting')).toBeVisible();

    await openPresenterOnFirstQuestion(page, seed.setId);
    // Open the vote (if "open on show" didn't) and answer it.
    if (!(await p.locator('#question').isVisible())) await page.keyboard.press('s');
    await expect(p.locator('#question')).toBeVisible();
    await p.locator('#options button').first().click(); // single choice: submits
    await expect(p.locator('#done')).toBeVisible();

    // ✕: leave to the set overview; the run stays unfinished.
    await expect(endButton(page)).toHaveAttribute('title', /Leave presentation/);
    await endButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/sets/${seed.setId}$`));
    expect((await liveStatus(page, seed.setId)).active_run).not.toBeNull();
    await expect(page.getByTestId('end-survey')).toBeVisible();

    // Participant: „paused" + "View my answers" → the review.
    await expect(p.locator('#paused')).toBeVisible();
    await expect(p.locator('#paused-text')).toHaveText(PAUSED);
    await p.locator('#paused-review').click();
    await expect(p.locator('#review')).toBeVisible();
    await expect(p.locator('#review-list')).not.toBeEmpty();

    // Presenting again resumes in place (no lobby, no start dialog) …
    await page.goto(`/sets/${seed.setId}/present`);
    await expect(position(page)).toHaveText('1/2');
    // … and a new vote pulls the participant out of the review to the question.
    await page.keyboard.press('ArrowRight');
    await expect(position(page)).toHaveText('2/2');
    if (!(await p.locator('#question').isVisible())) await page.keyboard.press('s');
    await expect(p.locator('#question')).toBeVisible();
    await expect(p.locator('#review')).toBeHidden();

    // Esc behaves like ✕: leaves without ending.
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`/sets/${seed.setId}$`));
    expect((await liveStatus(page, seed.setId)).active_run).not.toBeNull();
    await expect(p.locator('#paused')).toBeVisible();

    // A new vote while the participant sits on „paused" → straight to it.
    await page.goto(`/sets/${seed.setId}/present`);
    await expect(position(page)).toHaveText('2/2');
    await page.keyboard.press('ArrowLeft');
    await expect(position(page)).toHaveText('1/2');
    if (!(await p.locator('#question').isVisible() || await p.locator('#done').isVisible())) {
      await page.keyboard.press('s');
    }
    await expect(p.locator('#paused')).toBeHidden();
  } finally {
    await participantCtx.close();
  }
});

test('set overview: „End survey" finishes the run; participants see the closing screen', async ({
  page,
  browser,
  trackRoom,
}) => {
  const seed = await createRoomWithQuestions(
    page.request, ['single_choice', 'likert'], 'End', trackRoom, 'E2E Leave',
  );
  const participantCtx = await browser.newContext({ locale: 'en-US' });
  const p = await participantCtx.newPage();
  try {
    await p.goto(`${API_BASE_URL}/p/${seed.code}/`);
    await openPresenterOnFirstQuestion(page, seed.setId);
    // Double-click: leaves once (no second history entry for the set page).
    await endButton(page).dblclick();
    await expect(page).toHaveURL(new RegExp(`/sets/${seed.setId}$`));
    await expect(p.locator('#paused')).toBeVisible();
    // Nothing answered yet → no (empty) review button.
    await expect(p.locator('#paused-review')).toBeHidden();

    const end = page.getByTestId('end-survey');
    await expect(end).toHaveText(/End survey|Umfrage beenden/);
    await end.click();
    await expect(end).toBeHidden();
    expect((await liveStatus(page, seed.setId)).active_run).toBeNull();
    await expect(p.locator('#finished')).toBeVisible();
    await expect(p.locator('#paused')).toBeHidden();
  } finally {
    await participantCtx.close();
  }
});

test('„End survey" hides for the empty run "archive results" prepares; stale click recovers', async ({
  page,
  trackRoom,
}) => {
  const seed = await createRoomWithQuestions(
    page.request, ['single_choice'], 'Archive', trackRoom, 'E2E Leave',
  );
  const api = apiClient(page.request);
  const runId = await startRun(api, seed.setId);
  await control(api, runId, 'open', seed.questions[0].id);
  const tokens = await joinParticipants(page.request, seed.code, 1);
  await castAnswers(page.request, seed.code, seed.questions[0], tokens);

  await page.goto(`/sets/${seed.setId}`);
  const end = page.getByTestId('end-survey');
  await expect(end).toBeVisible();
  // Archived elsewhere (other tab): the shown button is stale → a click
  // refreshes, shows a friendly message and hides the button.
  await api.post(`/api/question-sets/${seed.setId}/archive-results/`);
  await end.click();
  await expect(page.getByText(/already ended|bereits beendet/)).toBeVisible();
  await expect(end).toBeHidden();
  // The fresh lobby run left by archiving doesn't count as "in use".
  expect((await liveStatus(page, seed.setId)).active_run).not.toBeNull();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(end).toBeHidden();
});
