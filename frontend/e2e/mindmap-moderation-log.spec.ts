/** Mind-map moderation log on the beamer (#201, desktop): the pencil drawer
 *  lists merges, moves, renames and applied AI proposals (sections below
 *  "Ausgeblendet", newest first); "Zurücksetzen" resets exactly that one
 *  entry (also one in the middle), a conflict shows „Nicht mehr möglich: …"
 *  inline and changes nothing, focus stays in the drawer, the top undo
 *  removes the entry and a reset from the list drops the matching undo step;
 *  locked while rating; help card; axe.
 *
 *  Never calls the LLM: the AI entry comes from a backend-signed proposal
 *  (`helpers/mindmapAi.ts`) applied via ai-apply. Runs as `demo`; seeds its
 *  own "E2E Mindmap Protokoll" rooms and deletes them.
 *  MM_LOG_SHOTS=<dir> saves screenshots of the drawer. */
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, API_BASE_URL, csrfToken } from './fixtures';
import { apiClient, control, createRoomWithQuestions, joinParticipants, startRun } from './helpers/seed';
import { signedMindmapProposal } from './helpers/mindmapAi';

const SHOTS = process.env.MM_LOG_SHOTS ?? '';

test.use({ locale: 'de-DE', viewport: { width: 1280, height: 860 } });

test.beforeEach(async ({ page }) => {
  // Tour seen, expert mode (the pencil is expert-only), AI configured.
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
  await page.goto(`${API_BASE_URL}/oidc/authenticate/`);
  await page.getByRole('textbox', { name: /Username or email|Benutzername/ }).fill('demo');
  await page.getByRole('textbox', { name: /Password|Passwort/ }).fill('demo');
  await page.getByRole('button', { name: /Sign In|Anmelden/ }).click();
  await page.waitForURL('http://localhost:5174/**');
});

type Node = { id: number; text: string; children: Node[] };

async function seed(page: Page, trackRoom: (id: number) => void) {
  const room = await createRoomWithQuestions(page.request, ['mindmap'], 'Mindmap Protokoll', trackRoom, 'E2E Mindmap Protokoll');
  const api = apiClient(page.request);
  const questionId = room.questions[0].id;
  const csrf = await csrfToken(page.request);
  const patch = await page.request.fetch(`${API_BASE_URL}/api/questions/${questionId}/`, {
    method: 'PATCH',
    headers: csrf ? { 'X-CSRFToken': csrf } : undefined,
    data: { wordcloud_ai_enabled: true },
  });
  expect(patch.ok(), await patch.text()).toBeTruthy();
  const runId = await startRun(api, room.setId);
  await control(api, runId, 'open', questionId);
  const [token] = await joinParticipants(page.request, room.code, 1);
  const add = async (text: string, parent: number | null = null) => {
    const r = await page.request.post(`${API_BASE_URL}/api/live/rooms/${room.code}/mindmap/add/`, {
      data: { token, question: questionId, parent, text },
      headers: csrf ? { 'X-CSRFToken': csrf } : undefined,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return (await r.json()).node_id as number;
  };
  const base = `/api/runs/${runId}/mindmap/${questionId}`;
  /** text → parent text (null = main branch) of the server's visible tree. */
  const parents = async (): Promise<Record<string, string | null>> => {
    const body = await api.get(`/api/question-sets/${room.setId}/results/`);
    const run = body.results.find((r: { run: number }) => r.run === runId);
    const nodes: Node[] = run.questions.find((q: { id: number }) => q.id === questionId).mindmap.nodes;
    const out: Record<string, string | null> = {};
    const walk = (ns: Node[], parent: string | null) =>
      ns.forEach((n) => {
        out[n.text] = parent;
        walk(n.children, n.text);
      });
    walk(nodes, null);
    return out;
  };
  return { room, api, questionId, runId, add, base, parents };
}

const drawer = (page: Page) => page.getByTestId('mm-mod-drawer');
const section = (page: Page, name: string) => drawer(page).getByRole('region', { name });

async function openPresenter(page: Page, setId: number) {
  await page.goto(`/sets/${setId}/present?resume=continue`);
  await expect(page.getByTestId('mindmap')).toBeVisible();
}

async function openDrawer(page: Page) {
  await page.getByRole('button', { name: 'Moderieren', exact: true }).click();
  await expect(drawer(page)).toBeInViewport();
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(400); // drawer slide-in
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('lists merges, moves, renames and AI changes; resets one in the middle', async ({ page, trackRoom }) => {
  const s = await seed(page, trackRoom);
  const ids = {
    windenergie: await s.add('Windenergie'),
    windkraft: await s.add('Windkraft'),
    technik: await s.add('Technik'),
    wnd: await s.add('Wnd'),
    solar: await s.add('Solar'),
    papier: await s.add('Papier'),
  };
  ids['rotor'] = await s.add('Rotor', ids.technik);
  ids['sonne'] = await s.add('Sonne', ids.solar);
  // Oldest first: merge, move, rename, AI (move Sonne to the main branch), hide.
  await s.api.post(`${s.base}/merge`, { source: ids.windkraft, target: ids.windenergie });
  await s.api.post(`${s.base}/move`, { node: ids.rotor, parent: ids.windenergie });
  await s.api.post(`${s.base}/rename`, { node: ids.wnd, text: 'Wind' });
  const proposal = signedMindmapProposal(s.runId, s.questionId, [
    { type: 'move', node: ids.sonne, parent: null, reason: '' },
  ]);
  const applied = await s.api.post(`${s.base}/ai-apply`, { proposal, selected: [0] });
  expect(applied.applied).toBe(1);
  await s.api.post(`${s.base}/hide`, { node: ids.papier, hidden: true });

  await openPresenter(page, s.room.setId);
  // Help: the mind map's pencil has its own card.
  await page.keyboard.press('?');
  await expect(page.locator('[data-testid="help-card"][data-help-for="handle.mm-moderate"]')).toBeVisible();
  await page.keyboard.press('Escape');

  await openDrawer(page);
  await expect(section(page, 'Ausgeblendet')).toContainText('Papier');
  // Label in name (WCAG 2.5.3): the accessible name starts with the visible text.
  await expect(section(page, 'Ausgeblendet').getByRole('button', { name: /Papier/ })).toHaveAccessibleName(
    /^Wieder einblenden/,
  );
  await expect(section(page, 'Zusammengeführt')).toContainText('„Windkraft“ in „Windenergie“ zusammengeführt');
  await expect(section(page, 'Verschoben')).toContainText('„Rotor“ verschoben: Technik → Windenergie');
  await expect(section(page, 'Umbenannt')).toContainText('„Wnd“ → „Wind“ umbenannt');
  await expect(section(page, 'KI-Änderungen')).toContainText('KI: 1 Änderung');
  // Section order: Ausgeblendet, Zusammengeführt, Verschoben, Umbenannt, KI-Änderungen.
  await expect(drawer(page).getByRole('heading', { level: 3 })).toHaveText([
    'Ausgeblendet',
    'Zusammengeführt',
    'Verschoben',
    'Umbenannt',
    'KI-Änderungen',
  ]);
  await shot(page, 'mm-log-drawer');

  const axe = await new AxeBuilder({ page })
    .include('[data-testid="mm-mod-drawer"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);

  // Reset the move (in the middle): only Rotor goes back to Technik.
  await section(page, 'Verschoben').getByRole('button', { name: /Zurücksetzen/ }).click();
  await expect(section(page, 'Verschoben')).toHaveCount(0);
  await expect
    .poll(s.parents)
    .toMatchObject({ Rotor: 'Technik', Wind: null, Windenergie: null, Sonne: null });
  const tree = await s.parents();
  expect(tree).not.toHaveProperty('Windkraft');
  expect(tree).not.toHaveProperty('Wnd');
  // Focus stays in the drawer (the next "Zurücksetzen").
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="mm-mod-drawer"]')))
    .toBe(true);
  await expect(section(page, 'Zusammengeführt')).toBeVisible();
  await expect(section(page, 'Umbenannt')).toBeVisible();
  await expect(section(page, 'KI-Änderungen')).toBeVisible();

  // Reset the AI batch and the merge from the list as well.
  await section(page, 'KI-Änderungen').getByRole('button', { name: /Zurücksetzen/ }).click();
  await expect(section(page, 'KI-Änderungen')).toHaveCount(0);
  await section(page, 'Zusammengeführt').getByRole('button', { name: /Zurücksetzen/ }).click();
  await expect(section(page, 'Zusammengeführt')).toHaveCount(0);
  await expect.poll(s.parents).toMatchObject({ Sonne: 'Solar', Windkraft: null, Wind: null });
});

test('a conflicting reset says why and changes nothing', async ({ page, trackRoom }) => {
  const s = await seed(page, trackRoom);
  const technik = await s.add('Technik');
  const wind = await s.add('Wind');
  const solar = await s.add('Solar');
  const rotor = await s.add('Rotor', technik);
  await s.api.post(`${s.base}/move`, { node: rotor, parent: wind });
  await s.api.post(`${s.base}/move`, { node: rotor, parent: solar });

  await openPresenter(page, s.room.setId);
  await openDrawer(page);
  const moved = section(page, 'Verschoben');
  await expect(moved.getByRole('listitem')).toHaveCount(2);
  // The older move (Technik → Wind) no longer fits: Rotor sits under Solar.
  const older = moved.getByRole('listitem').filter({ hasText: 'Technik → Wind' });
  await older.getByRole('button', { name: /Zurücksetzen/ }).click();
  await expect(older).toContainText(/Nicht mehr möglich: Der Platz des Begriffs hat sich seitdem geändert/);
  await expect(older.getByRole('button', { name: /Zurücksetzen/ })).toBeFocused();
  await expect(page.getByTestId('mm-mod-announce')).toHaveText(/Nicht mehr möglich: Der Platz des Begriffs/);
  await shot(page, 'mm-log-conflict');
  expect((await s.parents()).Rotor).toBe('Solar');
  await expect(moved.getByRole('listitem')).toHaveCount(2);
});

test('top undo removes the entry; a reset from the list drops its undo step', async ({ page, trackRoom }) => {
  const s = await seed(page, trackRoom);
  await s.add('Wnd');
  await s.add('Sola');
  await openPresenter(page, s.room.setId);

  const rename = async (from: string, to: string) => {
    await page.locator('[data-mm-node]').filter({ hasText: new RegExp(`^${from}`) }).first().dblclick();
    const input = page.getByRole('textbox', { name: 'Begriff' });
    await input.fill(to);
    await input.press('Enter');
    await expect(page.locator('[data-mm-node]').filter({ hasText: new RegExp(`^${to}`) })).toHaveCount(1);
  };

  // Top undo marks the entry reset: it leaves the list.
  await rename('Wnd', 'Wind');
  await openDrawer(page);
  await expect(section(page, 'Umbenannt')).toContainText('„Wnd“ → „Wind“ umbenannt');
  await drawer(page).getByRole('button', { name: 'Rückgängig' }).click();
  await expect(section(page, 'Umbenannt')).toHaveCount(0);
  await expect.poll(s.parents).toHaveProperty('Wnd', null);
  await drawer(page).getByRole('button', { name: 'Schließen' }).click();

  // Two renames; the older one is reset from the list → the top undo takes
  // back only the newer one and then has nothing left (no error toast).
  await rename('Wnd', 'Wind');
  await rename('Sola', 'Solar');
  await openDrawer(page);
  const renamed = section(page, 'Umbenannt');
  await expect(renamed.getByRole('listitem')).toHaveCount(2);
  await renamed
    .getByRole('listitem')
    .filter({ hasText: '„Wnd“ → „Wind“' })
    .getByRole('button', { name: /Zurücksetzen/ })
    .click();
  await expect(renamed.getByRole('listitem')).toHaveCount(1);
  await expect.poll(s.parents).toHaveProperty('Wnd', null);
  const undo = drawer(page).getByRole('button', { name: 'Rückgängig' });
  await undo.click();
  await expect.poll(s.parents).toHaveProperty('Sola', null);
  await expect(section(page, 'Umbenannt')).toHaveCount(0);
  await expect(undo).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: /zwischenzeitlich|nicht mehr/i })).toHaveCount(0);
});

test('locked while rating', async ({ page, trackRoom }) => {
  const s = await seed(page, trackRoom);
  const a = await s.add('Windkraft');
  const b = await s.add('Windenergie');
  await s.add('Solar');
  await s.api.post(`${s.base}/merge`, { source: a, target: b });
  await s.api.post(`${s.base}/stage`, { stage: 'rate', open: true });
  await openPresenter(page, s.room.setId);
  await openDrawer(page);
  await expect(drawer(page)).toContainText('Während der Bewertung nicht möglich.');
  await expect(section(page, 'Zusammengeführt').getByRole('button', { name: /Zurücksetzen/ })).toBeDisabled();
  await shot(page, 'mm-log-rating');
});

test('while dragging every term shows its "attach here" tab; a parent\'s tab attaches as a child', async ({ page, trackRoom }) => {
  const s = await seed(page, trackRoom);
  const energie = await s.add('Energie');
  await s.add('Wind', energie);
  const solar = await s.add('Solar');
  const papier = await s.add('Papier');
  await openPresenter(page, s.room.setId);
  const map = page.getByTestId('mindmap');
  const node = (id: number) => map.locator(`[data-mm-node="${id}"]`);
  const tab = (id: number) => map.locator(`[data-mm-tab="${id}"]`);
  await expect(node(papier)).toBeVisible();
  await page.waitForTimeout(700); // fit / layout transition settles
  const centre = async (l: ReturnType<typeof node>) => {
    const bb = (await l.boundingBox())!;
    return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
  };
  // Grab "Papier" and hold it over the body of "Solar".
  const from = await centre(node(papier));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 2 });
  const over = await centre(node(solar));
  await page.mouse.move(over.x, over.y, { steps: 10 });
  // Every other term (Energie, Wind, Solar) offers its tab — not the dragged one.
  await expect(map.locator('[data-mm-tab]')).toHaveCount(3);
  await expect(tab(papier)).toHaveCount(0);
  await expect(tab(solar)).toHaveAttribute('data-active', '');
  await expect(tab(energie)).not.toHaveAttribute('data-active', '');
  // The merge bubble also says how to attach instead.
  const bubble = map.getByRole('status');
  await expect(bubble).toContainText('Mit „Solar“ zusammenführen');
  await expect(bubble).toContainText('Zum Anhängen als Unterbegriff auf die Lasche „Hier einhängen“ ziehen');
  // The parent's icon-only tab is labelled.
  await expect(tab(energie)).toHaveAttribute('title', 'Hier einhängen');
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="mindmap"]')
    // The dragged term itself is deliberately faded (its ghost follows the pointer).
    .exclude(`[data-mm-node="${papier}"]`)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  await shot(page, 'mm-drag-tabs');
  // Over the parent's body: its icon-only tab gets its label below it.
  const body = await centre(node(energie));
  await page.mouse.move(body.x, body.y, { steps: 10 });
  await expect(tab(energie)).toHaveAttribute('data-active', '');
  await expect(map.locator(`[data-mm-tab-label="${energie}"]`)).toHaveText('Hier einhängen');
  await expect(bubble).toContainText('Mit „Energie“ zusammenführen');
  await shot(page, 'mm-drag-parent-body');
  // Straight onto the parent's (icon-only) tab: attach below "Energie".
  const t = await centre(tab(energie));
  await page.mouse.move(t.x, t.y, { steps: 10 });
  await expect(tab(energie)).toHaveAttribute('data-active', '');
  await expect(bubble).toContainText('Unter „Energie“ einhängen');
  await shot(page, 'mm-drag-parent-tab');
  await page.mouse.up();
  await expect.poll(s.parents).toMatchObject({ Papier: 'Energie', Wind: 'Energie', Solar: null });
});

test('a drop straight onto a leaf\'s tab (without crossing its body) attaches below it', async ({ page, trackRoom }) => {
  const s = await seed(page, trackRoom);
  const energie = await s.add('Energie');
  await s.add('Wind', energie);
  const solar = await s.add('Solar');
  const papier = await s.add('Papier');
  await openPresenter(page, s.room.setId);
  const map = page.getByTestId('mindmap');
  const node = (id: number) => map.locator(`[data-mm-node="${id}"]`);
  await expect(node(solar)).toBeVisible();
  await page.waitForTimeout(700); // fit / layout transition settles
  const bb = (await node(solar).boundingBox())!;
  const from = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 2 });
  const tab = map.locator(`[data-mm-tab="${papier}"]`);
  await expect(tab).toBeVisible();
  const tb = (await tab.boundingBox())!;
  const vw = page.viewportSize()!.width;
  // Centre of the tab's on-screen part, reached in one jump.
  const x = (Math.max(tb.x, 0) + Math.min(tb.x + tb.width, vw - 1)) / 2;
  await page.mouse.move(x, tb.y + tb.height / 2, { steps: 1 });
  await expect(tab).toHaveAttribute('data-active', '');
  await expect(map.getByRole('status')).toContainText('Unter „Papier“ einhängen');
  await page.mouse.up();
  await expect.poll(s.parents).toMatchObject({ Solar: 'Papier', Papier: null, Wind: 'Energie' });
});
