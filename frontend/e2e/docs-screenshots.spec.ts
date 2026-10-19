/** Screenshots for the project website (`website/bilder/`), not a test.
 *
 *  Run with the dev stack up: `npm run docs:shots` (the `docs-shots` project
 *  exists only with DOCS_SHOTS set, so a plain `npx playwright test` never
 *  picks this file up). Seeds synthetic rooms as `demo` — titles in the
 *  shot language for the pictures, the other language's title prefixed
 *  "E2E Docs …" so leftovers are recognisable and swept — and deletes them
 *  afterwards.
 *
 *  DOCS_SHOTS_LANG=en: English UI and English content for the English site
 *  (default output ../website/en/bilder, same file names); default: German.
 *
 *  Light theme; desktop/beamer 1440×900 and phone 390×844, rendered at
 *  device scale 1.5 / 2. Never calls an LLM: the matrix AI proposal is simulated
 *  and signed by the backend (`helpers/matrixAi.ts`) and route-mocked.
 *  DOCS_SHOTS_DIR=<dir> writes elsewhere (default: ../website/bilder);
 *  DOCS_SHOTS_ONLY=<name>,<name> writes only those shots (the run is the same).
 *  The beamer's join QR encodes the public placeholder URL, generated with the
 *  backend's own QR code library (needs `docker compose` in the repo root). */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, API_BASE_URL, csrfToken, deleteRooms } from './fixtures';
import { apiClient, control, startRun, type Api } from './helpers/seed';
import { applySummary, signedProposal } from './helpers/matrixAi';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANG: 'de' | 'en' = process.env.DOCS_SHOTS_LANG === 'en' ? 'en' : 'de';
const EN = LANG === 'en';
const LOCALE = EN ? 'en-US' : 'de-DE';
const OUT = path.resolve(
  process.env.DOCS_SHOTS_DIR ?? path.join(HERE, EN ? '../../website/en/bilder' : '../../website/bilder'),
);
const ONLY = (process.env.DOCS_SHOTS_ONLY ?? '').split(',').map((n) => n.trim()).filter(Boolean);
const PREFIX = 'E2E Docs';
/** Host shown (and encoded in the QR) instead of the dev stack's localhost:8002. */
const PUBLIC_HOST = 'abstimmbar.example.org';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

const T = (de: string, en: string) => ({ de, en });
const P = (s: string) => `<p>${s}</p>`;
/** Text in the shot language (what participants type, UI labels). */
const L = (de: string, en: string) => (EN ? en : de);

// Device scale 1.5 (2160×1350 px): crisp on high-density screens while the
// PNGs stay around 200 KB (scale 2 → up to 300 KB; resampling in a canvas
// makes them bigger, not smaller).
test.use({ viewport: DESKTOP, deviceScaleFactor: 1.5, locale: LOCALE, colorScheme: 'light' });

// ---------------------------------------------------------------- helpers

/** Settled page: fonts loaded, no running finite animations, a short pause
 *  for layout transitions; caret and transient UI hidden. */
async function settle(page: Page, ms = 600) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(ms);
  await page
    .evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => {
            const timing = a.effect?.getComputedTiming();
            return timing && timing.endTime !== Infinity && a.playState === 'running';
          })
          .map((a) => a.finished.catch(() => undefined)),
      ).then(() => undefined),
    )
    .catch(() => undefined);
  await page.waitForTimeout(150);
}

const HIDE_TRANSIENT = `
  *, *::before, *::after { caret-color: transparent !important; }
  [role="status"][data-toast], .toast, [data-sonner-toaster] { display: none !important; }
`;

async function shot(page: Page, name: string) {
  if (ONLY.length && !ONLY.includes(name)) return;
  await settle(page);
  await page.addStyleTag({ content: HIDE_TRANSIENT });
  await page.mouse.move(0, 0);
  const png = await page.screenshot({ animations: 'disabled' });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, png);
  console.log(`  ${name}.png  ${Math.round(png.length / 1024)} KB`);
}

/** The room QR as production would render it: same library and settings as
 *  `live.views.room_qr`, but for https://<PUBLIC_HOST>/p/<code> instead of
 *  the dev host (the backend builds it from the request host). */
function publicRoomQr(code: string): Buffer {
  const script =
    'import sys, qrcode; ' +
    'qrcode.make(sys.argv[1], box_size=12, border=1).save(sys.stdout.buffer, format="PNG")';
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'backend', 'python', '-c', script, `https://${PUBLIC_HOST}/p/${code}`],
    { cwd: path.join(HERE, '../..') },
  );
}

/** whoami as the screenshots want it: tour seen, expert mode, AI on. */
async function routeWhoami(page: Page | BrowserContext) {
  await page.route(/\/api\/whoami\/(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    if (json.username) {
      json.onboarding_tour_seen = true;
      json.easy_mode = false;
      json.ai_enabled = true;
    }
    await route.fulfill({ response, json });
  });
}

async function login(page: Page) {
  await page.addInitScript((lang) => {
    try {
      localStorage.setItem('abstimmbar_theme', 'light');
      localStorage.setItem('abstimmbar_lang', lang);
      // One-time moderation/AI tips on the beamer: already seen.
      for (const key of ['abstimmbar_wc_moderation_hint', 'abstimmbar_mm_moderation_hint_v2', 'abstimmbar_wc_ai_hint'])
        localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
  }, LANG);
  await routeWhoami(page);
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
}

/** Rooms of the caller titled "E2E Docs …" in any language (leftovers). */
async function sweep(request: APIRequestContext, api: Api) {
  const stale: number[] = [];
  let url: string | null = '/api/rooms/';
  while (url) {
    const page: any = await api.get(url);
    const items: any[] = Array.isArray(page) ? page : (page.results ?? []);
    for (const room of items) {
      const titles = typeof room.title === 'object' ? Object.values(room.title) : [room.title];
      if (room.is_owner && titles.some((t) => typeof t === 'string' && t.startsWith(PREFIX))) stale.push(room.id);
    }
    const next: string | null = Array.isArray(page) ? null : page.next;
    url = next ? next.replace(/^https?:\/\/[^/]+/, '') : null;
  }
  await deleteRooms(request, stale);
}

async function phoneContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: PHONE_UA,
    locale: LOCALE,
    colorScheme: 'light',
  });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('abstimmbar_theme', 'light');
    } catch {
      /* ignore */
    }
  });
  return context;
}

// ---------------------------------------------------------------- content

const SC_OPTIONS = [
  ['Peer Instruction mit Abstimmung', 'Peer instruction with voting', true, 11],
  ['Folien vorlesen', 'Reading out slides', false, 2],
  ['Längere Videokurse ansehen', 'Watching longer video courses', false, 5],
  ['Handout zum Nachlesen', 'Handout for later', false, 4],
] as const;

const WORDS: [string, number][] = EN
  ? [
      ['Interaction', 9],
      ['Feedback', 7],
      ['Structure', 6],
      ['Real-world relevance', 5],
      ['Enthusiasm', 5],
      ['Clarity', 4],
      ['Discussion', 4],
      ['Study group', 3],
      ['Examples', 3],
      ['Motivation', 3],
      ['Video course', 2],
      ['Patience', 2],
      ['Humour', 2],
      ['Transparency', 2],
      ['Variety of methods', 1],
      ['Time for questions', 1],
    ]
  : [
      ['Interaktion', 9],
      ['Feedback', 7],
      ['Struktur', 6],
      ['Praxisbezug', 5],
      ['Begeisterung', 5],
      ['Klarheit', 4],
      ['Austausch', 4],
      ['Lerngruppe', 3],
      ['Beispiele', 3],
      ['Motivation', 3],
      ['Videokurs', 2],
      ['Geduld', 2],
      ['Humor', 2],
      ['Transparenz', 2],
      ['Methodenvielfalt', 1],
      ['Zeit für Fragen', 1],
    ];

const MINDMAP: [string, string[]][] = EN
  ? [
      ['Communication', ['Messenger group', 'Weekly online meeting', 'Forum in the course space']],
      ['Material', ['Shared wiki', 'Notes on the video course']],
      ['Organisation', ['Task plan', 'Assign roles', 'Fixed dates']],
      ['Feedback', ['Peer review', 'Quick poll after each session']],
      ['Tools', ['Video conferencing', 'Kanban board']],
    ]
  : [
      ['Kommunikation', ['Messenger-Gruppe', 'Wöchentliches Online-Treffen', 'Forum im Lernraum']],
      ['Material', ['Gemeinsames Wiki', 'Notizen zum Videokurs']],
      ['Organisation', ['Aufgabenplan', 'Rollen verteilen', 'Feste Termine']],
      ['Feedback', ['Peer-Review', 'Kurzumfrage nach jeder Sitzung']],
      ['Werkzeuge', ['Videokonferenz', 'Kanban-Board']],
    ];
/** Terms a second and third participant contribute again (counted, not doubled). */
const MINDMAP_AGAIN = EN
  ? ['Communication', 'Messenger group', 'Shared wiki', 'Task plan']
  : ['Kommunikation', 'Messenger-Gruppe', 'Gemeinsames Wiki', 'Aufgabenplan'];

// Zones are quadrants: q1 top right (high benefit & low effort), q2 top
// left, q3 bottom left, q4 bottom right (high benefit & high effort).
// [zone, key (= German title), English title, category, description de, en]
const MATRIX_CARDS: [string, string, string, string, string, string][] = [
  ['q1', 'Kurze Lernvideos', 'Short learning videos', 'green', 'Fünf Minuten, ein Gedanke pro Video', 'Five minutes, one idea per video'],
  ['q1', 'Kurzvideos', 'Short videos', 'green', '', ''],
  ['q1', 'Quiz nach jedem Kapitel', 'Quiz after each chapter', 'green', 'Selbsttest mit sofortigem Feedback', 'Self-test with instant feedback'],
  ['q1', 'Untertitel', 'Subtitles', 'orange', '', ''],
  ['q1', 'Glossar', 'Glossary', 'blue', '', ''],
  ['q1', 'Begriffsliste', 'List of terms', 'blue', '', ''],
  ['q1', 'Fachbegriffe erklären', 'Explain technical terms', 'blue', '', ''],
  ['q2', 'Hintergrundmusik', 'Background music', 'orange', '', ''],
  ['q2', 'Intro-Animation', 'Intro animation', 'orange', '', ''],
  ['q4', 'Interaktive Simulationen', 'Interactive simulations', 'green', '', ''],
  ['q4', 'Fallbeispiele aus der Praxis', 'Real-world case studies', 'blue', 'Interviews mit Absolvent:innen', 'Interviews with graduates'],
  ['q4', 'Live-Fragestunde', 'Live Q&A session', 'green', '', ''],
  ['q4', 'Sprechstunde per Video', 'Video office hours', 'green', '', ''],
  ['q3', 'Eigenes Videostudio', 'Our own video studio', 'orange', '', ''],
  ['q3', 'VR-Rundgang', 'VR tour', 'orange', '', ''],
];
/** Card title in the shot language, by its (German) key. */
const card = (key: string) => {
  const c = MATRIX_CARDS.find((x) => x[1] === key)!;
  return L(c[1], c[2]);
};

// ---------------------------------------------------------------- the run

test('website screenshots', async ({ page, browser }) => {
  test.setTimeout(10 * 60_000);
  fs.mkdirSync(OUT, { recursive: true });
  await login(page);
  const request = page.request;
  const api = apiClient(request);
  const csrf = await csrfToken(request);
  const headers = csrf ? { 'X-CSRFToken': csrf } : undefined;
  await sweep(request, api);

  const created: number[] = [];
  const contexts: BrowserContext[] = [];
  try {
    // The title in the shot language is what the pictures show; the other
    // one carries the sweep prefix.
    const room = async (de: string, en: string, descDe: string, descEn: string) => {
      const r = await api.post('/api/rooms/', {
        title: EN ? T(`${PREFIX} ${de}`, en) : T(de, `${PREFIX} ${en}`),
        description: EN ? T(P(descDe), P(descEn)) : T(P(descDe), ''),
      });
      created.push(r.id);
      return r as { id: number; code: string };
    };
    const set = (roomId: number, de: string, en: string, descDe = '', descEn = '') =>
      api.post('/api/question-sets/', {
        room: roomId,
        title: T(de, en),
        ...(descDe ? { description: T(P(descDe), EN ? P(descEn) : '') } : {}),
      }) as Promise<{ id: number }>;
    const section = (setId: number, de: string, en: string) =>
      api.post('/api/sections/', { question_set: setId, title: T(de, en) }) as Promise<{ id: number }>;
    const qs: { id: number; section: number | null }[] = [];
    const question = async (setId: number, body: Record<string, unknown>) => {
      const q = (await api.post('/api/questions/', { question_set: setId, ...body })) as {
        id: number;
        options: { id: number }[];
      };
      qs.push({ id: q.id, section: (body.section as number) ?? null });
      return q;
    };

    // Two further rooms so the start page looks lived-in.
    const stats = await room(
      'Einführung in die Statistik',
      'Introduction to statistics',
      'Wöchentliche Verständnisfragen zur Vorlesung',
      'Weekly comprehension questions on the lecture',
    );
    const statsSet = await set(stats.id, 'Woche 3: Streuungsmaße', 'Week 3: Measures of spread');
    await question(statsSet.id, {
      kind: 'single_choice',
      text: T(P('Welches Maß ist robust gegenüber Ausreißern?'), P('Which measure is robust against outliers?')),
      options: [
        { text: T('Median', 'Median'), is_correct: true },
        { text: T('Arithmetisches Mittel', 'Arithmetic mean'), is_correct: false },
        { text: T('Spannweite', 'Range'), is_correct: false },
      ],
    });
    const evalRoom = await room(
      'Lehrevaluation Wintersemester',
      'Course evaluation, winter term',
      'Kurzes Zwischenfeedback zur Semestermitte',
      'Short mid-term feedback',
    );
    const evalSet = await set(evalRoom.id, 'Zwischenfeedback', 'Interim feedback');
    await question(evalSet.id, {
      kind: 'likert',
      text: T(P('Wie gut können Sie dem Tempo folgen?'), P('How well can you follow the pace?')),
      options: [
        ['Gar nicht', 'Not at all'],
        ['Eher schlecht', 'Rather poorly'],
        ['Teils, teils', 'Partly'],
        ['Eher gut', 'Rather well'],
        ['Sehr gut', 'Very well'],
      ].map(([de, en]) => ({ text: T(de, en) })),
    });

    // The main room.
    const workshop = await room(
      'Didaktik-Workshop',
      'Didactics workshop',
      'Interaktive Übungen für den Workshop „Digitale Lehre gestalten“',
      'Interactive exercises for the workshop “Designing digital teaching”',
    );
    const main = await set(
      workshop.id,
      'Digitale Lehre gestalten',
      'Designing digital teaching',
      'Abstimmungen, Wortwolke, Mindmap und Vier-Felder-Matrix für den Workshop',
      'Polls, word cloud, mind map and four-field matrix for the workshop',
    );
    const s1 = await section(main.id, 'Einstieg', 'Warm-up');
    const s2 = await section(main.id, 'Ideen sammeln', 'Collect ideas');
    const s3 = await section(main.id, 'Ideen bewerten', 'Rate ideas');

    const sc = await question(main.id, {
      kind: 'single_choice',
      section: s1.id,
      text: T(
        P('Welche Methode aktiviert Studierende in großen Vorlesungen am stärksten?'),
        P('Which method activates students most in large lectures?'),
      ),
      options: SC_OPTIONS.map(([de, en, correct]) => ({ text: T(de, en), is_correct: correct })),
    });
    const wc = await question(main.id, {
      kind: 'word_cloud',
      section: s1.id,
      text: T(P('Was macht für Sie gute Lehre aus?'), P('What makes good teaching for you?')),
      wordcloud_max_answers: 3,
    });
    const mm = await question(main.id, {
      kind: 'mindmap',
      section: s2.id,
      text: T(
        P('Wie kann die Lerngruppe digital zusammenarbeiten?'),
        P('How can the study group work together digitally?'),
      ),
      mindmap_root: T('Lerngruppe digital', 'Digital study group'),
      mindmap_depth: 2,
      mindmap_max_per_person: 0,
    });
    const mx = await question(main.id, {
      kind: 'matrix',
      section: s2.id,
      text: T(
        P('Welche Ideen für den neuen Videokurs setzen wir um?'),
        P('Which ideas for the new video course do we implement?'),
      ),
      options: [],
      matrix_x_from: T('geringer Nutzen', 'little benefit'),
      matrix_x_to: T('hoher Nutzen', 'high benefit'),
      matrix_y_from: T('hoher Aufwand', 'high effort'),
      matrix_y_to: T('geringer Aufwand', 'low effort'),
      matrix_edges: true,
      matrix_descriptions: true,
      matrix_max_per_person: 5,
      matrix_category_mode: 'named',
      matrix_categories: [
        { key: 'blue', name: T('Inhalt', 'Content') },
        { key: 'orange', name: T('Technik', 'Technology') },
        { key: 'green', name: T('Didaktik', 'Didactics') },
      ],
      matrix_rating_mode: 'points',
      matrix_rating_budget: 5,
      matrix_rating_multi: true,
      matrix_rating_live: true,
      wordcloud_ai_enabled: true,
    });
    await question(main.id, {
      kind: 'likert',
      section: s3.id,
      text: T(P('Wie zufrieden sind Sie mit dem Workshop?'), P('How satisfied are you with the workshop?')),
      options: [
        ['Gar nicht', 'Not at all'],
        ['Wenig', 'Slightly'],
        ['Teils, teils', 'Partly'],
        ['Ziemlich', 'Quite'],
        ['Sehr zufrieden', 'Very satisfied'],
      ].map(([de, en]) => ({ text: T(de, en) })),
    });
    await question(main.id, {
      kind: 'ordering',
      section: s3.id,
      text: T(
        P('Bringen Sie die Phasen einer Lerneinheit in eine sinnvolle Reihenfolge.'),
        P('Put the phases of a learning unit in a sensible order.'),
      ),
      options: [
        ['Aktivieren', 'Activate'],
        ['Erarbeiten', 'Work out'],
        ['Üben', 'Practise'],
        ['Reflektieren', 'Reflect'],
      ].map(([de, en], i) => ({
        text: T(de, en),
        is_correct: i === 0,
      })),
    });
    await set(workshop.id, 'Feedback zum Workshop', 'Workshop feedback');
    // Sections and questions share one outline sequence; put each question
    // below its section header.
    await api.post(`/api/question-sets/${main.id}/reorder-outline/`, {
      items: [s1, s2, s3].flatMap((s) => [
        { type: 'section', id: s.id },
        ...qs.filter((q) => q.section === s.id).map((q) => ({ type: 'question', id: q.id })),
      ]),
    });

    // ------------------------------------------------ management UI shots
    // Start page: only the seeded rooms (the demo account has others).
    const ours = new Set(created);
    await page.route(/\/api\/rooms\/(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const json = await response.json();
      const keep = (r: { id: number }) => ours.has(r.id);
      if (Array.isArray(json)) return route.fulfill({ response, json: json.filter(keep) });
      if (Array.isArray(json.results)) {
        json.results = json.results.filter(keep);
        json.count = json.results.length;
      }
      await route.fulfill({ response, json });
    });
    await page.goto('/');
    await expect(page.getByText(L('Didaktik-Workshop', 'Didactics workshop')).first()).toBeVisible();
    // The one-time AI privacy notice: dismissed once (stored per browser).
    const notice = page.getByText(/KI-Model|AI model/);
    if (await notice.isVisible()) {
      await page.getByRole('button', { name: /^(Schließen|Dismiss|Close)$/ }).first().click();
      await expect(notice).toBeHidden();
    }
    await shot(page, 'start-raeume');

    await page.goto(`/sets/${main.id}`);
    await expect(page.getByText(L('Ideen sammeln', 'Collect ideas')).first()).toBeVisible();
    await shot(page, 'fragenset-gruppen');

    await page.goto(`/sets/${main.id}/questions/${sc.id}`);
    await expect(page.getByRole('textbox').first()).toBeVisible();
    await page.waitForTimeout(800);
    await page.mouse.wheel(0, 200);
    await shot(page, 'editor-einfachauswahl');

    await page.goto(`/sets/${main.id}/questions/${mx.id}`);
    await expect(page.getByRole('textbox').first()).toBeVisible();
    await page.waitForTimeout(800);
    await page.getByText(L('Achsen', 'Axes'), { exact: true }).evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 110));
    await shot(page, 'editor-matrix');

    // ------------------------------------------------ the live run
    const runId = await startRun(api, main.id);
    const n = 24;
    const tokens: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await request.post(`${API_BASE_URL}/api/live/rooms/${workshop.code}/join/`, { data: {}, headers });
      expect(r.ok()).toBeTruthy();
      tokens.push((await r.json()).token);
    }
    const live = async (url: string, data: Record<string, unknown>) => {
      const r = await request.post(`${API_BASE_URL}/api/live/rooms/${workshop.code}/${url}/`, { data, headers });
      expect(r.ok(), `${url}: ${await r.text()}`).toBeTruthy();
      return r.json();
    };

    // A few connected participant pages (the beamer counts them).
    const audience = await phoneContext(browser);
    contexts.push(audience);
    for (let i = 0; i < 4; i++) await (await audience.newPage()).goto(`${API_BASE_URL}/p/${workshop.code}/`);

    // Beamer join screen (no question open yet), QR for the public URL.
    const qrPng = publicRoomQr(workshop.code);
    await page.route(`**/p/${workshop.code}/qr.png`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: qrPng }),
    );
    await page.goto(`/sets/${main.id}/present?resume=continue`);
    await expect(page.getByText(workshop.code).first()).toBeVisible();
    // The dev stack's join URL would read "localhost:8002".
    await page.evaluate((host) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.nodeValue?.includes('localhost:8002'))
          node.nodeValue = node.nodeValue.replace(/https?:\/\/|localhost:8002/g, (m) => (m.startsWith('http') ? '' : host));
    }, PUBLIC_HOST);
    await shot(page, 'beamer-beitritt');

    // Phone: join page.
    const phone = await phoneContext(browser);
    contexts.push(phone);
    const handy = await phone.newPage();
    await handy.goto(`${API_BASE_URL}/p/`);
    await handy.getByRole('textbox').fill(workshop.code);
    await shot(handy, 'handy-beitreten');

    // Single choice: open, phone vote, votes, results.
    await control(api, runId, 'open', sc.id);
    await handy.goto(`${API_BASE_URL}/p/${workshop.code}/`);
    await expect(handy.locator('#question')).toBeVisible();
    await shot(handy, 'handy-einfachauswahl');
    let t = 0;
    for (const [i, [, , , count]] of SC_OPTIONS.entries()) {
      for (let k = 0; k < count; k++) await live('vote', { token: tokens[t++], question: sc.id, options: [sc.options[i].id] });
    }
    await control(api, runId, 'results', sc.id);
    await page.goto(`/sets/${main.id}/present?resume=continue`);
    await page.waitForTimeout(2500);
    await shot(page, 'beamer-einfachauswahl');
    await page.keyboard.press('?');
    await expect(page.getByTestId('presenter-help')).toBeVisible();
    await shot(page, 'beamer-hilfe');
    await page.keyboard.press('Escape');

    // Word cloud.
    await control(api, runId, 'open', wc.id);
    let w = 0;
    for (const [word, count] of WORDS) {
      for (let k = 0; k < count; k++) await live('vote', { token: tokens[w++ % n], question: wc.id, text: word });
    }
    await control(api, runId, 'results', wc.id);
    await page.waitForTimeout(2500);
    await shot(page, 'beamer-wortwolke');

    // Mind map.
    await control(api, runId, 'open', mm.id);
    let m = 0;
    for (const [branch, leaves] of MINDMAP) {
      const b = await live('mindmap/add', { token: tokens[m++ % n], question: mm.id, parent: null, text: branch });
      const reps = (term: string) => (MINDMAP_AGAIN.includes(term) ? 3 : 1);
      for (let k = 1; k < reps(branch); k++)
        await live('mindmap/add', { token: tokens[m++ % n], question: mm.id, parent: null, text: branch });
      for (const leaf of leaves) {
        for (let k = 0; k < reps(leaf); k++)
          await live('mindmap/add', { token: tokens[m++ % n], question: mm.id, parent: b.node_id, text: leaf });
      }
    }
    await page.waitForTimeout(2500);
    await shot(page, 'beamer-mindmap');

    // Matrix: cards, a stack, an applied AI summary card.
    await control(api, runId, 'open', mx.id);
    const ids: Record<string, number> = {};
    for (const [k, [zone, key, titleEn, category, descDe, descEn]] of MATRIX_CARDS.entries()) {
      const r = await live('matrix/add', {
        token: tokens[k % n],
        question: mx.id,
        zone,
        title: L(key, titleEn),
        category,
        description: L(descDe, descEn),
      });
      ids[key] = r.card_id;
    }
    await api.post(`/api/runs/${runId}/matrix/${mx.id}/stack`, {
      card: ids['Kurzvideos'],
      onto: ids['Kurze Lernvideos'],
    });
    await applySummary(api, runId, mx.id, [
      { cards: [ids['Glossar'], ids['Begriffsliste'], ids['Fachbegriffe erklären']], title: L('Glossar der Fachbegriffe', 'Glossary of technical terms') },
    ]);
    await page.goto(`/sets/${main.id}/present?resume=continue`);
    await expect(page.locator('[data-matrix-board]')).toBeVisible();
    await page.waitForTimeout(2000);
    await shot(page, 'beamer-matrix');

    // AI panel with a mocked proposal.
    const proposal = signedProposal(
      runId,
      mx.id,
      [
        {
          cards: [ids['Live-Fragestunde'], ids['Sprechstunde per Video']],
          title: L('Live-Sprechstunde', 'Live office hours'),
          reason: L(
            'Beide Karten meinen eine regelmäßige Fragerunde per Video.',
            'Both cards mean a regular Q&A session by video.',
          ),
        },
      ],
      [],
    );
    await page.route(/\/api\/runs\/\d+\/matrix\/\d+\/ai-propose$/, (route) => route.fulfill({ json: proposal }));
    await page.locator('[data-help="handle.mx-ai"]').click();
    const panel = page.getByTestId('mx-ai-panel');
    await expect(panel).toBeInViewport();
    await panel.getByRole('button', { name: L('Vorschlag holen', 'Get proposal') }).click();
    await expect(panel.getByTestId('mx-ai-group')).toHaveCount(1);
    await shot(page, 'ki-matrix');
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeInViewport();

    // Rating: stop collecting, start the rating, phone rates, ranking.
    await page.keyboard.press('s');
    await page.getByTestId('mx-start-rating').click();
    await expect(page.getByTestId('mx-back-to-collecting')).toBeVisible();
    const rate = (token: string, card: string, delta = 1) =>
      live('matrix/rate', { token, question: mx.id, card: ids[card], delta });
    const plan: [string, number][] = [
      ['Quiz nach jedem Kapitel', 14],
      ['Kurze Lernvideos', 11],
      ['Fallbeispiele aus der Praxis', 9],
      ['Untertitel', 7],
      ['Interaktive Simulationen', 5],
      ['Live-Fragestunde', 3],
    ];
    let r = 0;
    for (const [title, points] of plan) for (let k = 0; k < points; k++) await rate(tokens[r++ % n], title);
    await handy.reload();
    await expect(handy.locator('#mx-rate-list')).toBeVisible();
    const plus = (title: string) =>
      handy.locator('#mx-rate-list li', { hasText: card(title) }).getByRole('button', { name: /Punkt vergeben|Give a point/ });
    const left = handy.locator('#mx-rate-status');
    await expect(left).toHaveText(L('Noch 5 Punkte', '5 points left'));
    await plus('Quiz nach jedem Kapitel').click();
    await expect(left).toHaveText(L('Noch 4 Punkte', '4 points left'));
    await plus('Quiz nach jedem Kapitel').click();
    await expect(left).toHaveText(L('Noch 3 Punkte', '3 points left'));
    await plus('Kurze Lernvideos').click();
    await expect(left).toHaveText(L('Noch 2 Punkte', '2 points left'));
    await shot(handy, 'handy-matrix-bewerten');
    await page.locator('footer [data-help="view.mx.ranking"]').click();
    await expect(page.getByTestId('matrix-ranking')).toBeVisible();
    await shot(page, 'beamer-matrix-rangliste');

    // Results page after the run.
    await control(api, runId, 'finished');
    await page.goto(`/sets/${main.id}/results`);
    await page.waitForTimeout(2000);
    await shot(page, 'ergebnisse');
  } finally {
    for (const c of contexts) await c.close().catch(() => undefined);
    await deleteRooms(request, created);
  }
});
