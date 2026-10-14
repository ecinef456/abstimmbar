/** API seeding for the phone layout specs (#179).
 *
 *  Everything goes through the REST API as the `demo` user (cross-origin to
 *  the backend, CSRF header from the `abstimmbar_csrftoken` cookie), mirroring
 *  the audit's setup script. Rooms are titled "E2E Mobile …" and deleted by
 *  the caller (mobile.teardown.ts / per-test cleanup). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE_URL, csrfToken, deleteRooms } from '../fixtures';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AUTH_DIR = path.resolve(HERE, '../.auth');
export const AUTH = {
  demo: path.join(AUTH_DIR, 'demo.json'),
  admin: path.join(AUTH_DIR, 'admin-demo.json'),
};
/** Ids of the shared room seeded by mobile.setup.ts. */
export const SEED_FILE = path.join(AUTH_DIR, 'mobile-seed.json');

export const LONG_WORD = 'Donaudampfschifffahrtsgesellschaftskapitän';
export const LONG_ANSWER = 'Antwort A mit einem etwas längeren Text';

export const KINDS = [
  'single_choice',
  'multiple_choice',
  'likert',
  'word_cloud',
  'open_text',
  'priorities',
  'ordering',
  'mindmap',
] as const;
export type Kind = (typeof KINDS)[number];

export type SeededQuestion = { id: number; kind: Kind; options: number[] };
export type Seed = {
  roomId: number;
  code: string;
  setId: number;
  runId: number;
  questions: SeededQuestion[];
};

const T = (de: string, en = '') => ({ de, en });
const opts = (...xs: string[]) =>
  xs.map((x, i) => ({ text: T(x, `${x} (EN)`), is_correct: i === 0 }));

/** One question payload per kind (fields as in backend/rooms/serializers.py). */
export const QUESTION_PAYLOADS: Record<Kind, Record<string, unknown>> = {
  single_choice: {
    text: T(
      '<p>Welche Antwort ist richtig? Eine etwas längere Frage, damit der Text umbricht.</p>',
      '<p>Which answer is right?</p>',
    ),
    options: opts(LONG_ANSWER, 'Antwort B', 'Antwort C', LONG_WORD),
  },
  multiple_choice: {
    text: T('<p>Mehrfachauswahl: Was trifft zu?</p>'),
    options: opts('Erstens', 'Zweitens', LONG_WORD),
  },
  likert: {
    text: T('<p>Wie zufrieden sind Sie?</p>'),
    options: ['Gar nicht', 'Wenig', 'Teils', 'Ziemlich', 'Sehr zufrieden'].map((x) => ({
      text: T(x),
    })),
  },
  word_cloud: { text: T('<p>Nennen Sie einen Begriff</p>'), wordcloud_max_answers: 3 },
  open_text: { text: T('<p>Freitext: Was nehmen Sie mit?</p>') },
  priorities: {
    text: T('<p>Verteilen Sie 100 Punkte</p>'),
    options: opts('Lehre', 'Forschung', LONG_WORD),
  },
  ordering: {
    text: T('<p>Bringen Sie in die richtige Reihenfolge</p>'),
    options: opts('Erstens', 'Zweitens', LONG_ANSWER, LONG_WORD),
  },
  mindmap: {
    text: T('<p>Mindmap: Ideen sammeln</p>'),
    mindmap_root: T('Ideen'),
    mindmap_depth: 2,
    mindmap_max_per_person: 0,
    mindmap_rating_mode: 'points',
    mindmap_rating_budget: 3,
  },
};

/** Thin JSON client for the backend API with CSRF + precise errors. */
export function apiClient(request: APIRequestContext) {
  async function call<R = any>(method: string, url: string, body?: unknown): Promise<R> {
    const token = await csrfToken(request);
    const response = await request.fetch(`${API_BASE_URL}${url}`, {
      method,
      headers: token ? { 'X-CSRFToken': token } : undefined,
      data: body,
    });
    const text = await response.text();
    if (!response.ok()) {
      throw new Error(`${method} ${url} → ${response.status()}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : null) as R;
  }
  return {
    get: <R = any>(url: string) => call<R>('GET', url),
    post: <R = any>(url: string, body?: unknown) => call<R>('POST', url, body ?? {}),
  };
}

export type Api = ReturnType<typeof apiClient>;

/** Room + live-poll set with one question per given kind (no run yet). */
export async function createRoomWithQuestions(
  request: APIRequestContext,
  kinds: readonly Kind[],
  label: string,
  /** Called as soon as the room exists, before anything else can fail. */
  onRoomCreated?: (roomId: number) => void,
  /** Title prefix; "E2E Mobile" rooms are swept by mobile.setup — specs
   *  that may run alongside it use another one. */
  prefix = 'E2E Mobile',
): Promise<Omit<Seed, 'runId'>> {
  const api = apiClient(request);
  // Room titles are unique per owner; parallel tests need their own suffix.
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const room = await api.post('/api/rooms/', {
    title: T(
      `${prefix} ${label} – ein ziemlich langer Raumtitel für Überlauf-Tests ${unique}`,
      `${prefix} ${label} ${unique}`,
    ),
    description: T('<p>Beschreibung für den Überlauf-Test</p>'),
  });
  onRoomCreated?.(room.id);
  try {
    const set = await api.post('/api/question-sets/', {
      room: room.id,
      title: T('E2E Fragenset mit langem Titel zum Testen', 'E2E set'),
    });
    const questions: SeededQuestion[] = [];
    for (const kind of kinds) {
      const q = await api.post('/api/questions/', {
        question_set: set.id,
        kind,
        ...QUESTION_PAYLOADS[kind],
      });
      questions.push({ id: q.id, kind, options: (q.options ?? []).map((o: { id: number }) => o.id) });
    }
    return { roomId: room.id, code: room.code, setId: set.id, questions };
  } catch (error) {
    // Don't leak a half-seeded room; the caller never learned its id.
    await deleteRooms(request, [room.id]).catch(() => undefined);
    throw error;
  }
}

/** A matrix question in `setId` (fields as the editor sends them). Defaults:
 *  x nicht nützlich→nützlich, y altbacken→modern, edges and descriptions on,
 *  max 2 cards per person, named categories Idee/Risiko. */
export async function createMatrixQuestion(
  api: Api,
  setId: number,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  const q = await api.post('/api/questions/', {
    question_set: setId,
    kind: 'matrix',
    text: T('<p>Wohin gehört die Idee?</p>', '<p>Where does the idea belong?</p>'),
    options: [],
    matrix_x_from: T('nicht nützlich', 'not useful'),
    matrix_x_to: T('nützlich', 'useful'),
    matrix_y_from: T('altbacken', 'old-fashioned'),
    matrix_y_to: T('modern', 'modern'),
    matrix_edges: true,
    matrix_descriptions: true,
    matrix_max_per_person: 2,
    matrix_category_mode: 'named',
    matrix_categories: [
      { key: 'blue', name: T('Idee', 'Idea') },
      { key: 'orange', name: T('Risiko', 'Risk') },
    ],
    ...overrides,
  });
  return q.id;
}

export async function startRun(api: Api, setId: number): Promise<number> {
  const r = await api.post(`/api/question-sets/${setId}/start-run/`, {
    mode: 'live',
    existing: 'delete',
  });
  return r.run;
}

export const control = (api: Api, runId: number, phase: string, question?: number) =>
  api.post(`/api/runs/${runId}/control/`, question ? { phase, question } : { phase });

// The participant endpoints are public, but a request context that carries a
// staff session cookie is subject to Django's CSRF check — send the header.
async function csrfHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const token = await csrfToken(request);
  return token ? { 'X-CSRFToken': token } : {};
}

/** Anonymous participant tokens via the public join endpoint. */
export async function joinParticipants(
  request: APIRequestContext,
  code: string,
  n: number,
): Promise<string[]> {
  const tokens: string[] = [];
  const headers = await csrfHeaders(request);
  for (let i = 0; i < n; i++) {
    const r = await request.post(`${API_BASE_URL}/api/live/rooms/${code}/join/`, { data: {}, headers });
    if (!r.ok()) throw new Error(`join ${code} → ${r.status()}: ${await r.text()}`);
    tokens.push((await r.json()).token);
  }
  return tokens;
}

const WORDS = ['Tablet', 'Smartphone', LONG_WORD, 'Barrierefreiheit'];
const MINDMAP_TERMS = ['Lehre', 'Digitalisierung und Infrastruktur', LONG_WORD, 'Mensa'];

/** Cast one answer per token for an *open* question (votes via public API). */
export async function castAnswers(
  request: APIRequestContext,
  code: string,
  q: SeededQuestion,
  tokens: string[],
): Promise<void> {
  const headers = await csrfHeaders(request);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let url = `${API_BASE_URL}/api/live/rooms/${code}/vote/`;
    let body: Record<string, unknown>;
    switch (q.kind) {
      case 'single_choice':
        body = { options: [q.options[i % q.options.length]] };
        break;
      case 'multiple_choice':
        body = { options: [q.options[0], q.options[(i % 2) + 1]] };
        break;
      case 'likert':
        body = { options: [q.options[i % q.options.length]] };
        break;
      case 'word_cloud':
        body = { text: WORDS[i % WORDS.length] };
        break;
      case 'open_text':
        body = {
          text: `Antwort Nummer ${i} mit etwas mehr Text, damit es umbricht – ${LONG_WORD}`,
        };
        break;
      case 'priorities':
        body = { points: { [q.options[0]]: 30 + i * 10, [q.options[1]]: 30, [q.options[2]]: 10 } };
        break;
      case 'ordering':
        body = { order: i % 2 ? [...q.options].reverse() : q.options };
        break;
      case 'mindmap':
        url = `${API_BASE_URL}/api/live/rooms/${code}/mindmap/add/`;
        body = { parent: null, text: MINDMAP_TERMS[i % MINDMAP_TERMS.length] };
        break;
    }
    const r = await request.post(url, { data: { token, question: q.id, ...body }, headers });
    if (!r.ok()) throw new Error(`${q.kind} answer → ${r.status()}: ${await r.text()}`);
  }
}

/** The shared management-UI room: all 8 kinds, one finished run with answers. */
export async function seedManagementRoom(
  request: APIRequestContext,
  onRoomCreated?: (roomId: number) => void,
): Promise<Seed> {
  const api = apiClient(request);
  const base = await createRoomWithQuestions(request, KINDS, 'Verwaltung', onRoomCreated);
  try {
    const runId = await startRun(api, base.setId);
    const tokens = await joinParticipants(request, base.code, 4);
    for (const q of base.questions) {
      await control(api, runId, 'open', q.id);
      await castAnswers(request, base.code, q, tokens);
      await control(api, runId, 'results', q.id);
    }
    await control(api, runId, 'finished');
    return { ...base, runId };
  } catch (error) {
    await deleteRooms(request, [base.roomId]).catch(() => undefined);
    throw error;
  }
}

/** Delete leftovers of earlier aborted runs: rooms the caller *owns* whose
 *  title (either language) starts with "E2E Mobile". Never touches others. */
export async function sweepStaleE2ERooms(request: APIRequestContext): Promise<number[]> {
  const api = apiClient(request);
  const stale: number[] = [];
  let url: string | null = '/api/rooms/';
  while (url) {
    const page: any = await api.get(url);
    const items: any[] = Array.isArray(page) ? page : (page.results ?? []);
    for (const room of items) {
      const titles = typeof room.title === 'object' ? Object.values(room.title) : [room.title];
      if (room.is_owner && titles.some((t) => typeof t === 'string' && t.startsWith('E2E Mobile'))) {
        stale.push(room.id);
      }
    }
    const next: string | null = Array.isArray(page) ? null : page.next;
    url = next ? next.replace(/^https?:\/\/[^/]+/, '') : null;
  }
  await deleteRooms(request, stale);
  return stale;
}

/** Partial seed record: written as soon as the room exists (cleanup needs only the id). */
export function writeSeed(seed: Partial<Seed> & { roomId: number }): void {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 1));
}

export function readSeed(): Seed {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as Seed;
}
