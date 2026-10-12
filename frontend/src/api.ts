// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

import type { LocalizedText } from "@basicbar/ui";
import type { SetType } from "./setTypes";

/** Backend base URL. Defaults to "" (same-origin, relative URLs) — production
 * serves the SPA and API from one origin behind Caddy. Dev overrides this via
 * VITE_API_BASE_URL since the dev frontend and backend run cross-origin. */
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export interface Whoami {
  authenticated: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  is_staff?: boolean;
  easy_mode?: boolean;
  language?: string;
  csrf_token?: string;
  ai_enabled?: boolean;
  /** Safety cap on questions per generation run (AI_GEN_MAX_QUESTIONS). */
  ai_generate_max_questions?: number;
  /** Content-i18n (#33 MR2): the deployment's canonical authoring language
   * and whether machine-translation pre-fill (LibreTranslate) is on. */
  content_default_language: string;
  content_translation_enabled: boolean;
  /** First-login guided tour: already seen/dismissed once. */
  onboarding_tour_seen?: boolean;
  /** The user's seeded example room/set (null = missing or incomplete). */
  example_room_id?: number | null;
  example_set_id?: number | null;
}

export interface Room {
  id: number;
  code: string;
  title: LocalizedText;
  description: LocalizedText;
  show_logo_in_presentation: boolean;
  show_qr_in_presentation: boolean;
  show_code_in_presentation: boolean;
  presentation_corner: PresentationCorner;
  /** Sanitized HTML shown to participants once the vote is finished (#24). */
  closing_info: LocalizedText;
  is_favorite: boolean;
  is_archived: boolean;
  last_used_at: string | null;
  question_set_count: number;
  /** Number of question sets per set type, keyed by set type (#75). */
  set_type_counts: Record<SetType, number>;
  created_at: string;
  updated_at: string;
  created_by_name: string;
  updated_by_name: string;
  /** The Besitzer's display name; who may delete or hand over the room (#25). */
  owner_name: string;
  /** True when the current user is the room's Besitzer. */
  is_owner: boolean;
  /** True when the current user is a member (owner or added) of the room. */
  is_member: boolean;
  /** True when the room was created from an LMS via an LTI launch (M4). */
  is_lti: boolean;
  /** Number of owners — >1 means the room is shared. */
  owner_count: number;
}

export type PresentationCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type RevealAnswers = "immediately" | "after_close" | "never";

export interface QuestionSet {
  id: number;
  room: number;
  room_title: string;
  title: LocalizedText;
  description: LocalizedText;
  type: SetType;
  reveal_answers: RevealAnswers;
  open_on_show: boolean;
  quiz_time_limit: number | null;
  show_results_to_participants: boolean;
  present_results_after: boolean;
  allow_back_navigation: boolean;
  shuffle_questions: boolean;
  reveal_only_in_summary: boolean;
  share_token: string | null;
  self_check_token: string | null;
  license: string;
  license_holder: string;
  question_count: number;
  has_results: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoomOwner {
  id: number;
  username: string;
  name: string;
  is_self: boolean;
  /** True for the room's Besitzer (may delete / hand over). */
  is_owner: boolean;
}

/** A person the user already shares a room with — a re-add suggestion (#55). */
export interface Collaborator {
  id: number;
  username: string;
  name: string;
}

export interface SharedSet {
  title: string;
  description: string;
  license: string;
  license_holder: string;
  owners: string[];
  question_count: number;
  questions: { kind: QuestionKind; text: string }[];
}

export type QuestionKind =
  | "single_choice"
  | "multiple_choice"
  | "word_cloud"
  | "likert"
  | "open_text"
  | "priorities"
  | "ordering"
  | "mindmap";

/** One predefined branch of a mindmap question (plain canonical-language
 *  text; level 1 = child of the root). */
/** A predefined mindmap branch. `text`/`description` are `{de, en}` maps
 *  (a legacy plain string = canonical language is still accepted on save). */
export interface MindmapSeedNode {
  text: LocalizedText;
  description: LocalizedText;
  children: MindmapSeedNode[];
}

export interface AnswerOption {
  id?: number;
  text: LocalizedText;
  /** Relative /media/ URL of an optional option image (v2). */
  image?: string;
  is_correct: boolean;
  is_abstention?: boolean;
}

export interface Question {
  id: number;
  question_set: number;
  section: number | null;
  kind: QuestionKind;
  text: LocalizedText;
  shuffle_options: boolean;
  /** single_choice only: created via the binary Ja/Nein preset — the editor
   *  shows the Ja/Nein · Wahr/Falsch template quick-fill above two options (#79). */
  binary_choice: boolean;
  time_limit: number | null;
  position: number;
  options: AnswerOption[];
  /** open_text only: classify each answer live during the run. */
  ai_evaluate: boolean;
  evaluation_hint: string;
  /** open_text only: the scale the AI sorts answers into (2–5 labels). */
  evaluation_categories: string[];
  /** open_text only: show the category counts as a bar chart. */
  evaluation_chart: boolean;
  /** open_text only: optional model solution (Musterlösung) fed to the AI as
   *  the reference the answers are scored against. */
  model_solution: string;
  /** open_text only: also show each participant the AI verdict of their own
   *  answer on their device. */
  participant_feedback: boolean;
  /** word_cloud only: let each participant submit several terms (#14). */
  allow_multiple: boolean;
  /** word_cloud only: show the cloud on the beamer while the vote is open (#30). */
  wordcloud_live: boolean;
  /** word_cloud only: enable the AI cleanup/grouping views in the presenter. */
  wordcloud_ai_enabled: boolean;
  /** word_cloud only: optional AI grouping criteria (empty = auto themes). */
  wordcloud_grouping: string;
  /** open_text only: send the model solution along to the AI key
   *  statements/grouping (default on). */
  wordcloud_grouping_use_solution: boolean;
  /** word_cloud only: what the AI "Cleaned up" view merges — spelling
   *  variants/typos, synonyms/word forms, similar concepts. */
  wordcloud_merge_variants: boolean;
  wordcloud_merge_synonyms: boolean;
  wordcloud_merge_concepts: boolean;
  /** word_cloud: max terms per participant (0 = unlimited, 1 = single, #76/#88). */
  wordcloud_max_answers: number;
  /** word_cloud: collect several terms in fields and submit together (#88). */
  wordcloud_batch_submit: boolean;
  /** mindmap only: optional root label ({de,en}); empty = question text. */
  mindmap_root: LocalizedText;
  /** mindmap only: levels below the root participants may build (1–8). */
  mindmap_depth: number;
  /** mindmap only: terms per participant (0 = unlimited). */
  mindmap_max_per_person: number;
  /** mindmap only: participants add a title + optional description. */
  mindmap_descriptions: boolean;
  /** mindmap only: emphasise terms named by several people on the beamer. */
  mindmap_highlight_duplicates: boolean;
  /** mindmap only: predefined branches (not deletable by participants). */
  mindmap_seed: MindmapSeedNode[];
  /** mindmap only: optional rating phase after collecting ("" = off). */
  mindmap_rating_mode: MindmapRatingMode;
  /** mindmap only: points (points) or ratings (updown) per person (1–50). */
  mindmap_rating_budget: number;
  /** mindmap only, points: several points on one entry allowed. */
  mindmap_rating_multi: boolean;
  /** mindmap only: scores are shown live while rating (default: hidden
   *  until the results). */
  mindmap_rating_live: boolean;
  /** mindmap only: what "Optimise mind map" (AI, beamer) may do — merge
   *  duplicates, unify the language (rename into `mindmap_ai_target_lang`,
   *  "" = canonical content language) and restructure (new parent terms,
   *  moves). The AI switch itself is `wordcloud_ai_enabled`. */
  mindmap_ai_merge: boolean;
  mindmap_ai_translate: boolean;
  mindmap_ai_target_lang: "" | "de" | "en";
  mindmap_ai_restructure: boolean;
  /** Per-question reveal override; "inherit" uses the set default (#28). */
  reveal_answers: "inherit" | RevealAnswers;
  /** Before/after pair (#54): the before-question this one mirrors (null if
   *  standalone); the linked after-question id; and a convenience flag. */
  before_question: number | null;
  after_question: number | null;
  is_after: boolean;
  created_at: string;
  updated_at: string;
  /** Read-only: per-field language codes whose translation is outdated
   *  relative to the canonical language (#91), e.g. `{"text": ["en"]}`. */
  translation_stale?: Record<string, string[]>;
  /** Write-only: field names to record as back-in-sync using the values
   *  saved in this request (#91). */
  synced_fields?: string[];
}

/** A draft question proposed by the AI from a document (not yet saved). */
export interface GeneratedQuestion {
  kind: "single_choice" | "multiple_choice" | "open_text";
  text: string;
  /** True/False drafts come back as single_choice + this flag (#79). */
  binary_choice?: boolean;
  options: { text: string; is_correct: boolean }[];
  /** open_text only: AI-generated reference answer to score against. */
  model_solution?: string;
}

/** Async question generation job state. */
export interface GenerationJob {
  id: number;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  done_chunks: number;
  total_chunks: number;
  drafts: GeneratedQuestion[];
  truncated: boolean;
  source_chars: number;
  notice: string;
  error: string;
  pages: number;
  density: number;
  target_count: number;
  reviewed: boolean;
  /** Only present on the user-wide active-generation payload. */
  set_id?: number;
  set_title?: string;
}

/** Live free-text evaluation summary (presenter + stored results). The
 *  ``verdict`` is a category label from the question's chosen scale; groups
 *  come in the configured order. */
export interface FreeTextEvalSummary {
  groups: {
    verdict: string;
    count: number;
    items: { text: string; count: number }[];
  }[];
  categories: string[];
  chart: boolean;
  pending: number;
  total: number;
}

export interface Section {
  id: number;
  question_set: number;
  title: LocalizedText;
  position: number;
}

/** Diverging Likert aggregation (backend results.likert_summary). Percentages
 * are over the scale responses only; abstentions are reported separately. */
export interface LikertStep {
  id: number;
  text: LocalizedText;
  count: number;
  pct: number;
  polarity: "low" | "neutral" | "high";
}

export interface LikertSummary {
  scale_total: number;
  abstentions: number;
  high: number;
  high_pct: number;
  neutral: number;
  neutral_pct: number;
  low: number;
  low_pct: number;
  /** Centre-line position as a percentage (0–100) of the scale width. */
  divider: number;
  /** Mean scale position (0–100) aligned to the step columns, weighting each
   *  vote by how extreme its step is. */
  mean_pct: number;
  /** Centred mean score (0 = middle of the scale, negative = net-low). */
  mean_score: number;
  /** Text of the first/last scale step, used as the axis endpoint labels. */
  low_label: LocalizedText;
  high_label: LocalizedText;
  steps: LikertStep[];
}

/** Start-page keyword search across the user's rooms, sets and questions. */
export interface SearchResults {
  rooms: { id: number; code: string; title: string }[];
  sets: { id: number; title: string; room: number; room_title: string }[];
  questions: {
    id: number;
    text: string;
    kind: QuestionKind;
    question_set: number;
    set_title: string;
    room: number;
    room_title: string;
  }[];
}

/** Admin-configurable site content (common app). */
export interface SitePublic {
  landing_text: LocalizedText;
  /** Admin-switchable "Beta" badge in the management header. */
  beta_label_enabled: boolean;
  /** Optional notice shown when the badge is clicked (plain text). */
  beta_notice: LocalizedText;
  logo: string | null;
  /** AI privacy notice (#80): operator-authored, translatable; shown as a
   * one-time dismissible banner while AI is available. Empty = no banner. */
  ai_notice: LocalizedText;
  /** "More info" link: an internal content page (slug) takes precedence over
   * the external URL. */
  ai_notice_page: string | null;
  ai_notice_url: string;
}

export interface FooterPageLink {
  slug: string;
  title: LocalizedText;
}

export interface PageDetail {
  slug: string;
  title: LocalizedText;
  body: LocalizedText;
  updated_at: string;
}

export interface DataCollectionItem {
  category: string;
  data: string;
  purpose: string;
  legal_basis: string;
  retention: string;
}

export interface DataCollection {
  collected: DataCollectionItem[];
  not_collected: string[];
}

/** Admin usage statistics (staff-only). */
export interface DailyPoint {
  date: string;
  n: number;
}
export interface RunsByTypePoint {
  date: string;
  live_poll: number;
  self_paced: number;
  self_check: number;
}
export interface SessionsPoint {
  date: string;
  easy: number;
  pro: number;
}
/** Guided-tour usage aggregation (anonymous TourEvent counts). */
export interface TourStats {
  started: { easy: number; pro: number };
  completed: { easy: number; pro: number };
  aborted: { easy: number; pro: number };
  by_source: { welcome: number; help: number };
  aborted_at: { step: string; n: number }[];
  users_seen: number;
}
export interface TourPoint {
  date: string;
  started: number;
  completed: number;
}
/** Body of `POST /api/whoami/tour-event/` (anonymous, best-effort). */
export type TourEventPayload =
  | { kind: "started"; mode: "easy" | "pro"; source: "welcome" | "help" }
  | { kind: "completed"; mode: "easy" | "pro" }
  | { kind: "aborted"; mode: "easy" | "pro"; step: string };
export interface AdminStats {
  days: number;
  from: string;
  to: string;
  totals: {
    rooms: number;
    rooms_lti: number;
    users: number;
    sets_by_type: Record<string, number>;
    questions_by_kind: Record<string, number>;
    runs_by_type: Record<string, number>;
    participants: number;
    questions_run: number;
    sessions_by_mode: { easy: number; pro: number };
    tour: TourStats;
  };
  daily: {
    rooms: DailyPoint[];
    users: DailyPoint[];
    participants: DailyPoint[];
    questions_run: DailyPoint[];
    runs_by_type: RunsByTypePoint[];
    sessions_by_mode: SessionsPoint[];
    tour: TourPoint[];
  };
}

export interface ManageSite {
  landing_text: LocalizedText;
  /** Admin-switchable "Beta" badge in the management header. */
  beta_label_enabled: boolean;
  /** Optional notice shown when the badge is clicked (plain text). */
  beta_notice: LocalizedText;
  /** Sanitized HTML shown to participants on every room's closing screen (#24). */
  closing_info: LocalizedText;
  logo: string | null;
  ai_notice: LocalizedText;
  ai_notice_page: string | null;
  ai_notice_url: string;
  /** Self-check AI grading rate limit, per minute; 0 = unlimited (#75). */
  self_check_ai_per_minute: number;
}

export interface ManagePage {
  id: number;
  slug: string;
  title: LocalizedText;
  body: LocalizedText;
  is_published: boolean;
  show_in_footer: boolean;
  footer_order: number;
  updated_at: string;
}

export type ManagePageInput = Omit<ManagePage, "id" | "footer_order" | "updated_at">;

/** LTI 1.3 platform registration (M4): one row per LMS instance/deployment
 * that may launch into abstimmbar. Staff-only (accounts.IsAdmin). */
export interface LtiPlatform {
  id: number;
  name: string;
  issuer: string;
  client_id: string;
  auth_login_url: string;
  auth_token_url: string;
  key_set_url: string;
  deployment_ids: string[];
  /** If true, an LTI launch may link to an existing account by e-mail —
   * the LMS becomes the authority for that account match. */
  link_by_email: boolean;
  is_active: boolean;
}

/** This deployment's endpoints, to be entered in the LMS's tool registration. */
export interface LtiToolInfo {
  login_url: string;
  launch_url: string;
  jwks_url: string;
  icon_url: string;
}

interface Paginated<T> {
  count: number;
  results: T[];
}

/** CSRF token. `whoami` returns an authoritative token in its body (see the
 * backend note); we prefer it because reading the cookie from JS is
 * unreliable cross-origin in dev. Falls back to the (app-specific) cookie. */
let serverCsrfToken = "";

function csrfToken(): string {
  if (serverCsrfToken) return serverCsrfToken;
  return document.cookie.match(/(?:^|;\s*)abstimmbar_csrftoken=([^;]*)/)?.[1] ?? "";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    headers: {
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      "X-CSRFToken": csrfToken(),
      ...init.headers,
    },
    ...init,
  });
  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      /* keep status code */
    }
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export const api = {
  whoami: async () => {
    const who = await request<Whoami>("/api/whoami/");
    if (who.csrf_token) serverCsrfToken = who.csrf_token;
    return who;
  },

  // Remember the signed-in user's UI language (best-effort).
  setLanguage: (language: string) =>
    request<{ language: string }>("/api/whoami/language/", {
      method: "POST",
      body: JSON.stringify({ language }),
    }),

  setMode: (easyMode: boolean) =>
    request<{ easy_mode: boolean }>("/api/whoami/mode/", {
      method: "POST",
      body: JSON.stringify({ easy_mode: easyMode }),
    }),

  markTourSeen: () =>
    request<{ onboarding_tour_seen: boolean }>("/api/whoami/tour-seen/", {
      method: "POST",
    }),

  /** Anonymous guided-tour usage event (for the admin statistics). */
  trackTourEvent: (event: TourEventPayload) =>
    request<{ status: string }>("/api/whoami/tour-event/", {
      method: "POST",
      body: JSON.stringify(event),
    }),

  ensureExampleRoom: () =>
    request<{ example_room_id: number; example_set_id: number }>(
      "/api/whoami/example-room/", { method: "POST" },
    ),

  // --- site content (public reads) ---
  getSite: () => request<SitePublic>("/api/site/"),
  getFooterPages: () => request<FooterPageLink[]>("/api/pages/"),
  getPage: (slug: string) => request<PageDetail>(`/api/pages/${slug}/`),
  getDataCollection: () => request<DataCollection>("/api/data-collection/"),

  // --- site content (staff management) ---
  /** Admin usage statistics (staff-only). Pass `{days}` for a window ending
   *  today, or an explicit `{from, to}` ISO date range. */
  adminStats: (opts: { days?: number; from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.from) {
      params.set("from", opts.from);
      if (opts.to) params.set("to", opts.to);
    } else {
      params.set("days", String(opts.days ?? 30));
    }
    return request<AdminStats>(`/api/admin/stats/?${params.toString()}`);
  },
  getManageSite: () => request<ManageSite>("/api/manage/site/"),
  updateSite: (patch: Partial<{
    landing_text: LocalizedText;
    closing_info: LocalizedText;
    ai_notice: LocalizedText;
    beta_label_enabled: boolean;
    beta_notice: LocalizedText;
    ai_notice_page: string | null;
    ai_notice_url: string;
    self_check_ai_per_minute: number;
  }>) =>
    request<ManageSite>("/api/manage/site/", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  uploadLogo: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<ManageSite>("/api/manage/site/logo/", { method: "POST", body });
  },
  deleteLogo: () => request<void>("/api/manage/site/logo/", { method: "DELETE" }),
  listManagePages: () => request<ManagePage[]>("/api/manage/pages/"),
  createPage: (data: ManagePageInput) =>
    request<ManagePage>("/api/manage/pages/", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updatePage: (id: number, data: Partial<ManagePageInput>) =>
    request<ManagePage>(`/api/manage/pages/${id}/`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deletePage: (id: number) =>
    request<void>(`/api/manage/pages/${id}/`, { method: "DELETE" }),
  reorderPages: (order: number[]) =>
    request<void>("/api/manage/pages/reorder/", {
      method: "POST",
      body: JSON.stringify({ order }),
    }),

  // --- LTI 1.3 platforms (M4, staff management) ---
  listLtiPlatforms: () =>
    request<Paginated<LtiPlatform>>("/api/lti/platforms/?page_size=1000"),
  createLtiPlatform: (data: Omit<LtiPlatform, "id">) =>
    request<LtiPlatform>("/api/lti/platforms/", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateLtiPlatform: (id: number, data: Partial<LtiPlatform>) =>
    request<LtiPlatform>(`/api/lti/platforms/${id}/`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteLtiPlatform: (id: number) =>
    request<void>(`/api/lti/platforms/${id}/`, { method: "DELETE" }),
  getLtiToolInfo: () => request<LtiToolInfo>("/api/lti/tool-info/"),

  search: (query: string) =>
    request<SearchResults>(`/api/search/?q=${encodeURIComponent(query)}`),

  // The overview sorts + paginates client-side (favorites on top), so fetch
  // the full set in one go. `all` (staff only; ignored otherwise) requests
  // every room, not just the caller's own, for admin visibility.
  listRooms: (all?: boolean) =>
    request<Paginated<Room>>(`/api/rooms/?page_size=1000${all ? "&all=1" : ""}`),
  toggleRoomFavorite: (id: number, on: boolean) =>
    request<Room>(`/api/rooms/${id}/favorite/`, { method: on ? "POST" : "DELETE" }),
  listArchivedRooms: () =>
    request<Paginated<Room>>("/api/rooms/?archived=1&page_size=1000"),
  toggleRoomArchive: (id: number, on: boolean) =>
    request<Room>(`/api/rooms/${id}/archive/`, { method: on ? "POST" : "DELETE" }),
  getRoom: (id: number) => request<Room>(`/api/rooms/${id}/`),
  createRoom: (data: {
    title: LocalizedText;
    description?: LocalizedText;
    show_logo_in_presentation?: boolean;
    show_qr_in_presentation?: boolean;
    show_code_in_presentation?: boolean;
    presentation_corner?: PresentationCorner;
  }) =>
    request<Room>("/api/rooms/", { method: "POST", body: JSON.stringify(data) }),
  updateRoom: (id: number, data: Partial<Room>) =>
    request<Room>(`/api/rooms/${id}/`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteRoom: (id: number) =>
    request<void>(`/api/rooms/${id}/`, { method: "DELETE" }),
  listRoomOwners: (id: number) =>
    request<{ owners: RoomOwner[] }>(`/api/rooms/${id}/owners/`),
  /** People I already share a room with, most-frequent first (#55). */
  listCollaborators: () =>
    request<{ collaborators: Collaborator[] }>(`/api/rooms/collaborators/`),
  addRoomOwner: (id: number, user: string) =>
    request<{ owners: RoomOwner[] }>(`/api/rooms/${id}/owners/`, {
      method: "POST",
      body: JSON.stringify({ user }),
    }),
  removeRoomOwner: (id: number, userId: number) =>
    request<{ owners: RoomOwner[] }>(`/api/rooms/${id}/owners/${userId}/`, {
      method: "DELETE",
    }),
  /** Hand the room over to another owner (#26). */
  transferRoomOwner: (id: number, userId: number) =>
    request<{ owners: RoomOwner[] }>(`/api/rooms/${id}/transfer-owner/`, {
      method: "POST",
      body: JSON.stringify({ user: userId }),
    }),
  /** Leave a room shared with me (#26). */
  leaveRoom: (id: number) =>
    request<void>(`/api/rooms/${id}/leave/`, { method: "POST" }),

  listQuestionSets: (roomId: number, search = "") =>
    request<Paginated<QuestionSet>>(
      `/api/question-sets/?room=${roomId}&search=${encodeURIComponent(search)}`,
    ),
  duplicateQuestionSet: (id: number, data: { room?: number; title?: string }) =>
    request<QuestionSet>(`/api/question-sets/${id}/duplicate/`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  importQuestionSet: (roomId: number, data: unknown) =>
    request<QuestionSet>(`/api/rooms/${roomId}/import-set/`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getQuestionSet: (id: number) => request<QuestionSet>(`/api/question-sets/${id}/`),
  createQuestionSet: (
    data: {
      room: number;
      title?: LocalizedText;
      description?: LocalizedText;
      type?: SetType;
      reveal_answers?: RevealAnswers;
      open_on_show?: boolean;
      quiz_time_limit?: number | null;
      show_results_to_participants?: boolean;
      present_results_after?: boolean;
      allow_back_navigation?: boolean;
      shuffle_questions?: boolean;
      reveal_only_in_summary?: boolean;
    },
  ) =>
    request<QuestionSet>("/api/question-sets/", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateQuestionSet: (id: number, data: Partial<QuestionSet>) =>
    request<QuestionSet>(`/api/question-sets/${id}/`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteQuestionSet: (id: number) =>
    request<void>(`/api/question-sets/${id}/`, { method: "DELETE" }),
  reorderQuestions: (setId: number, questionIds: number[]) =>
    request<void>(`/api/question-sets/${setId}/reorder/`, {
      method: "POST",
      body: JSON.stringify({ question_ids: questionIds }),
    }),

  listSections: (setId: number) =>
    request<Paginated<Section>>(`/api/sections/?question_set=${setId}`),
  createSection: (setId: number, title: LocalizedText = "") =>
    request<Section>("/api/sections/", {
      method: "POST",
      body: JSON.stringify({ question_set: setId, title }),
    }),
  updateSection: (id: number, title: LocalizedText) =>
    request<Section>(`/api/sections/${id}/`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteSection: (id: number) =>
    request<void>(`/api/sections/${id}/`, { method: "DELETE" }),
  /** Persist the inline outline: sections + questions in one order.
   * Each item is {type: "section"|"question", id}. Section membership
   * follows the nearest header above each question. */
  reorderOutline: (
    setId: number,
    items: { type: "section" | "question"; id: number }[],
  ) =>
    request<void>(`/api/question-sets/${setId}/reorder-outline/`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),

  listQuestions: (setId: number) =>
    request<Paginated<Question>>(`/api/questions/?question_set=${setId}`),
  getQuestion: (id: number) => request<Question>(`/api/questions/${id}/`),
  createQuestion: (data: Omit<Partial<Question>, "id">) =>
    request<Question>("/api/questions/", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  /** Start async question generation from an uploaded document or pasted text. */
  aiGenerateStart: (
    setId: number,
    opts: {
      file?: File;
      text?: string;
      density: number;
      kinds: string[];
      /** Subset of `kinds` to emphasise (soft priority in the AI prompt). */
      focus?: string[];
      level: string;
      guidance?: string;
    },
  ) => {
    const body = new FormData();
    if (opts.file) body.append("file", opts.file);
    if (opts.text) body.append("text", opts.text);
    body.append("density", String(opts.density));
    body.append("kinds", opts.kinds.join(","));
    if (opts.focus && opts.focus.length) body.append("focus", opts.focus.join(","));
    body.append("level", opts.level);
    if (opts.guidance?.trim()) body.append("guidance", opts.guidance.trim());
    return request<{ job_id: number }>(
      `/api/question-sets/${setId}/ai-generate/`,
      { method: "POST", body },
    );
  },
  /** The current user's most relevant generation job across all sets (running
   *  first, then unreviewed done/failed), or {} — for the app-wide status bar. */
  aiGenerateActiveForUser: () =>
    request<GenerationJob | Record<string, never>>(
      `/api/question-sets/active-generation/`,
    ),
  /** Mark a job reviewed (imported or discarded) so bar/hint stop showing it. */
  aiGenerateReviewed: (setId: number, jobId: number) =>
    request<{ status: string }>(
      `/api/question-sets/${setId}/ai-generate/jobs/${jobId}/reviewed/`,
      { method: "POST" },
    ),
  /** Get a specific async question generation job by id. */
  aiGenerateJob: (setId: number, jobId: number) =>
    request<GenerationJob>(
      `/api/question-sets/${setId}/ai-generate/jobs/${jobId}/`,
    ),
  /** Get the active async question generation job for a question set, if any. */
  aiGenerateActive: (setId: number) =>
    request<GenerationJob | Record<string, never>>(
      `/api/question-sets/${setId}/ai-generate/active/`,
    ),
  /** Cancel an async question generation job. */
  aiGenerateCancel: (setId: number, jobId: number) =>
    request<{ status: string }>(
      `/api/question-sets/${setId}/ai-generate/jobs/${jobId}/cancel/`,
      { method: "POST" },
    ),
  updateQuestion: (id: number, data: Partial<Question>) =>
    request<Question>(`/api/questions/${id}/`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteQuestion: (id: number) =>
    request<void>(`/api/questions/${id}/`, { method: "DELETE" }),
  /** Create a locked after-question mirroring this one (#54). */
  addAfterQuestion: (id: number) =>
    request<Question>(`/api/questions/${id}/add-after/`, { method: "POST" }),
  moveQuestion: (id: number, questionSet: number) =>
    request<{ status: string; question_set: number }>(
      `/api/questions/${id}/move/`,
      { method: "POST", body: JSON.stringify({ question_set: questionSet }) },
    ),
  /** Copy questions (from any set the user owns) into set `setId`, appended
   * at the end in the given order (#87). */
  copyQuestions: (setId: number, questionIds: number[]) =>
    request<{ copied: number }>(`/api/question-sets/${setId}/copy-questions/`, {
      method: "POST",
      body: JSON.stringify({ question_ids: questionIds }),
    }),
  aiDistractors: (
    id: number,
    payload: { text: string; options: { text: string; is_correct: boolean }[]; count?: number },
  ) =>
    request<{ distractors: string[] }>(`/api/questions/${id}/ai-distractors/`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  aiRephrase: (id: number, text: string) =>
    request<{ variants: string[] }>(`/api/questions/${id}/ai-rephrase/`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  /** Same as `aiDistractors`, but for a question still being created (no
   * saved id yet) — scoped to the question set instead. */
  aiDistractorsForSet: (
    setId: number,
    payload: { text: string; options: { text: string; is_correct: boolean }[]; count?: number },
  ) =>
    request<{ distractors: string[] }>(
      `/api/question-sets/${setId}/ai-distractors/`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  /** Same as `aiRephrase`, but for a question still being created (no saved
   * id yet) — scoped to the question set instead. */
  aiRephraseForSet: (setId: number, text: string) =>
    request<{ variants: string[] }>(
      `/api/question-sets/${setId}/ai-rephrase/`,
      { method: "POST", body: JSON.stringify({ text }) },
    ),
  /** All of the user's sets (move target picker) — no room filter. */
  listAllQuestionSets: () =>
    request<Paginated<QuestionSet>>("/api/question-sets/"),

  shareQuestionSet: (id: number, enabled: boolean) =>
    request<{ share_token: string | null }>(`/api/question-sets/${id}/share/`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  getSharedSet: (token: string) => request<SharedSet>(`/api/shared/${token}/`),
  copySharedSet: (token: string, room: number) =>
    request<{ id: number; room: number; title: string }>(
      `/api/shared/${token}/copy/`,
      { method: "POST", body: JSON.stringify({ room }) },
    ),

  uploadImage: (file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<{ id: number; url: string }>("/api/images/", {
      method: "POST",
      body,
    });
  },

  /** Optional machine-translation pre-fill (LibreTranslate, #33 MR2 Phase 4);
   * 503 if the backend has no provider configured (checked via
   * `isTranslationEnabled()` before offering this in the UI). */
  translate: (text: string, source: string, target: string, format: "text" | "html" = "text") =>
    request<{ translated: string }>("/api/translate/", {
      method: "POST",
      body: JSON.stringify({ text, source, target, format }),
    }),
};

// --- live / presenter -------------------------------------------------------

export interface LiveOption {
  id: number;
  text: LocalizedText;
  image?: string;
  is_correct?: boolean;
  is_abstention?: boolean;
  count?: number;
  /** Recording mode (#53): the on-site vs recording-viewer split. */
  onsite?: number;
  recording?: number;
}

export interface LiveState {
  room: {
    code: string;
    title: LocalizedText;
    show_logo?: boolean;
    show_qr?: boolean;
    show_code?: boolean;
    corner?: PresentationCorner;
  };
  phase: "idle" | "lobby" | "preview" | "open" | "closed" | "results" | "finished";
  mode?: "live" | "self_paced";
  set_title?: LocalizedText;
  run_id?: number;
  /** Self-paced dashboard: per-question vote counts. */
  progress?: { id: number; text: LocalizedText; votes: number }[];
  votes_total?: number;
  reveal_answers?: RevealAnswers;
  revealed?: boolean;
  ends_at?: string;
  participants?: number;
  /** Recording mode (#53): the run's deep-link token (present when recording
   *  is on), so the beamer can show the per-question QR. */
  recording_token?: string;
  votes?: number;
  question?: {
    id: number;
    kind: QuestionKind;
    text: LocalizedText;
    multiple: boolean;
    allow_multiple?: boolean;
    wordcloud_batch_submit?: boolean;
    wordcloud_live?: boolean;
    wordcloud_ai_enabled?: boolean;
    /** The question's saved AI grouping instruction (empty = AI clusters freely). */
    wordcloud_grouping?: string;
    /** open_text: send the model solution along to the AI grouping. */
    wordcloud_grouping_use_solution?: boolean;
    /** open_text, presenter only: the question's model solution (plain). */
    model_solution?: string;
    /** What the AI "Cleaned up" view merges (saved on the question). */
    wordcloud_merge_variants?: boolean;
    wordcloud_merge_synonyms?: boolean;
    wordcloud_merge_concepts?: boolean;
    /** mindmap, presenter only: the AI optimisation settings
     *  (`target_lang` already resolved to a language code). */
    mindmap_ai?: MindmapAiSettings;
    options: LiveOption[];
  };
  results?: LiveOption[];
  /** Priorities (#58): per-option avg/min/max in the presenter snapshot. */
  priorities?: PriorityStat[];
  /** Ordering (#72): per-item correct-position rate in the presenter snapshot. */
  ordering?: OrderingResults;
  likert?: LikertSummary;
  /** Before/after pair (#54): for an after-question, the before-question's
   *  aggregates from the same run, so the beamer shows the comparison. */
  before?: {
    votes: number;
    results?: LiveOption[];
    likert?: LikertSummary;
  };
  /** Moderated terms/answers; `keys` = the casefold moderation keys each
   *  entry stands for (word cloud and free text). */
  words?: { text: string; count: number; keys?: string[]; variants?: string[]; merged?: boolean }[];
  evaluation?: FreeTextEvalSummary;
  /** Live AI views while the presenter shows one: word cloud consolidated +
   *  grouped (#Wortwolke-KI); free text key statements (`merged`) + grouped. */
  wordcloud_ai?: WordCloudAI;
  /** Presenter-side moderation state (hidden terms, manual merges, #Wortwolke). */
  wordcloud_moderation?: WordCloudModeration;
  /** Mindmap: the shared tree (presenter form incl. hidden nodes). */
  mindmap?: LiveMindmap;
}

/** One node of the live mind map. `hidden` is only sent to the presenter and
 *  set only on the explicitly hidden node — its subtree counts as hidden too. */
export interface LiveMindmapNode {
  id: number;
  text: string;
  /** Casefolded merge key (duplicate highlighting across parents). Presenter
   *  payload only — absent in participant and results trees. */
  key?: string;
  count: number;
  /** Up to 3 descriptions ([] when descriptions are off). */
  descriptions: string[];
  seeded: boolean;
  /** Added by the presenter (only present when true). */
  teacher?: boolean;
  /** Seeded nodes: the term in all languages (`text` = canonical). Resolve
   *  via `mindmapNodeText`. */
  text_i18n?: LocalizedText;
  /** Seeded nodes whose first description is the predefined one: that
   *  description in all languages (`descriptions[0]` = canonical). */
  description_i18n?: LocalizedText;
  hidden?: boolean;
  /** AI preview marks (only in an `ai-optimize`/`ai-preview` tree): target of
   *  a merge (the merged terms), old name, moved here, new parent term
   *  (negative id). */
  merged_from?: string[];
  renamed_from?: string;
  moved?: boolean;
  new?: boolean;
  children: LiveMindmapNode[];
}

export interface MindmapAiSettings {
  merge: boolean;
  translate: boolean;
  target_lang: "" | "de" | "en";
  restructure: boolean;
}

/** One proposed AI operation of a mind-map optimisation. `index` is the
 *  stable id for the selection; `requires` = the indices of the new parent
 *  terms (adds) it builds on, transitively. Node fields carry an id or the
 *  temp ref of an add ("n1"). */
export interface MindmapAiOp {
  index: number;
  type: "merge" | "rename" | "move" | "add";
  label: string;
  reason: string;
  requires: number[];
  source?: number | string;
  target?: number | string;
  node?: number | string;
  parent?: number | string | null;
  text?: string;
  source_text?: string;
  target_text?: string;
  old_text?: string;
  node_text?: string;
  parent_text?: string | null;
  old_parent_text?: string | null;
  ref?: string;
}

/** A simulated AI proposal: the checklist, the preview tree for the current
 *  selection (`active` = indices it contains) and how many entries fell out. */
export interface MindmapAiSimulation {
  ops: MindmapAiOp[];
  dropped: number;
  preview: LiveMindmap;
  active: number[];
}

/** Undo data of an applied batch — passed back verbatim to `ai-undo`. */
export type MindmapAiUndo = { type: string; data: unknown }[];

export type MindmapRatingMode = "" | "points" | "updown";

/** Aggregated rating of one node (only rated visible nodes are keys). */
export type MindmapScore =
  | { points: number }
  | { up: number; down: number; balance: number };

/** Rating phase of a mindmap question (present only with a rating mode).
 *  Presenter: `scores` only while rating with `live` on, or in the results
 *  phase (reveal). Results: always with `scores` (+ `ranking`). */
export interface MindmapRating {
  mode: "points" | "updown";
  budget: number;
  multi: boolean;
  live: boolean;
  /** Absent in results. */
  stage?: "collect" | "rate";
  /** Distinct participants with at least one rating (visible nodes). */
  raters: number;
  scores?: Record<string, MindmapScore>;
  /** Results only: a hidden rating is still running — no scores/ranking yet. */
  rating_in_progress?: boolean;
}

export interface LiveMindmap {
  root: { label: LocalizedText };
  depth: number;
  max_per_person: number;
  descriptions: boolean;
  highlight_duplicates: boolean;
  max_nodes: number;
  total: number;
  nodes: LiveMindmapNode[];
  rating?: MindmapRating;
}

export interface WordCloudWord {
  text: string;
  count: number;
  variants: string[];
  keys: string[];
  merged: boolean;
}

/** Presenter-side moderation state for a word cloud (#Wortwolke): terms hidden
 *  from the live view and manual merges (grouping several keys under one
 *  label), independent of the AI cleanup view. */
export interface WordCloudModeration {
  hidden: { key: string }[];
  merges: { keys: string[]; label: string }[];
}

/** A word of the AI views: `keys` are the raw casefold terms it stands for. */
export interface WordCloudAIWord {
  text: string;
  count: number;
  variants?: string[];
  keys?: string[];
}

export interface WordCloudAI {
  merged: WordCloudAIWord[];
  clusters: { label: string; count: number; words: WordCloudAIWord[] }[];
  pending: boolean;
  /** True when the last AI computation failed (live free-text summary). */
  error?: boolean;
  /** Increases with every finished computation (also identical / failed). */
  seq?: number;
}

/** Priorities question aggregation (#58): per-option average/min/max points
 *  over all submissions, plus the number of submissions scoring it. */
export interface PriorityStat {
  id: number;
  text: LocalizedText;
  image?: string;
  avg: number;
  min: number;
  max: number;
  n: number;
}

/** Ordering question aggregation (#72): per-item correct-position rate over
 *  all submissions, plus the full-sequence-correct rate. */
export interface OrderingItem {
  id: number;
  text: LocalizedText;
  image?: string;
  correct_position: number;
  correct_rate: number;
  n: number;
}

export interface OrderingLink {
  from: number;
  to: number;
  rate: number;
}

export interface OrderingChain {
  start: number;
  end: number;
  rate: number;
}

export interface OrderingResults {
  items: OrderingItem[];
  full_correct_rate: number;
  n: number;
  links: OrderingLink[];
  chains: OrderingChain[];
}

export interface RunResults {
  run: number;
  phase: string;
  created_at: string;
  first_opened_at: string | null;
  ended_at: string | null;
  votes_total: number;
  /** Recording mode (#53): total async votes in the run; the split is shown
   *  only when > 0. */
  recording_votes: number;
  questions: {
    id: number;
    position: number;
    kind: QuestionKind;
    text: LocalizedText;
    votes: number;
    /** Recording mode (#53): how many of this question's votes are async. */
    votes_recording: number;
    /** Before/after pair (#54): the before-question id this one mirrors. */
    before_question: number | null;
    options?: LiveOption[];
    likert?: LikertSummary;
    words?: { text: string; count: number; onsite?: number; recording?: number; keys?: string[] }[];
    evaluation?: FreeTextEvalSummary;
    /** Priorities (#58): per-option avg/min/max/n. */
    priorities?: PriorityStat[];
    ordering?: OrderingResults;
    /** Mindmap: visible tree (hidden nodes already excluded). */
    mindmap?: LiveMindmap;
  }[];
}

export interface WordCloudCluster {
  label: string;
  count: number;
  words: { text: string; count: number; variants: string[]; keys?: string[] }[];
}

export interface WordCloudOptimization {
  clusters: WordCloudCluster[];
  merged: { text: string; count: number; variants: string[]; keys?: string[] }[];
}

export interface FreeTextEvaluation {
  groups: {
    verdict: string;
    count: number;
    items: { text: string; count: number; note: string }[];
  }[];
  categories?: string[];
  chart?: boolean;
}

export const results = {
  list: (setId: number) =>
    request<{ results: RunResults[] }>(`/api/question-sets/${setId}/results/`),
  /** Optional AI short report (sanitized HTML) summarising one run's results. */
  summarize: (runId: number) =>
    request<{ report: string }>(`/api/runs/${runId}/ai-summary/`, {
      method: "POST",
    }),
  /** Optional AI cleanup of a word-cloud result (merge variants, cluster). */
  optimizeWordCloud: (runId: number, questionId: number) =>
    request<WordCloudOptimization>(
      `/api/runs/${runId}/questions/${questionId}/ai-wordcloud/`,
      { method: "POST" },
    ),
  /** One-shot AI key statements (+ grouping) of a free-text question of a
   *  finished run (Quiz-Block walkthrough); same shape as the live result. */
  freeTextSummary: (runId: number, questionId: number) =>
    request<WordCloudOptimization>(
      `/api/runs/${runId}/questions/${questionId}/ai-summary/`,
      { method: "POST" },
    ),
  /** Optional AI evaluation of free-text answers (korrekt/unklar/falsch). */
  evaluateFreeText: (runId: number, questionId: number, reference: string) =>
    request<FreeTextEvaluation>(
      `/api/runs/${runId}/questions/${questionId}/ai-freetext/`,
      { method: "POST", body: JSON.stringify({ reference }) },
    ),
  deleteRun: (runId: number) =>
    request<void>(`/api/runs/${runId}/`, { method: "DELETE" }),
  deleteAll: (setId: number) =>
    request<{ status: string }>(`/api/question-sets/${setId}/delete-results/`, {
      method: "POST",
    }),
  /** Archive current results and prepare a fresh run (#27). */
  archive: (setId: number) =>
    request<{ run: number }>(`/api/question-sets/${setId}/archive-results/`, {
      method: "POST",
    }),
  csvUrl: (setId: number, runId?: number) =>
    `${API_BASE_URL}/api/question-sets/${setId}/results.csv` +
    (runId ? `?run=${runId}` : ""),
  exportUrl: (setId: number) => `${API_BASE_URL}/api/question-sets/${setId}/export/`,
};

export const selfCheck = {
  publish: (setId: number) =>
    request<{ self_check_token: string }>(
      `/api/question-sets/${setId}/self-check/publish/`,
      { method: "POST" },
    ),
  unpublish: (setId: number) =>
    request<{ self_check_token: null }>(
      `/api/question-sets/${setId}/self-check/unpublish/`,
      { method: "POST" },
    ),
  stats: (setId: number) =>
    request<{ attempts: number; correct: number; scored: number; ratio: number | null }>(
      `/api/question-sets/${setId}/self-check/stats/`,
    ),
  resetStats: (setId: number) =>
    request<unknown>(`/api/question-sets/${setId}/self-check/stats/`, {
      method: "DELETE",
    }),
  url: (token: string, questionId?: number) =>
    `${API_BASE_URL}/c/${token}/${questionId ? `?q=${questionId}` : ""}`,
  qrUrl: (token: string, questionId?: number) =>
    `${API_BASE_URL}/c/${token}/qr.png${questionId ? `?q=${questionId}` : ""}`,
};

export const live = {
  status: (setId: number) =>
    request<{
      active_run: number | null;
      has_votes: boolean;
      active_run_has_votes: boolean;
      recently_started: boolean;
      room_code: string;
    }>(`/api/question-sets/${setId}/live-status/`),
  startRun: (
    setId: number,
    existing?: "continue" | "delete" | "archive",
    mode: "live" | "self_paced" = "live",
    recording = false,
  ) =>
    request<{ run: number; room_code: string; recording_token: string | null }>(
      `/api/question-sets/${setId}/start-run/`,
      {
        method: "POST",
        body: JSON.stringify({
          mode,
          ...(existing === undefined ? {} : { existing }),
          ...(recording ? { recording: true } : {}),
        }),
      },
    ),
  control: (
    runId: number,
    data: { phase?: string; question?: number | null; reveal?: boolean; recording?: boolean },
  ) =>
    request<{ status: string; phase?: string; recording_token?: string }>(
      `/api/runs/${runId}/control/`,
      { method: "POST", body: JSON.stringify(data) },
    ),
  /** Toggle the live AI word-cloud view (consolidate/group) for a question. */
  wordcloudAi: (runId: number, questionId: number, active: boolean) =>
    request<{ status: string; active: boolean }>(
      `/api/runs/${runId}/wordcloud-ai/`,
      { method: "POST", body: JSON.stringify({ question: questionId, active }) },
    ),
  /** Presenter mindmap moderation: hide a node with its subtree, or show it again. */
  mindmapHide: (runId: number, questionId: number, node: number, hidden: boolean) =>
    request<{ status: string; node: number; hidden: boolean }>(
      `/api/runs/${runId}/mindmap/${questionId}/hide`,
      { method: "POST", body: JSON.stringify({ node, hidden }) },
    ),
  /** Presenter switches the mindmap stage (collect / rate); `open` also
   *  opens the vote in the same request (one broadcast, no flash). */
  mindmapStage: (runId: number, questionId: number, stage: "collect" | "rate", open = false) =>
    request<{ stage: "collect" | "rate"; phase: string }>(
      `/api/runs/${runId}/mindmap/${questionId}/stage`,
      { method: "POST", body: JSON.stringify({ stage, open }) },
    ),
  /** Presenter adds a term (`parent` null = main branch). `merged`: the term
   *  already existed there — nothing was added. */
  mindmapAdd: (
    runId: number,
    questionId: number,
    body: { parent: number | null; text: string; description?: string },
  ) =>
    request<{ node_id: number; merged: boolean }>(
      `/api/runs/${runId}/mindmap/${questionId}/add`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Deletes a presenter-added leaf without contributions (undo of an add). */
  mindmapDelete: (runId: number, questionId: number, node: number) =>
    request<{ status: string }>(`/api/runs/${runId}/mindmap/${questionId}/delete`, {
      method: "POST",
      body: JSON.stringify({ node }),
    }),
  /** Merges `source` (with its subtree) into `target`; `undo` is opaque. */
  mindmapMerge: (runId: number, questionId: number, source: number, target: number) =>
    request<{ undo: string }>(`/api/runs/${runId}/mindmap/${questionId}/merge`, {
      method: "POST",
      body: JSON.stringify({ source, target }),
    }),
  /** Reverts a merge or rename (409 when the map changed in between). */
  mindmapUnmerge: (runId: number, questionId: number, undo: string) =>
    request<{ status: string }>(`/api/runs/${runId}/mindmap/${questionId}/unmerge`, {
      method: "POST",
      body: JSON.stringify({ undo }),
    }),
  /** Re-attaches `node` below `parent` (null = main branch). */
  mindmapMove: (runId: number, questionId: number, node: number, parent: number | null) =>
    request<{ undo: { node: number; parent: number | null } }>(
      `/api/runs/${runId}/mindmap/${questionId}/move`,
      { method: "POST", body: JSON.stringify({ node, parent }) },
    ),
  /** Renames a term; a name clash with a sibling merges it into that sibling
   *  (`merged`, `node_id` = the sibling). Undo either way via `mindmapUnmerge`. */
  mindmapRename: (runId: number, questionId: number, node: number, text: string) =>
    request<{ node_id: number; merged: boolean; undo: string }>(
      `/api/runs/${runId}/mindmap/${questionId}/rename`,
      { method: "POST", body: JSON.stringify({ node, text }) },
    ),
  /** AI optimisation proposal of the live mind map (no change yet). The
   *  optional settings are saved on the question. 503 AI off, 400 switch
   *  off / < 3 terms, 409 rating, 502 AI error. */
  mindmapAiOptimize: (runId: number, questionId: number, settings: Partial<MindmapAiSettings>) =>
    request<MindmapAiSimulation & { proposal: string; settings: MindmapAiSettings }>(
      `/api/runs/${runId}/mindmap/${questionId}/ai-optimize`,
      { method: "POST", body: JSON.stringify(settings) },
    ),
  /** Re-simulates a proposal for a selection (no LLM call, no change). */
  mindmapAiPreview: (runId: number, questionId: number, proposal: string, selected: number[]) =>
    request<MindmapAiSimulation>(`/api/runs/${runId}/mindmap/${questionId}/ai-preview`, {
      method: "POST",
      body: JSON.stringify({ proposal, selected }),
    }),
  /** Applies the selected proposal entries as one batch. */
  mindmapAiApply: (runId: number, questionId: number, proposal: string, selected: number[]) =>
    request<{ applied: number; skipped: number; undo: MindmapAiUndo }>(
      `/api/runs/${runId}/mindmap/${questionId}/ai-apply`,
      { method: "POST", body: JSON.stringify({ proposal, selected }) },
    ),
  /** Reverts an applied batch (409 when the map changed in between). */
  mindmapAiUndo: (runId: number, questionId: number, undo: MindmapAiUndo) =>
    request<{ status: string }>(`/api/runs/${runId}/mindmap/${questionId}/ai-undo`, {
      method: "POST",
      body: JSON.stringify({ undo }),
    }),
  /** Presenter word-cloud moderation (#Wortwolke): hide/unhide a term, merge
   *  several keys under one label, unmerge, or rename a merge's label. */
  wordcloudModeration: (
    runId: number,
    questionId: number,
    body: { op: "hide" | "unhide" | "merge" | "unmerge" | "rename"; keys?: string[]; label?: string },
  ) =>
    request<{ status: string }>(
      `/api/runs/${runId}/wordcloud/${questionId}/moderation`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Presenter edits a word cloud's permanent AI settings (saved on the
   *  question): switch the AI views on/off and/or change the grouping
   *  instruction and/or the "Cleaned up" merge switches (`regroup` forces a
   *  recompute of an existing AI result even with unchanged settings). 409
   *  when the AI provider is off, 400 when too long / not a bool. */
  wordcloudAiSettings: (
    runId: number,
    questionId: number,
    body: {
      ai_enabled?: boolean;
      grouping?: string;
      merge_variants?: boolean;
      merge_synonyms?: boolean;
      merge_concepts?: boolean;
      grouping_use_solution?: boolean;
      regroup?: boolean;
    },
  ) =>
    request<{
      ai_enabled: boolean;
      grouping: string;
      merge_variants: boolean;
      merge_synonyms: boolean;
      merge_concepts: boolean;
      grouping_use_solution: boolean;
      /** Results with a higher `WordCloudAI.seq` reflect these settings. */
      ai_seq: number;
    }>(
      `/api/runs/${runId}/wordcloud/${questionId}/ai-settings`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  streamUrl: (code: string) =>
    `${API_BASE_URL}/api/live/rooms/${code}/stream/?role=presenter`,
  participantUrl: (code: string) => `${API_BASE_URL}/p/${code}/`,
  /** Just the server name participants type into their browser (no /p/<code>
   *  path) — for the beamer join hint, where the room code is shown separately.
   *  Resolved against the current page so it works same-origin (prod) and
   *  cross-origin (dev). */
  participantHost: (code: string) =>
    new URL(live.participantUrl(code), window.location.href).host,
  qrUrl: (code: string) => `${API_BASE_URL}/p/${code}/qr.png`,
  /** Recording mode (#53): per-question deep-link QR for the beamer. */
  recordingQrUrl: (token: string, questionId: number) =>
    `${API_BASE_URL}/r/${token}/qr.png?q=${questionId}`,
};

export const loginUrl = `${API_BASE_URL}/oidc/authenticate/`;
/** Silent SSO (prompt=none): logs the visitor in automatically if the IdP
 * already has a session, otherwise bounces back to "/?sso=failed" (#19). */
export const silentLoginUrl = `${API_BASE_URL}/oidc/silent/`;
export const logoutUrl = `${API_BASE_URL}/oidc/logout-redirect/`;
