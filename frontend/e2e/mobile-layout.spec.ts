/** Phone-width layout regression tests (#179).
 *
 *  Reference device: Galaxy Z Fold7 front screen, 324×756 CSS px (projects
 *  `phone-chromium`/`phone-firefox` in playwright.config.ts). Each check runs
 *  in light and dark. Test titles carry the audit IDs from
 *  .superpowers/audit-2026-10-mobile-a11y.md (T* management UI, P* participant).
 *
 *  Data: mobile.setup.ts logs in demo/admin-demo once and seeds one shared
 *  "E2E Mobile" room (all 8 question kinds, a finished run with answers) for
 *  the read-only management pages. Participant tests drive a live run, so each
 *  creates its own small room and deletes it afterwards. */
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test as base, expect, API_BASE_URL, deleteRooms } from './fixtures';
import { expectInViewport, expectNoHorizontalOverflow } from './helpers/layout';
import {
  AUTH,
  KINDS,
  LONG_WORD,
  apiClient,
  castAnswers,
  control,
  createRoomWithQuestions,
  joinParticipants,
  readSeed,
  startRun,
  type Kind,
  type Seed,
  type SeededQuestion,
} from './helpers/seed';
import {
  expectBelow,
  expectNoClippedContent,
  expectNoMidWordBreaks,
  expectNoTextOverlap,
  expectOverlayNotCovering,
} from './helpers/text';

type UiMode = 'as-is' | 'easy' | 'pro';
type LiveRoom = Omit<Seed, 'runId'> & { runId: number; question: SeededQuestion };

const test = base.extend<
  {
    /** Easy ("Einfach") / Pro ("Experte") mode, forced per page via whoami. */
    uiMode: UiMode;
    _whoamiOverride: void;
    /** Room with one live question of `kind`, opened, plus 3 API answers. */
    liveRoom: (kinds: Kind[]) => Promise<LiveRoom>;
  },
  { seed: Seed; demoApi: APIRequestContext }
>({
  seed: [async ({}, use) => use(readSeed()), { scope: 'worker' }],
  demoApi: [
    async ({ playwright }, use) => {
      const request = await playwright.request.newContext({ storageState: AUTH.demo });
      await use(request);
      await request.dispose();
    },
    { scope: 'worker' },
  ],
  uiMode: ['pro', { option: true }],
  // The mode is persisted per user, so switching it via POST /api/whoami/mode/
  // would race between parallel workers. Rewrite the whoami response per page
  // instead; also mark the onboarding tour as seen so it never auto-starts.
  _whoamiOverride: [
    async ({ page, uiMode }, use) => {
      await page.route(/\/api\/whoami\/(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const json = await response.json();
        if (json.username) {
          json.onboarding_tour_seen = true;
          if (uiMode !== 'as-is') json.easy_mode = uiMode === 'easy';
        }
        await route.fulfill({ response, json });
      });
      await use();
      // whoami may still be in flight when a fast test ends.
      if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
    { auto: true },
  ],
  liveRoom: async ({ demoApi, page }, use) => {
    const created: number[] = [];
    await use(async (kinds) => {
      const api = apiClient(demoApi);
      // The id is recorded the moment the room exists, so a failure later in
      // seeding still gets cleaned up below.
      const room = await createRoomWithQuestions(demoApi, kinds, kinds.join('+'), (id) =>
        created.push(id),
      );
      const runId = await startRun(api, room.setId);
      return { ...room, runId, question: room.questions[0] };
    });
    // Close the participant page first: a live page that (re)joins while the
    // room is being deleted makes the cascade fail (FK on ParticipantToken).
    await page.close();
    await deleteRooms(demoApi, created);
  },
});

/** The forced Einfach/Experte mode really reached the page (header switch). */
async function expectMode(page: Page, mode: 'easy' | 'pro') {
  await expect(
    page.locator('[data-tour="header.mode"] [role="radio"][aria-checked="true"]'),
    `header mode switch should show ${mode}`,
  ).toHaveText(mode === 'easy' ? /^(Simple|Einfach)$/ : /^(Expert|Experte)$/);
}

/** Let fonts and layout settle before measuring. */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(250);
}

const MODES = ['easy', 'pro'] as const;
const MODE_LABEL = { easy: 'Einfach', pro: 'Experte' } as const;

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme}`, () => {
    test.use({ colorScheme });

    // ─── Management UI as demo ────────────────────────────────────────────
    test.describe('management UI (demo)', () => {
      test.use({ storageState: AUTH.demo });

      test('home / rooms list fits the screen [T12, T9]', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('[data-tour="rooms.list"]')).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page, 'home /');
      });

      test('home: segmented filter labels are not broken mid-word [T9]', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('[data-tour="rooms.filter"]')).toBeVisible();
        await settle(page);
        await expectNoMidWordBreaks(
          page.locator('[data-tour="rooms.filter"] [role="radio"]'),
          'rooms filter segmented control on home',
          2,
        );
      });

      test('help menu opens inside the viewport [T1]', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('[data-tour="rooms.list"]')).toBeVisible();
        await page.locator('[data-tour="header.help"]').click();
        const menu = page.locator('[role="menu"]');
        await expectInViewport(menu, 'help menu [role=menu]');
        for (const item of await menu.getByRole('menuitem').all()) {
          await expectInViewport(item, `help menu item "${(await item.innerText()).trim()}"`);
        }
      });

      test('user menu opens inside the viewport', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('[data-tour="rooms.list"]')).toBeVisible();
        await page
          .locator('header button[aria-haspopup="menu"]:not([data-tour="header.help"])')
          .click();
        const menu = page.locator('[role="menu"]');
        await expectInViewport(menu, 'user menu [role=menu]');
        await expectNoHorizontalOverflow(page, 'home with user menu open');
      });

      for (const mode of MODES) {
        test.describe(MODE_LABEL[mode], () => {
          test.use({ uiMode: mode });

          test('room page fits the screen [T6, T9]', async ({ page, seed }) => {
            await page.goto(`/rooms/${seed.roomId}`);
            await expect(page.getByRole('heading', { name: /E2E Mobile/ })).toBeVisible();
            await expect(page.getByText('E2E Fragenset mit langem Titel zum Testen')).toBeVisible();
            await settle(page);
            await expectMode(page, mode);
            await expectNoHorizontalOverflow(page, `room page (${mode})`);
          });

          test('room page: segmented filter labels are not broken mid-word [T9]', async ({ page, seed }) => {
            await page.goto(`/rooms/${seed.roomId}`);
            await expect(page.getByText('E2E Fragenset mit langem Titel zum Testen')).toBeVisible();
            await settle(page);
            await expectMode(page, mode);
            // The set-type filter (All / Live poll / Quiz block / Self-check).
            await expectNoMidWordBreaks(
              page.locator('main [role="group"] [role="radio"]'),
              `segmented controls on room page (${mode})`,
              3,
            );
          });

          test('set page fits the screen [T10]', async ({ page, seed }) => {
            await page.goto(`/sets/${seed.setId}`);
            await expect(page.locator('[data-tour="set.questions"]')).toBeVisible();
            await settle(page);
            await expectMode(page, mode);
            await expectNoHorizontalOverflow(page, `set page (${mode})`);
          });

          test('results page fits the screen [T7]', async ({ page, seed }) => {
            await page.goto(`/sets/${seed.setId}/results`);
            await expect(page.locator('[data-tour="results.view"]')).toBeVisible();
            await expect(page.getByText(LONG_WORD).first()).toBeVisible();
            await settle(page);
            await expectMode(page, mode);
            await expectNoHorizontalOverflow(page, `results page (${mode})`);
          });

          test('results page: labels and counts do not overlap [T8]', async ({ page, seed }) => {
            await page.goto(`/sets/${seed.setId}/results`);
            await expect(page.getByText(LONG_WORD).first()).toBeVisible();
            await settle(page);
            await expectMode(page, mode);
            await expectNoTextOverlap(page, 'main', `results page (${mode})`);
          });

          for (const kind of KINDS) {
            test(`question editor ${kind} fits the screen [T2]`, async ({ page, seed }) => {
              const q = seed.questions.find((x) => x.kind === kind)!;
              await page.goto(`/sets/${seed.setId}/questions/${q.id}`);
              await expect(page.locator('[data-tour="question.editor"]')).toBeVisible();
              await expect(page.locator('.ProseMirror').first()).toBeVisible();
              await settle(page);
              await expectMode(page, mode);
              await expectNoHorizontalOverflow(page, `question editor ${kind} (${mode})`);
            });
          }

          test('question editor: answer inputs get a usable width [T3]', async ({ page, seed }) => {
            const q = seed.questions.find((x) => x.kind === 'single_choice')!;
            await page.goto(`/sets/${seed.setId}/questions/${q.id}`);
            const inputs = page.getByRole('textbox', { name: /^(Answer text|Antworttext)/ });
            await expect(inputs.first()).toBeVisible();
            await settle(page);
            await expectMode(page, mode);
            const vw = await page.evaluate(() => window.innerWidth);
            const widths = await inputs.evaluateAll((els) =>
              els.map((el) => Math.round(el.getBoundingClientRect().width)),
            );
            const min = Math.round(vw * 0.6);
            expect(
              widths.filter((w) => w < min),
              `answer inputs narrower than ${min}px (60% of ${vw}px): widths ${widths.join(', ')}px`,
            ).toEqual([]);
          });
        });
      }

      // T4: on phones the translation controls (DE · EN · translate all)
      // dock into the <TranslationControlsSlot /> at the top of each form
      // with translatable fields — in the flow, never floating over it.
      const T4_FORMS: {
        name: string;
        open: (page: Page, seed: Seed) => Promise<void>;
      }[] = [
        {
          name: 'question editor',
          open: async (page, seed) => {
            const q = seed.questions.find((x) => x.kind === 'single_choice')!;
            await page.goto(`/sets/${seed.setId}/questions/${q.id}`);
            await expect(page.locator('[data-tour="question.editor"]')).toBeVisible();
          },
        },
        {
          name: 'room settings',
          open: async (page, seed) => {
            await page.goto(`/rooms/${seed.roomId}`);
            await page.getByRole('button', { name: /^(Room actions|Raum-Aktionen)$/ }).click();
            await page.getByRole('menuitem', { name: /^(Settings|Einstellungen)$/ }).click();
            await expect(page.locator('.ProseMirror').first()).toBeVisible();
          },
        },
        {
          name: 'set settings',
          open: async (page, seed) => {
            await page.goto(`/sets/${seed.setId}`);
            await page.getByRole('button', { name: /^(Set actions|Set-Aktionen)$/ }).click();
            await page.getByRole('menuitem', { name: /^(Settings|Einstellungen)$/ }).click();
            await expect(page.locator('.ProseMirror').first()).toBeVisible();
          },
        },
      ];
      for (const form of T4_FORMS) {
        test(`${form.name}: translation controls dock in the flow, not over content [T4]`, async ({ page, seed }) => {
          await form.open(page, seed);
          await settle(page);
          await expectMode(page, 'pro');
          // Our hook class on both controls variants (main.tsx,
          // controlsClassName + slotControlsClassName). In Experte the form
          // registers translatable fields, so the controls must be there.
          const controls = page.locator('.translation-controls');
          await expect(controls, `translation controls (.translation-controls) missing in ${form.name}`).toHaveCount(1);
          await expect(controls).toBeVisible();
          const position = await controls.evaluate((el) => getComputedStyle(el).position);
          expect(position, `translation controls in ${form.name} should be docked in the flow`).toBe('static');
          // Docked = no drag handle (it only exists on the floating pill).
          await expect(
            controls.getByRole('button', { name: /^(Move translation controls|Übersetzungsleiste verschieben)$/ }),
          ).toHaveCount(0);
          await expectNoHorizontalOverflow(page, `${form.name} with docked translation controls`);
          await expectOverlayNotCovering(page, controls, `translation controls (${form.name})`);
        });
      }

      test('Impressum fits the screen', async ({ page }) => {
        await page.goto('/pages/impressum');
        await expect(page.locator('article h1')).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page, '/pages/impressum');
      });

      test('Datenschutz fits the screen (data table may scroll) [T11]', async ({ page }) => {
        await page.goto('/pages/datenschutz');
        await expect(page.locator('article table')).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page, '/pages/datenschutz');
      });
    });

    // ─── Management UI as staff (admin-demo) ──────────────────────────────
    test.describe('management UI (admin-demo)', () => {
      test.use({ storageState: AUTH.admin });

      test('staff rooms list fits the screen [T5]', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('[data-tour="rooms.list"]')).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page, 'home / as staff');
      });

      test('staff rooms list: "show all rooms" checkbox is not on the "My rooms" heading row [T5]', async ({ page }) => {
        await page.goto('/');
        const heading = page.locator('h2', { hasText: /^(My rooms|Meine Räume)$/ });
        const checkbox = page.getByRole('checkbox', {
          name: /Show all rooms in the system|Alle Räume im System anzeigen/,
        });
        await expect(heading).toBeVisible();
        await expect(checkbox).toBeVisible();
        await settle(page);
        await expectBelow(checkbox, heading, '"show all rooms" checkbox vs. "My rooms" heading');
        // The label must read as one line, not "Alle / Räume / im / System / anzeigen".
        const label = page.locator('label', { has: checkbox });
        const lines = await label.evaluate((el) => {
          const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
          return Math.round(el.getBoundingClientRect().height / lh);
        });
        expect(lines, `"show all rooms" label wraps over ${lines} lines`).toBeLessThanOrEqual(1);
      });
    });

    // ─── Participant pages (anonymous) ────────────────────────────────────
    test.describe('participant', () => {
      test.use({ storageState: { cookies: [], origins: [] } });

      test('/p/ join page fits the screen', async ({ page }) => {
        await page.goto(`${API_BASE_URL}/p/`);
        await expect(page.locator('#code')).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page, '/p/');
      });

      test('/p/<code>/ lobby fits the screen', async ({ page, liveRoom }) => {
        const room = await liveRoom(['single_choice']);
        await page.goto(`${API_BASE_URL}/p/${room.code}/`);
        await expect(page.locator('#waiting')).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page, `/p/${room.code}/ lobby`);
      });

      for (const kind of KINDS) {
        for (const state of ['open', 'voted', 'results'] as const) {
          const ids =
            kind === 'likert'
              ? state === 'open'
                ? ' [P1, P2]'
                : state === 'results'
                  ? ' [P3]'
                  : ''
              : kind === 'single_choice' || kind === 'multiple_choice' || kind === 'ordering' || kind === 'priorities'
                ? ' [P1]'
                : '';
          test(`/p/<code>/ ${kind} ${state} fits the screen${ids}`, async ({ page, liveRoom, demoApi }) => {
            const room = await liveRoom([kind]);
            const api = apiClient(demoApi);
            await control(api, room.runId, 'open', room.question.id);
            const tokens = await joinParticipants(demoApi, room.code, 3);
            await castAnswers(demoApi, room.code, room.question, tokens);

            await page.goto(`${API_BASE_URL}/p/${room.code}/`);
            const view = kind === 'mindmap' ? '#mindmap' : '#question';
            await expect(page.locator(view)).toBeVisible();

            if (state !== 'open') await voteInUi(page, kind);
            if (state === 'results') {
              await control(api, room.runId, 'results', room.question.id);
              await expect(page.locator(kind === 'mindmap' ? '#mindmap' : '#resultsview')).toBeVisible();
            }
            await settle(page);
            const where = `/p/<code>/ ${kind} ${state}`;
            await expectNoHorizontalOverflow(page, where);
            await expectInViewport(page.locator('#lang-btn'), `${where}: language button in #menu-wrap`);
            if (kind === 'likert' && state === 'open') {
              await expectNoClippedContent(page.locator('.likert-seg'), `${where}: likert segments`, 5);
            }
            if (state === 'results') {
              await expectNoTextOverlap(
                page,
                kind === 'mindmap' ? '#mindmap' : '#resultsview',
                `${where}: results`,
              );
            }
          });
        }
      }

      // A picked likert step / ticked options must survive the live updates
      // other participants' votes trigger (each one re-sends the state).
      for (const kind of ['likert', 'multiple_choice'] as const) {
        test(`/p/<code>/ ${kind}: selection survives other participants' votes`, async ({ page, liveRoom, demoApi }) => {
          const room = await liveRoom([kind]);
          const api = apiClient(demoApi);
          await page.goto(`${API_BASE_URL}/p/${room.code}/`);
          await expect(page.locator('#waiting')).toBeVisible();
          const tokens = await joinParticipants(demoApi, room.code, 3);
          const q = room.questions[0];
          await control(api, room.runId, 'open', q.id);
          await expect(page.locator('#question')).toBeVisible();
          const picked = kind === 'likert'
            ? page.locator('#likert .likert-seg').nth(3)
            : page.locator('#options button').nth(0);
          const submit = kind === 'likert'
            ? page.locator('#question button.primary:visible').last()
            : page.locator('#submit-multi');
          await tapChecked(page, picked);
          await expect(picked).toHaveClass(/selected/);
          await castAnswers(demoApi, room.code, q, tokens);
          await page.waitForTimeout(1500); // let the debounced broadcasts arrive
          await expect(picked).toHaveClass(/selected/);
          await expect(submit).toBeEnabled();
        });
      }

      test('/p/<code>/ finished: "My answers" review fits the screen [P4]', async ({ page, liveRoom, demoApi }) => {
        const room = await liveRoom(['single_choice', 'likert']);
        const api = apiClient(demoApi);
        await page.goto(`${API_BASE_URL}/p/${room.code}/`);
        await expect(page.locator('#waiting')).toBeVisible();
        const tokens = await joinParticipants(demoApi, room.code, 3);
        for (const q of room.questions) {
          await control(api, room.runId, 'open', q.id);
          await expect(page.locator('#question')).toBeVisible();
          await castAnswers(demoApi, room.code, q, tokens);
          await voteInUi(page, q.kind);
          await control(api, room.runId, 'results', q.id);
          await expect(page.locator('#resultsview')).toBeVisible();
        }
        await control(api, room.runId, 'finished');
        await tapChecked(page, page.locator('#finished-review'));
        await expect(page.locator('#review')).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page, '/p/<code>/ review');
        // The ⋮/language menu is hidden on purpose while the review overlay is
        // open (openReview); its own "Back" button must be reachable instead.
        await expect(page.locator('#menu-wrap')).toBeHidden();
        await expectInViewport(page.locator('#review-close'), 'review: Back button');
        await expectNoTextOverlap(page, '#review', '/p/<code>/ review');
      });
    });
  });
}

/** Answer the open question like a participant would, with real taps
 *  (see tapChecked). */
async function voteInUi(page: Page, kind: Kind) {
  const tap = (locator: Locator) => tapChecked(page, locator);
  switch (kind) {
    case 'single_choice':
      // The last option is the long unbreakable word (P1).
      await tap(page.locator('#options button').last());
      break;
    case 'multiple_choice':
      await tap(page.locator('#options button').nth(0));
      await tap(page.locator('#options button').nth(2));
      await tap(page.locator('#submit-multi'));
      break;
    case 'likert':
      await tap(page.locator('#likert .likert-seg').nth(3));
      await tap(page.locator('#question button.primary:visible').last());
      break;
    case 'word_cloud':
      await page.locator('#word').fill(LONG_WORD);
      await page.locator('#word').press('Enter');
      await expect(page.locator('#wc-mine')).toContainText(LONG_WORD.slice(0, 10));
      return;
    case 'open_text':
      await page.locator('#opentext-input').fill(`Ein Freitext mit ein paar Worten und ${LONG_WORD}.`);
      await tap(page.locator('#opentext button[type=submit], #opentext button.primary').first());
      break;
    case 'priorities':
      await page.locator('#question input[type=range]').first().fill('60');
      await tap(page.locator('#question button.primary:visible').last());
      break;
    case 'ordering':
      await tap(page.locator('#question button.primary:visible').last());
      break;
    case 'mindmap': {
      await tap(page.locator('#mm-tree .mm-add').first());
      const input = page.locator('#mm-tree input').first();
      await input.fill(`Mobile Idee ${LONG_WORD}`);
      await input.press('Enter');
      await expect(page.locator('#mm-tree')).toContainText('Mobile Idee');
      return;
    }
  }
  await expect(page.locator('#done')).toBeVisible();
}

/** Real tap on a participant control. Playwright's actionability checks
 *  (visible, stable, enabled, receives the event at its centre — not covered)
 *  replace the earlier hand-rolled hit-test; the locator is re-resolved on
 *  every attempt, so SSE re-renders of the live page don't detach it. Both
 *  phone projects set `hasTouch`, so `tap()` dispatches touch events. */
async function tapChecked(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  await locator.tap();
}
