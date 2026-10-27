// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Guided-tour step data (#onboarding). One concept per step. Titles/bodies are
 *  English source strings used directly as i18next keys (German lives in
 *  de/translation.json). Targets are `data-tour` values; a null target renders
 *  a centered, element-less popover.
 *
 *  v3: the tour is a deterministic walkthrough of the user's seeded example
 *  room (one step per question type). It never creates content — the only
 *  write is re-creating a missing example room (RESTORE_STEP).
 *
 *  v4: steps belong to sections (header "<Section> · n of m", "Skip
 *  section"); Back walks the controller's history of shown steps. */

import type { QuestionKind } from "../api";
import type { TourSignal } from "./signals";

export type TourMode = "easy" | "pro";
export type StepKind = "info" | "action";

/** A milestone is resolved by the controller — route/present against the
 *  react-router location, element against the DOM. */
export type Milestone =
  | { type: "route"; pattern: string } // e.g. "/rooms/:id", "/sets/:id"
  | { type: "present" } // "/sets/:setId/present" reached
  | { type: "element"; anchor: string }; // a `[data-tour="<anchor>"]` element appears

/** Where the controller navigates before showing a step. All example targets
 *  resolve by id (whoami's example_room_id / example_set_id); a target that
 *  can't be resolved (ids missing, or no question of that kind) skips the step.
 *  - roomsHome          → the rooms overview ("/")
 *  - exampleRoom        → /rooms/<example room>
 *  - exampleSet         → /sets/<example set>
 *  - exampleSetPresent  → /sets/<example set>/present?resume=archive
 *  - exampleSetResults  → /sets/<example set>/results
 *  - exampleQuestion    → /sets/<example set>/questions/<first question of that kind> */
export type NavigateTarget =
  | "roomsHome"
  | "exampleRoom"
  | "exampleSet"
  | "exampleSetPresent"
  | "exampleSetResults"
  | { kind: "exampleQuestion"; questionKind: QuestionKind };

export type TourPage = "rooms" | "room" | "set" | "question" | "present" | "results";

/** Exact route pattern per page (react-router `matchPath`, end=true). A tour
 *  can start in context on any of these; unknown routes start from "/". */
export const PAGE_PATTERNS: Record<TourPage, string> = {
  rooms: "/",
  room: "/rooms/:id",
  set: "/sets/:id",
  question: "/sets/:id/questions/:qid",
  present: "/sets/:id/present",
  results: "/sets/:id/results",
};

/** What "Next" does on an action step: achieve the step's outcome through the
 *  app's own APIs (never simulated clicks). */
export type AutoPerform = { kind: "restoreExample" };

/** Sections group the steps (popover header "<Section> · n of m", "Skip
 *  section"). The restore and final steps have none. */
export type TourSection = "rooms" | "sets" | "types" | "present" | "results";

/** English source labels (i18next keys) of the sections. */
export const SECTION_LABELS: Record<TourSection, string> = {
  rooms: "Rooms",
  sets: "Question sets",
  types: "Question types",
  present: "Presenting",
  results: "Results",
};

/** A sentence appended to a step's body when it applies to this run (mode /
 *  AI) — keeps each sentence a separate, translatable key. */
export interface BodyExtra {
  key: string;
  modes?: TourMode[];
  requiresAi?: boolean;
}

export interface TourStep {
  id: string;
  /** data-tour value to spotlight, or null for a centered modal-style step. */
  target: string | null;
  titleKey: string; // English source string (i18next key)
  bodyKey: string;
  kind: StepKind;
  /** action steps: advance when this milestone is met. */
  milestone?: Milestone;
  /** Only include this step in these modes (default: both). */
  modes?: TourMode[];
  /** Drop this step unless AI is enabled for the deployment/user — its target
   *  (e.g. the AI-generate shortcut) is only rendered when AI is on, so keeping
   *  it on an AI-off deployment would dead-end the tour at a missing element. */
  requiresAi?: boolean;
  /** Before showing, the controller navigates here. */
  navigateTo?: NavigateTarget;
  /** The page this step lives on (context-aware start + pause re-sync). */
  page?: TourPage;
  /** Action steps: what "Next" performs for the user. */
  autoPerform?: AutoPerform;
  /** Info step whose copy invites a click that opens something OUTSIDE the
   *  spotlight (a menu): keep the page clickable instead of driver's inert
   *  overlay, so the invited action actually works. */
  interactive?: boolean;
  /** Preferred popover side (driver.js), e.g. to keep a menu that opens below
   *  the target uncovered. */
  side?: "top" | "right" | "bottom" | "left";
  /** Emitted before the step is shown (and re-emitted while its target is
   *  awaited) so the page puts itself into the needed state — see signals.ts. */
  signal?: TourSignal;
  /** The target only exists with data (e.g. more than one run): if it doesn't
   *  appear shortly, skip the step instead of pausing the tour. */
  optional?: boolean;
  /** Section the step belongs to (assigned via `inSection`). */
  section?: TourSection;
  /** Sentences appended to the body for some modes / with AI. */
  bodyExtras?: BodyExtra[];
}

/** One walkthrough step per question kind, on that kind's example question. */
const q = (
  k: QuestionKind,
  titleKey: string,
  bodyKey: string,
  bodyExtras?: BodyExtra[],
): TourStep => ({
  id: `q.${k}`,
  page: "question",
  target: "question.editor",
  kind: "info",
  navigateTo: { kind: "exampleQuestion", questionKind: k },
  titleKey,
  bodyKey,
  ...(bodyExtras ? { bodyExtras } : {}),
});

const inSection = (section: TourSection, steps: TourStep[]): TourStep[] =>
  steps.map((s) => ({ ...s, section }));

/** AI features in the editor/presenter are Expert-only (QuestionPage:
 *  `ai_enabled && !easyMode`). */
const PRO_AI = { modes: ["pro"] as TourMode[], requiresAi: true };

/** Prepended by the controller when the example room (or its set) is missing:
 *  "Next" re-creates it (idempotent POST /api/whoami/example-room/), then the
 *  regular tour starts. */
export const RESTORE_STEP: TourStep = {
  id: "example.restore",
  page: "rooms",
  target: null,
  kind: "action",
  autoPerform: { kind: "restoreExample" },
  titleKey: "Your example room is missing",
  bodyKey: "Click Next and we’ll recreate it — the tour continues right after.",
};

export const proTour: TourStep[] = [
  ...inSection("rooms", [
  { id: "header.mode", page: "rooms", target: "header.mode", kind: "info",
    titleKey: "Simple or Expert", bodyKey: "Switch modes up here — Expert shows every option." },
  { id: "rooms.list", page: "rooms", target: "rooms.list", kind: "info",
    titleKey: "Your rooms",
    bodyKey: "You’ll create your own rooms here with ‘New room’ — for now we’ll use the example room the system set up for you." },
  { id: "rooms.archive", page: "rooms", target: "rooms.filter", kind: "info",
    titleKey: "Archive or delete",
    bodyKey: "Archive a room with the box icon on its card: it moves to ‘Archived rooms’ here, keeps all its data and can be restored. The bin icon deletes a room for good — with all its sets and results." },
  { id: "rooms.new-room", page: "rooms", target: "rooms.new-room", kind: "info",
    titleKey: "Create your own room",
    bodyKey: "Click ‘New room’, enter a name and create it. Every room gets a fixed join code for participants." },
  ]),
  ...inSection("sets", [
  { id: "room.sets", page: "room", target: "room.new-set", kind: "info", navigateTo: "exampleRoom",
    titleKey: "Sets and their types",
    bodyKey: "A room holds question sets. Each set has a type — Live poll (presenter-driven), Self-paced quiz (own pace in class) or Self-check (a standing self-study link)." },
  { id: "room.set-actions", page: "room", target: "room.set-actions", kind: "info", modes: ["pro"],
    titleKey: "Archive results or delete a set",
    bodyKey: "The chart and play icons open the results and the presentation directly. The box icon archives only the set’s results — the next presentation starts empty, the old run stays available under Results. The bin deletes the set with all its questions and results for good." },
  { id: "room.set-delete", page: "room", target: "room.set-actions", kind: "info", modes: ["easy"],
    titleKey: "Delete a set",
    bodyKey: "The chart and play icons open the results and the presentation directly. The bin deletes a set with all its questions and results for good. When you present again on another day, the previous results are archived automatically." },
  { id: "set.editor", page: "set", target: "set.questions", kind: "info", navigateTo: "exampleSet",
    titleKey: "The set editor", bodyKey: "This example set holds one question of every type — let’s look at each." },
  // The copy invites opening the type menu, so the page stays clickable and the
  // popover sits above the button (the menu opens below it).
  // close-question-menu: Back from the type list must not leave the menu
  // open (no-op going forward — the menu is closed then).
  { id: "set.add-question", page: "set", target: "set.add-question", kind: "info",
    interactive: true, side: "top", signal: "close-question-menu",
    titleKey: "Add a question",
    bodyKey: "Click ‘New question’ and pick the question type in the menu — the type decides the answer format and how results are evaluated." },
  { id: "set.type-list", page: "set", target: "set.type-list", kind: "info",
    signal: "open-question-menu", side: "left",
    titleKey: "Question types",
    bodyKey: "The menu groups the types by what participants do: choose from answers, rate & order, or answer openly. Next we’ll look at each one." },
  { id: "set.ai-generate", page: "set", target: "set.ai-generate", kind: "info", modes: ["pro"], requiresAi: true,
    titleKey: "Shortcuts",
    bodyKey: "‘From document’ drafts questions from your slides (PDF, PowerPoint, Impress) with AI. Questions from another set can be added via the set’s ⋯ menu." },
  ]),
  ...inSection("types", [
  q("single_choice", "Single Choice", "Participants pick exactly one answer. Tick the correct one — or none for an opinion poll. For Yes/No and True/False there is a separate entry in the menu."),
  { id: "question.settings", page: "question", target: "question.settings", kind: "info",
    titleKey: "Settings every question has",
    bodyKey: "Random order shuffles the answers anew for each presentation — all participants see the same order. ‘Reveal correct answer’ decides whether the solution appears immediately with the results, only when triggered, or never." },
  { id: "question.timer", page: "question", target: "question.timer", kind: "info",
    titleKey: "Time limit",
    bodyKey: "Optionally close the question automatically after a set time." },
  { id: "question.images", page: "question", target: "question.lang-tabs", kind: "info",
    titleKey: "Images",
    bodyKey: "Insert images into the question text with the image icon in the toolbar — or drag them in. Each answer has its own image icon, too." },
  q("multiple_choice", "Multiple Choice", "Several answers can be correct — tick each one. Participants may select more than one."),
  q("likert", "Likert scale", "An agreement scale with an optional abstention — there is no ‘correct’ answer, you see the distribution."),
  q("word_cloud", "Word cloud",
    "Participants type short terms; you can cap the contributions per person. Upper/lower-case variants are merged, and the cloud can grow live on the projector while voting is open.",
    [{ key: "With AI, the projector can also show a cleaned-up or grouped view of the terms.", ...PRO_AI }]),
  q("open_text", "Free text",
    "A free-text answer (up to 500 characters), shown as a list.",
    [{ key: "With AI, answers can be evaluated against a model solution, and the projector can show key statements or grouped answers instead of the list.", ...PRO_AI }]),
  q("priorities", "Priorities", "Participants distribute up to 100 points across the answers — the more important, the more points. The result shows which items received the highest priority overall."),
  q("ordering", "Ordering", "The order you save here is the solution; participants see the items shuffled and sort them."),
  q("mindmap", "Mind map",
    "Participants build a mind map together — it grows live on the projector. Optionally, a rating phase follows in which they weight the terms with points or plus/minus.",
    [
      { key: "On the projector you moderate it: merge, move or rename terms — and undo any step.", modes: ["pro"] },
      { key: "With AI, ‘Optimise mind map’ proposes a tidier structure — you see a preview and decide what to apply.", ...PRO_AI },
    ]),
  q("matrix", "Four-field matrix",
    "Participants place cards on a coordinate graph with two axes you label — for example effort against benefit. Optionally, cards can also sit on the axis lines, carry a description and a coloured category.",
    [{ key: "On the projector you move the cards, stack similar ones, hide or add your own — and open a card to read it." }]),
  { id: "question.lang-tabs", page: "question", target: "question.lang-tabs", kind: "info", modes: ["pro"],
    // quizbar (fork): no DE/EN tabs any more — one content language per room.
    titleKey: "One language per room",
    bodyKey: "Questions are written in one language. Set it per room (⋮ → Settings): the beamer and the phones switch to it." },
  ]),
  ...inSection("present", [
  { id: "set.present", page: "set", target: "set.present", kind: "info", navigateTo: "exampleSet",
    titleKey: "Start the presentation",
    bodyKey: "This starts presentation mode for the projector: participants join via QR code or room code, and you run the questions one by one." },
  // present-lobby / present-first: no-ops when the presenter is already in
  // that state, so emitting them going forward is harmless — and going Back
  // they restore the lobby / the first question.
  { id: "present.join", page: "present", target: "present.join", kind: "info", navigateTo: "exampleSetPresent",
    signal: "present-lobby",
    titleKey: "Joining",
    bodyKey: "In the lobby, show the QR code or room code — participants join on their phones; you see how many are connected. Later, the QR icon in the footer (Q) shows it again." },
  { id: "present.voting", page: "present", target: "present.toggle", kind: "info",
    signal: "present-first",
    titleKey: "Start and stop voting",
    bodyKey: "Start (S) opens voting on the current question, Stop (S) closes it. Until you start, participants only see the question." },
  { id: "present.reveal", page: "present", target: "present.reveal", kind: "info",
    signal: "present-first",
    titleKey: "Choose what the projector shows",
    bodyKey: "This switcher sets what the projector shows: the question, the results (E) and — if there is one — the solution (L). Word clouds, free text and mind maps add their own views here. A steps through them without ever closing a vote." },
  { id: "present.navigate", page: "present", target: "present.nav", kind: "info",
    signal: "present-first",
    titleKey: "Next question and leave",
    bodyKey: "‹ › or the arrow keys move between the questions. The red ✕ (Esc) leaves the presentation — the survey stays open, and you end it in the question set overview." },
  { id: "present.help", page: "present", target: "present.help", kind: "info",
    signal: "present-first",
    titleKey: "Help on the projector",
    bodyKey: "Forgotten what an icon does? ‘?’ (or the H key) labels every control on screen with its name and key. A click or Esc closes the help." },
  ]),
  ...inSection("results", [
  { id: "set.results", page: "set", target: "set.results", kind: "info", navigateTo: "exampleSet",
    signal: "present-lobby",
    titleKey: "Where to find results",
    bodyKey: "Open this set’s results any time with ‘Results’ — every presentation is stored there." },
  { id: "results.view", page: "results", target: "results.view", kind: "info", navigateTo: "exampleSetResults",
    titleKey: "Results",
    bodyKey: "Results of this set appear here — one chart, word cloud or list per question.",
    bodyExtras: [{ key: "With AI, ‘Create short report’ summarises the run for you.", ...PRO_AI }] },
  { id: "results.runs", page: "results", target: "results.runs", kind: "info", optional: true,
    titleKey: "Earlier runs",
    bodyKey: "Every presentation is stored as its own run. Pick earlier, archived runs here." },
  { id: "results.export", page: "results", target: "results.export", kind: "info", optional: true,
    titleKey: "Export and delete",
    bodyKey: "Download a CSV of this run or of all runs (incl. archive). ‘Delete all’ removes the results for good." },
  ]),
  { id: "final", target: null, kind: "info", navigateTo: "roomsHome",
    titleKey: "You’ve got it 🎉",
    bodyKey: "Try things out in the example room — or create your own room with ‘New room’. Restart this tour anytime from the ? menu." },
];

export const easyTour: TourStep[] = proTour
  .filter((s) => !s.modes || s.modes.includes("easy"))
  .filter((s) => !["set.ai-generate", "question.lang-tabs"].includes(s.id));

/** Steps for a mode, minus any that can't be shown for this user. `aiEnabled`
 *  gates `requiresAi` steps so a normal run never pauses on a missing target. */
export const tourFor = (
  mode: TourMode,
  opts: { aiEnabled?: boolean } = {},
): TourStep[] => {
  // proTour also carries easy-only variants (e.g. room.set-delete) — drop them.
  const base = mode === "easy" ? easyTour : proTour.filter((s) => !s.modes || s.modes.includes("pro"));
  return opts.aiEnabled ? base : base.filter((s) => !s.requiresAi);
};
