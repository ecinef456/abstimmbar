// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Archive, ArrowDownUp, BarChart3, Check, ChevronDown, CircleDot, CircleHelp, Cloud, Copy, CopyPlus, Download, Files, FolderInput, Languages, Link2, ListChecks, ListTree, MessageSquareText, Network, Play, Scale, Settings, Share2, SlidersHorizontal, Sparkles, Square, Timer, ToggleLeft, Trash2, TriangleAlert, type LucideIcon } from "lucide-react";
import {
  api,
  results,
  selfCheck,
  type GenerationJob,
  type Question,
  type QuestionKind,
  type QuestionSet,
  type RevealAnswers,
  type Room,
  type Section as SectionType,
} from "../api";
import { useEasyMode } from "../App";
import AiGenerateForm from "../components/AiGenerateForm";
import AiReviewPanel from "../components/AiReviewPanel";
import FileDropzone from "../components/FileDropzone";
import HomeCrumb from "../components/HomeCrumb";
import SortableOutline from "../components/SortableOutline";
import TranslatableField from "../components/TranslatableField";
import { allowedKindsFor, SET_TYPES, type SetType } from "../setTypes";
import { localizedText, type LocalizedText, RichText, stripHtml, TranslationControlsSlot } from "@basicbar/ui";
import {
  Button,
  ConfirmInline,
  EmptyState,
  Field,
  InfoHint,
  MenuItem,
  MoreMenu,
  Select,
  TextInput,
} from "../components/ui";
import { LICENSE_OPTIONS, licenseNeedsHolder } from "../licenses";
import { useTourSignal } from "../tour/signals";

// Values are English source strings, translated with t() at each render site
// (this Record lives at module scope, outside any component).
export const KIND_LABEL: Record<QuestionKind, string> = {
  single_choice: "Single Choice",
  multiple_choice: "Multiple Choice",
  word_cloud: "Word cloud",
  likert: "Likert scale",
  open_text: "Free text",
  priorities: "Priorities",
  ordering: "Ordering",
  mindmap: "Mind map",
};

// Kinds whose answers are options (mirror of backend Question.CHOICE_KINDS) —
// the only kinds that can get an after-question (#54).
const CHOICE_KINDS: QuestionKind[] = ["single_choice", "multiple_choice", "likert"];

/** #75 Phase 3: in a self-check, a question needs something to give feedback
 * with — a marked correct option (choice kinds) or a model solution (free
 * text). Ordering always has its correct order; other kinds are not allowed. */
function missingSolution(question: Question): boolean {
  if (question.kind === "single_choice" || question.kind === "multiple_choice") {
    return !question.options.some((o) => o.is_correct && !o.is_abstention);
  }
  if (question.kind === "open_text") return !(question.model_solution || "").trim();
  return false;
}
function missingSolutionHint(question: Question): string {
  return question.kind === "open_text"
    ? "No model solution — no feedback in the self-check"
    : "No correct answer marked — no feedback in the self-check";
}

// Labels are English source strings, translated with t() at each render site.
export const REVEAL_OPTIONS: { value: RevealAnswers; label: string }[] = [
  { value: "immediately", label: "immediately, with the results" },
  { value: "after_close", label: "only when triggered" },
  { value: "never", label: "never" },
];

export const REVEAL_LABEL: Record<RevealAnswers, string> = {
  immediately: "immediately, with the results",
  after_close: "only when triggered",
  never: "never",
};

// Self-paced quizzes can carry an overall time budget (#75); presets mirror
// the per-question TIME_PRESETS in QuestionPage.tsx but work in minutes and
// store seconds in `quiz_time_limit` (module scope like the other constants
// above — used only by SetSettingsForm below).
const QUIZ_TIME_PRESETS: { label: string; seconds: number | null }[] = [
  { label: "Unlimited", seconds: null },
  { label: "2 min", seconds: 120 },
  { label: "5 min", seconds: 300 },
  { label: "10 min", seconds: 600 },
  { label: "15 min", seconds: 900 },
];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Editable settings while creating or editing a set. */
export interface SetSettings {
  type: SetType;
  title: LocalizedText;
  description: LocalizedText;
  reveal_answers: RevealAnswers;
  open_on_show: boolean;
  quiz_time_limit: number | null;
  show_results_to_participants: boolean;
  present_results_after: boolean;
  allow_back_navigation: boolean;
  shuffle_questions: boolean;
  reveal_only_in_summary: boolean;
}

/** The settings form, shared by the create panel (RoomPage) and the edit
 * mode here. Controlled: the parent owns the draft and the Save/Cancel. */
export function SetSettingsForm({
  draft,
  onChange,
  titleAnchor,
  easyMode = false,
}: {
  draft: SetSettings;
  onChange: (patch: Partial<SetSettings>) => void;
  /** Optional `data-tour` value wrapped around the Title field (guided tour):
   *  only the new-set create form sets it, so the anchor is scoped to that. */
  titleAnchor?: string;
  /** Easy mode (#52): only title + description; hide reveal/answer-flow
   * options. Existing values stay stored. */
  easyMode?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid max-w-2xl gap-8">
      {/* Phones: the translation controls dock here instead of floating. */}
      <TranslationControlsSlot />
      {/* #75: the set type is picked once (at creation, via the "New question
       * set" menu) and immutable after — shown here read-only as a badge. */}
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">
          {t("Set type")}
        </p>
        {(() => {
          const Icon = SET_TYPES[draft.type].icon;
          return (
            <span
              title={t(SET_TYPES[draft.type].description)}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${SET_TYPES[draft.type].accent.badge}`}
            >
              <Icon aria-hidden className="h-3.5 w-3.5" />
              {t(SET_TYPES[draft.type].label)}
            </span>
          );
        })()}
      </div>
      {(() => {
        const titleField = (
          <TranslatableField
            label={t("Title")}
            value={draft.title}
            onChange={(title) => onChange({ title })}
            placeholder={t("Question set title")}
          />
        );
        return titleAnchor ? <div data-tour={titleAnchor}>{titleField}</div> : titleField;
      })()}
      <TranslatableField
        variant="rich"
        label={t("Description")}
        value={draft.description}
        onChange={(description) => onChange({ description })}
      />
      {!easyMode && (
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">
            {t("Answers & results")}
          </legend>
          <div className="grid gap-2">
            {draft.type === "self_check" ? (
              // Self-check (#75): a standing practice link. The teacher picks
              // whether results appear after each question or only in the
              // end-of-block summary; question order can be randomized.
              <>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.shuffle_questions}
                    onChange={(event) =>
                      onChange({ shuffle_questions: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Show questions in a random order")}
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.reveal_only_in_summary}
                    onChange={(event) =>
                      onChange({ reveal_only_in_summary: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Show results only in the summary at the end")}
                </label>
              </>
            ) : draft.type === "self_paced" ? (
              // Quiz-Block (#75): no per-question start/stop, so "reveal timing"
              // and "open on show" don't apply; the choices are whether the
              // correct answer is shown right after answering (bound to
              // reveal_answers, the field that drives self-paced feedback:
              // on → "immediately", off → "never") and whether the results are
              // shown in the presentation afterwards.
              <>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.reveal_answers !== "never"}
                    onChange={(event) =>
                      onChange({
                        reveal_answers: event.target.checked ? "immediately" : "never",
                      })
                    }
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Show correct answers right after answering")}
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.present_results_after}
                    onChange={(event) =>
                      onChange({ present_results_after: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Show the results in the presentation afterwards")}
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.allow_back_navigation}
                    onChange={(event) =>
                      onChange({ allow_back_navigation: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Let participants navigate between questions and change answers")}
                </label>
                <p className="ml-6 text-xs text-slate-400">
                  {t("Answers can only be changed while instant feedback is off.")}
                </p>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.shuffle_questions}
                    onChange={(event) =>
                      onChange({ shuffle_questions: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Show questions in a random order")}
                </label>
              </>
            ) : (
              <>
                <Field label={t("Reveal correct answers")}>
                  <Select
                    value={draft.reveal_answers}
                    onChange={(event) =>
                      onChange({ reveal_answers: event.target.value as RevealAnswers })
                    }
                  >
                    {REVEAL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.label)}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-slate-400">
                    {t(
                      "Default for all questions with correct answers; individual questions can deviate from this.",
                    )}
                  </p>
                </Field>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.open_on_show}
                    onChange={(event) => onChange({ open_on_show: event.target.checked })}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Questions can be answered immediately on open (no separate start)")}
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.show_results_to_participants}
                    onChange={(event) =>
                      onChange({ show_results_to_participants: event.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Participants also see the results on their own device")}
                </label>
              </>
            )}
          </div>
        </fieldset>
      )}
      {/* Self-paced quizzes can carry an overall time budget (#75). Shown last,
          so it sits right above the Save button — like the question time limit.
          Other set types have no "total run time" concept; visible in easy mode
          too, since a Quiz-Block can be created there. */}
      {draft.type === "self_paced" && (
        <Field label={t("Total time limit")}>
          <div className="flex flex-wrap items-center gap-1.5">
            {QUIZ_TIME_PRESETS.map((preset) => {
              const active = draft.quiz_time_limit === preset.seconds;
              return (
                <button
                  key={preset.label}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange({ quiz_time_limit: preset.seconds })}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "border-slate-400 bg-slate-200 font-semibold text-slate-900 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100"
                      : "border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900/60"
                  }`}
                >
                  {t(preset.label)}
                </button>
              );
            })}
            <span className="ml-1 text-sm text-slate-500 dark:text-slate-400">
              {t("or")}
            </span>
            <TextInput
              type="number"
              min={1}
              value={draft.quiz_time_limit == null ? "" : String(draft.quiz_time_limit / 60)}
              onChange={(event) => {
                const raw = event.target.value;
                if (raw.trim() === "") {
                  onChange({ quiz_time_limit: null });
                  return;
                }
                const minutes = Number(raw);
                onChange({
                  quiz_time_limit:
                    Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null,
                });
              }}
              placeholder={t("e.g. 10")}
              aria-label={t("Total time limit in minutes")}
              className="!w-28"
            />
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {t("Minutes")}
            </span>
          </div>
        </Field>
      )}
    </div>
  );
}

/** One entry in the inline outline (SortableOutline needs a string id). */
type OutlineRow =
  | { kind: "section"; id: string; section: SectionType }
  | { kind: "question"; id: string; question: Question };

/** Merge sections and questions into the single ordered outline. */
function buildRows(questions: Question[], sections: SectionType[]): OutlineRow[] {
  const merged = [
    ...sections.map((section) => ({
      pos: section.position,
      row: { kind: "section" as const, id: `s-${section.id}`, section },
    })),
    ...questions.map((question) => ({
      pos: question.position,
      row: { kind: "question" as const, id: `q-${question.id}`, question },
    })),
  ];
  merged.sort((a, b) => a.pos - b.pos);
  return merged.map((entry) => entry.row);
}

// Label/description are English source strings, translated with t() at the
// NewQuestionMenu render site (this array lives at module scope).
const QUESTION_TYPES: {
  kind: QuestionKind;
  template?: "binary";
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    kind: "single_choice",
    icon: CircleDot,
    label: "Single Choice",
    description: "One answer selectable; a correct answer can be marked.",
  },
  {
    kind: "multiple_choice",
    icon: ListChecks,
    label: "Multiple Choice",
    description: "Multiple answers selectable at the same time.",
  },
  {
    kind: "single_choice",
    template: "binary",
    icon: ToggleLeft,
    label: "Yes/No",
    description: "Two options — pick a Yes/No or True/False template, or type your own.",
  },
  {
    kind: "likert",
    icon: SlidersHorizontal,
    label: "Likert scale",
    description: "Fixed rating scale (e.g. agreement), optionally with an abstain option.",
  },
  {
    kind: "word_cloud",
    icon: Cloud,
    label: "Word cloud",
    description: "Short free-form terms, live as a growing word cloud.",
  },
  {
    kind: "open_text",
    icon: MessageSquareText,
    label: "Free text",
    description: "Free-form text answer (max. 500 characters), shown as a list.",
  },
  {
    kind: "priorities",
    icon: Scale,
    label: "Priorities",
    description: "Distribute up to 100 points across the options; evaluated as the average per option.",
  },
  {
    kind: "ordering",
    icon: ArrowDownUp,
    label: "Ordering",
    description: "Participants sort items into the correct order (drag & drop).",
  },
  {
    kind: "mindmap",
    icon: Network,
    label: "Mind map",
    description: "Build a mind map together, live on the beamer.",
  },
];

/** "+ Neue Frage" dropdown: question type with a one-line explanation.
 * `allowedKinds` gates the list to what the set's type permits (#75). */
function NewQuestionMenu({
  onPick,
  allowedKinds,
}: {
  onPick: (kind: QuestionKind, template?: "binary") => void;
  allowedKinds: QuestionKind[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Guided tour: the "Question types" step opens this menu to spotlight it.
  useTourSignal("open-question-menu", () => setOpen(true));

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2"
      >
        <span className="text-base leading-none">+</span>
        {t("New question")}
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </Button>
      {open && (
        <div
          role="menu"
          data-tour="set.type-list"
          className="absolute right-0 z-30 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg shadow-slate-900/5 dark:border-slate-700 dark:bg-slate-900"
        >
          {QUESTION_TYPES.filter((type) => allowedKinds.includes(type.kind)).map((type) => (
            <button
              key={type.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(type.kind, type.template);
              }}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <type.icon
                aria-hidden
                className="mt-0.5 h-4 w-4 shrink-0 text-brand-600 dark:text-brand-400"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t(type.label)}
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {t(type.description)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Section-name editor inside the outline: bilingual (title tabs), committed
 * onBlur like the previous plain-string input — local state so keystrokes
 * don't round-trip to the server, synced back in if the section changes
 * from under it (e.g. after a reorder reload). */
function SectionTitleField({
  section,
  onRename,
}: {
  section: SectionType;
  onRename: (id: number, title: LocalizedText) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState<LocalizedText>(section.title);
  useEffect(() => setTitle(section.title), [section.id, section.title]);
  return (
    <TranslatableField
      value={title}
      onChange={setTitle}
      ariaLabel={t("Section name")}
      className="!w-72 font-semibold"
      onBlur={() => {
        if (JSON.stringify(title) !== JSON.stringify(section.title)) {
          onRename(section.id, title);
        }
      }}
    />
  );
}

/** Inline hint above the question list when this set has an un-reviewed
 * generation job: shows running progress or a "N questions ready — review"
 * call to action, and is the entry point to the review panel. */
function GenerationReviewHint({
  job,
  onReview,
  onRestart,
  onDiscard,
}: {
  job: GenerationJob;
  onReview: () => void;
  onRestart: () => void;
  onDiscard: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const running = job.status === "pending" || job.status === "running";
  if (job.status === "cancelled") return null;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50/60 px-4 py-3 dark:border-brand-900 dark:bg-brand-950/30">
      <div className="min-w-0 text-sm text-slate-700 dark:text-slate-200">
        {running ? (
          <span>
            {t("Questions are being generated …")}
            {job.total_chunks > 0 && (
              <>
                {" "}
                {t("{{percent}} % done", {
                  percent: Math.round((job.done_chunks / job.total_chunks) * 100),
                })}
                {" · "}
                {t("{{n}} questions so far", { n: job.drafts.length })}
              </>
            )}
          </span>
        ) : job.status === "failed" ? (
          <span>{t("Question generation failed.")}</span>
        ) : (
          <span>
            {t("{{n}} questions were generated — review and use them now.", {
              n: job.drafts.length,
            })}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {job.status === "failed" ? (
          <>
            <Button variant="primary" onClick={onRestart}>
              {t("Try again")}
            </Button>
            <Button variant="ghost" onClick={() => void onDiscard()}>
              {t("Discard")}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onReview}>
            {t("Review")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Question-set editor: summarized settings (editable behind a pencil),
 * sortable question list, and a ⋮ menu for duplicate/export/share. */
export default function SetPage() {
  const { t } = useTranslation();
  const { setId } = useParams();
  const id = Number(setId);
  const navigate = useNavigate();
  const [set, setSet] = useState<QuestionSet | null>(null);
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [copyTarget, setCopyTarget] = useState<number | null>(null);
  const [copyTitle, setCopyTitle] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [metaError, setMetaError] = useState("");
  const [sections, setSections] = useState<SectionType[]>([]);
  const [editingSections, setEditingSections] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [draft, setDraft] = useState<SetSettings | null>(null);
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archivedNotice, setArchivedNotice] = useState(false);
  const [whoamiName, setWhoamiName] = useState("");
  const [aiEnabled, setAiEnabled] = useState(false);
  const [maxQuestions, setMaxQuestions] = useState<number | undefined>(undefined);
  const [generateOpen, setGenerateOpen] = useState(false);
  // A file dropped onto the empty-set upload box, pre-loaded into the form.
  const [pendingUpload, setPendingUpload] = useState<File | null>(null);
  // The set's latest un-reviewed generation job drives the review hint; the
  // review panel opens on top of it.
  const [reviewJob, setReviewJob] = useState<GenerationJob | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const location = useLocation();
  // Move/copy a single question to another set (#87) — shared target-set
  // picker, ported from QuestionPage's move modal.
  const [xfer, setXfer] = useState<{ id: number; mode: "move" | "copy" } | null>(null);
  const [xferTargets, setXferTargets] = useState<QuestionSet[] | null>(null);
  const [xferRooms, setXferRooms] = useState<{ id: number; title: string }[]>([]);
  const [xferRoom, setXferRoom] = useState<number | null>(null);
  const [xferTarget, setXferTarget] = useState<number | null>(null);
  const [xferError, setXferError] = useState("");
  // Pull picker (#87): copy several questions from a chosen source set into
  // this one. `pullTargets` doubles as the dialog's open/closed gate.
  const [pullTargets, setPullTargets] = useState<QuestionSet[] | null>(null);
  const [pullRooms, setPullRooms] = useState<{ id: number; title: string }[]>([]);
  const [pullRoom, setPullRoom] = useState<number | null>(null);
  const [pullSourceSet, setPullSourceSet] = useState<number | null>(null);
  const [pullQuestions, setPullQuestions] = useState<Question[] | null>(null);
  const [pullSelected, setPullSelected] = useState<Set<number>>(new Set());
  const [pullError, setPullError] = useState("");
  const [pullBusy, setPullBusy] = useState(false);
  // Small bottom toast, shared by "copy link" and the new copy actions.
  const [toastMessage, setToastMessage] = useState("");
  // Lernkontrolle publish panel (#75 phase 3): one shared "just copied" key
  // for the permanent link ("set") and each per-question link (question id),
  // so only the clicked one shows "Copied" at a time.
  const [copiedKey, setCopiedKey] = useState<string | number | null>(null);
  const [selfCheckStats, setSelfCheckStats] = useState<{
    attempts: number;
    correct: number;
    scored: number;
    ratio: number | null;
  } | null>(null);
  const [confirmResetStats, setConfirmResetStats] = useState(false);
  const easyMode = useEasyMode();
  const aiVisible = aiEnabled && !easyMode;
  // Recording mode (#53): opt-in before presenting; carried to the beamer via
  // the present URL. Pro feature (hidden in easy mode).
  const [recordMode, setRecordMode] = useState(false);

  useEffect(() => {
    void Promise.all([
      api.getQuestionSet(id),
      api.listQuestions(id),
      api.listSections(id),
      api.whoami(),
    ]).then(([setData, page, sectionPage, who]) => {
      setSet(setData);
      setQuestions(page.results);
      setSections(sectionPage.results);
      setWhoamiName(
        [who.first_name, who.last_name].filter(Boolean).join(" ") ||
          who.username ||
          "",
      );
      setAiEnabled(!!who.ai_enabled);
      setMaxQuestions(who.ai_generate_max_questions);
    });
    void refreshReviewHint();
    // Deep link from the app-wide status bar → open the review panel directly.
    if ((location.state as { openReview?: boolean } | null)?.openReview) {
      setReviewOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function refreshReviewHint() {
    try {
      const active = await api.aiGenerateActive(id);
      setReviewJob("id" in active ? (active as GenerationJob) : null);
    } catch {
      setReviewJob(null);
    }
  }

  // Keep the hint's progress fresh while a run is in flight and the panel is
  // closed (the open panel polls itself; the app-wide bar is suppressed here).
  useEffect(() => {
    if (reviewOpen) return;
    if (!reviewJob || !(reviewJob.status === "pending" || reviewJob.status === "running"))
      return;
    const timer = setInterval(() => void refreshReviewHint(), 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewOpen, reviewJob?.id, reviewJob?.status]);

  const rows = buildRows(questions ?? [], sections);

  async function persistOutline(newRows: OutlineRow[]) {
    const newSections: SectionType[] = [];
    const newQuestions: Question[] = [];
    let current: number | null = null;
    newRows.forEach((row, index) => {
      if (row.kind === "section") {
        newSections.push({ ...row.section, position: index });
        current = row.section.id;
      } else {
        newQuestions.push({ ...row.question, position: index, section: current });
      }
    });
    setSections(newSections);
    setQuestions(newQuestions);
    await api.reorderOutline(
      id,
      newRows.map((row) =>
        row.kind === "section"
          ? { type: "section" as const, id: row.section.id }
          : { type: "question" as const, id: row.question.id },
      ),
    );
  }

  async function insertSectionAt(index: number) {
    const created = await api.createSection(id);
    const next = [...rows];
    next.splice(index, 0, { kind: "section", id: `s-${created.id}`, section: created });
    await persistOutline(next);
  }

  async function renameSection(sectionId: number, title: LocalizedText) {
    const updated = await api.updateSection(sectionId, title);
    setSections((current) =>
      current.map((s) => (s.id === sectionId ? { ...s, title: updated.title } : s)),
    );
  }

  async function deleteSection(sectionId: number) {
    await api.deleteSection(sectionId);
    await persistOutline(
      rows.filter((row) => !(row.kind === "section" && row.section.id === sectionId)),
    );
  }

  async function reloadQuestions() {
    const page = await api.listQuestions(id);
    setQuestions(page.results);
  }

  /** Archive current results & prepare a fresh run (#27/#56) — same action as
   * the room's set table, surfaced here in the set's ⋮ menu. Reloads the set
   * so the status line / archive-availability reflect the fresh run. */
  async function handleArchiveResults() {
    setConfirmArchive(false);
    await results.archive(id);
    const updated = await api.getQuestionSet(id);
    setSet(updated);
    // Confirm success — archiving only changes the *next* presentation, so
    // without feedback it looks like nothing happened (#70).
    setArchivedNotice(true);
  }

  /** Persist an arbitrary patch (share panel: license/holder, sharing). */
  async function saveMeta(patch: Partial<QuestionSet>) {
    if (!set) return;
    setMetaError("");
    try {
      const updated = await api.updateQuestionSet(set.id, patch);
      setSet(updated);
    } catch (err) {
      try {
        const data = JSON.parse((err as Error).message);
        const value = data.detail ?? Object.values(data)[0];
        setMetaError(Array.isArray(value) ? value[0] : String(value));
      } catch {
        setMetaError(String(err));
      }
    }
  }

  function startMetaEdit() {
    if (!set) return;
    setMetaError("");
    setDraft({
      type: set.type,
      title: set.title,
      description: set.description,
      reveal_answers: set.reveal_answers,
      open_on_show: set.open_on_show,
      quiz_time_limit: set.quiz_time_limit,
      show_results_to_participants: set.show_results_to_participants,
      present_results_after: set.present_results_after,
      allow_back_navigation: set.allow_back_navigation,
      shuffle_questions: set.shuffle_questions,
      reveal_only_in_summary: set.reveal_only_in_summary,
    });
    setEditingMeta(true);
  }

  async function saveMetaEdit() {
    if (!set || !draft) return;
    setMetaError("");
    try {
      const updated = await api.updateQuestionSet(set.id, draft);
      setSet(updated);
      setEditingMeta(false);
    } catch (err) {
      try {
        const data = JSON.parse((err as Error).message);
        const value = data.detail ?? Object.values(data)[0];
        setMetaError(Array.isArray(value) ? value[0] : String(value));
      } catch {
        setMetaError(String(err));
      }
    }
  }

  const shareUrl = set?.share_token
    ? `${window.location.origin}/shared/${set.share_token}`
    : "";

  async function toggleShare(enabled: boolean) {
    if (!set) return;
    const { share_token } = await api.shareQuestionSet(set.id, enabled);
    setSet({ ...set, share_token });
    return share_token;
  }

  async function openSharePanel() {
    if (!set) return;
    if (!set.share_token) await toggleShare(true);
    setSharePanelOpen(true);
  }

  function changeLicense(value: string) {
    // Prefill the holder with the signed-in name when a license needs it.
    if (licenseNeedsHolder(value) && !set?.license_holder && whoamiName) {
      void saveMeta({ license: value, license_holder: whoamiName });
    } else {
      void saveMeta({ license: value });
    }
  }

  async function copyShareLink() {
    await navigator.clipboard.writeText(shareUrl);
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1500);
  }

  const toastTimer = useRef<number | undefined>(undefined);
  function showToast(message: string) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToastMessage(message);
    toastTimer.current = window.setTimeout(() => setToastMessage(""), 1500);
  }

  async function copyQuestionLink(questionId: number) {
    const url = `${window.location.origin}/sets/${id}/present?question=${questionId}`;
    await navigator.clipboard.writeText(url);
    showToast(t("Copied"));
  }

  /** Lernkontrolle (#75 phase 3): publish/unpublish the standing practice
   * link and load/reset its attempt stats. Publish/unpublish re-fetch the
   * whole set (same pattern as `handleArchiveResults`/`saveMeta`) so the
   * summary line and panel stay in sync. */
  async function loadSelfCheckStats() {
    const stats = await selfCheck.stats(id);
    setSelfCheckStats(stats);
  }

  useEffect(() => {
    if (set?.type === "self_check" && set.self_check_token) void loadSelfCheckStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, set?.self_check_token]);

  async function handlePublish() {
    await selfCheck.publish(id);
    const updated = await api.getQuestionSet(id);
    setSet(updated);
  }

  async function handleUnpublish() {
    await selfCheck.unpublish(id);
    const updated = await api.getQuestionSet(id);
    setSet(updated);
  }

  async function handleResetStats() {
    setConfirmResetStats(false);
    await selfCheck.resetStats(id);
    await loadSelfCheckStats();
  }

  /** Shared copy mechanism for the permanent link ("set") and per-question
   * links (keyed by question id) — mirrors `copyShareLink` but supports
   * more than one "just copied" target at a time. */
  async function copySelfCheckLink(key: string | number, url: string) {
    await navigator.clipboard.writeText(url);
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
  }

  /** Two-stage Room→Question-set picker, shared by the move/copy modal and
   * the pull picker: all of the user's sets minus the current one, grouped
   * by room, defaulting to the current set's room. */
  async function loadTransferTargets(filter?: (entry: QuestionSet) => boolean) {
    const page = await api.listAllQuestionSets();
    const targets = page.results.filter(
      (entry) => entry.id !== id && (filter ? filter(entry) : true),
    );
    const rooms = [
      ...new Map(targets.map((entry) => [entry.room, entry.room_title])),
    ].map(([roomId, title]) => ({ id: roomId, title }));
    const startRoom = rooms.some((room) => room.id === set?.room)
      ? (set?.room ?? null)
      : (rooms[0]?.id ?? null);
    return { targets, rooms, startRoom };
  }

  /** Open the shared move/copy picker for a single question (#87). */
  // #75: a target set whose type forbids this question's kind can't receive
  // it — pick the first eligible set in a room as the default selection.
  function firstXferTarget(
    targets: QuestionSet[],
    roomId: number | null,
    kind: QuestionKind | undefined,
  ) {
    return (
      targets.find(
        (entry) =>
          entry.room === roomId &&
          (!kind || allowedKindsFor(entry.type).includes(kind)),
      )?.id ?? null
    );
  }

  async function openXfer(questionId: number, mode: "move" | "copy") {
    const { targets, rooms, startRoom } = await loadTransferTargets();
    const kind = questions?.find((q) => q.id === questionId)?.kind;
    setXferTargets(targets);
    setXferRooms(rooms);
    setXferRoom(startRoom);
    setXferTarget(firstXferTarget(targets, startRoom, kind));
    setXferError("");
    setXfer({ id: questionId, mode });
  }

  function pickXferRoom(roomId: number) {
    setXferRoom(roomId);
    const kind = xfer ? questions?.find((q) => q.id === xfer.id)?.kind : undefined;
    setXferTarget(firstXferTarget(xferTargets ?? [], roomId, kind));
  }

  async function confirmXfer() {
    if (!xfer || xferTarget === null) return;
    setXferError("");
    try {
      if (xfer.mode === "move") {
        await api.moveQuestion(xfer.id, xferTarget);
      } else {
        await api.copyQuestions(xferTarget, [xfer.id]);
        showToast(t("Copied"));
      }
      setXfer(null);
      await reloadQuestions();
    } catch (err) {
      try {
        setXferError(JSON.parse((err as Error).message).detail ?? String(err));
      } catch {
        setXferError(String(err));
      }
    }
  }

  /** Open the pull picker: choose a source set, then check off questions to
   * copy into this one (#87). */
  async function openPull() {
    // Only sets that actually have questions can be pulled from.
    const { targets, rooms, startRoom } = await loadTransferTargets(
      (entry) => entry.question_count > 0,
    );
    const startSet = targets.find((entry) => entry.room === startRoom)?.id ?? null;
    setPullTargets(targets);
    setPullRooms(rooms);
    setPullRoom(startRoom);
    setPullSourceSet(startSet);
    setPullQuestions(null);
    setPullSelected(new Set());
    setPullError("");
    if (startSet !== null) await loadPullQuestions(startSet);
  }

  async function loadPullQuestions(sourceSetId: number) {
    const page = await api.listQuestions(sourceSetId);
    setPullQuestions(page.results);
    // Start with nothing selected: pulling in is deliberate cherry-picking,
    // not "copy the whole set" (that's what Duplicate is for). "Select all"
    // is one click away for the take-everything case.
    setPullSelected(new Set());
  }

  function pickPullRoom(roomId: number) {
    setPullRoom(roomId);
    const nextSet = pullTargets?.find((entry) => entry.room === roomId)?.id ?? null;
    setPullSourceSet(nextSet);
    if (nextSet !== null) void loadPullQuestions(nextSet);
    else {
      setPullQuestions(null);
      setPullSelected(new Set());
    }
  }

  function pickPullSourceSet(sourceSetId: number) {
    setPullSourceSet(sourceSetId);
    void loadPullQuestions(sourceSetId);
  }

  function togglePullQuestion(questionId: number) {
    setPullSelected((current) => {
      const next = new Set(current);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      return next;
    });
  }

  function toggleSelectAllPull() {
    if (!pullQuestions || !set) return;
    // Only kinds this set's type allows can be selected (#75) — "select all"
    // never picks a disallowed question.
    const allowed = allowedKindsFor(set.type);
    const selectable = pullQuestions.filter((q) => allowed.includes(q.kind));
    setPullSelected((current) =>
      selectable.length > 0 && current.size >= selectable.length
        ? new Set()
        : new Set(selectable.map((q) => q.id)),
    );
  }

  async function confirmPull() {
    if (pullSelected.size === 0) return;
    setPullBusy(true);
    setPullError("");
    try {
      await api.copyQuestions(id, [...pullSelected]);
      setPullTargets(null);
      showToast(t("Copied"));
      await reloadQuestions();
    } catch (err) {
      try {
        setPullError(JSON.parse((err as Error).message).detail ?? String(err));
      } catch {
        setPullError(String(err));
      }
    } finally {
      setPullBusy(false);
    }
  }

  function doExport() {
    const a = document.createElement("a");
    a.href = results.exportUrl(id);
    a.click();
  }

  function addQuestion(kind: QuestionKind, template?: "binary") {
    const query = new URLSearchParams({ kind });
    if (template) query.set("template", template);
    navigate(`/sets/${id}/questions/new?${query.toString()}`);
  }

  async function handleDelete(questionId: number) {
    await api.deleteQuestion(questionId);
    setConfirmDelete(null);
    await reloadQuestions();
  }

  /** Add a locked after-question mirroring this one (#54). */
  async function handleAddAfter(questionId: number) {
    await api.addAfterQuestion(questionId);
    await reloadQuestions();
  }

  async function openCopyDialog() {
    const page = await api.listRooms();
    setRooms(page.results);
    setCopyTarget(set?.room ?? null);
    setCopyTitle("");
    setCopyOpen(true);
  }

  async function handleCopy() {
    if (!set || copyTarget === null) return;
    const clone = await api.duplicateQuestionSet(set.id, {
      room: copyTarget,
      ...(copyTitle.trim() ? { title: copyTitle.trim() } : {}),
    });
    setCopyOpen(false);
    navigate(`/sets/${clone.id}`);
  }

  if (!set || !questions) return null;

  // Plain local const (not `set.self_check_token`) so it narrows cleanly to
  // `string` inside closures below (#75 phase 3).
  const selfCheckToken = set.self_check_token;

  return (
    <div>
      <nav className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        <HomeCrumb />{" "}
        /{" "}
        <Link to={`/rooms/${set.room}`} className="hover:text-brand-700 dark:hover:text-brand-300">
          {set.room_title}
        </Link>{" "}
        / {t("Question set")}: {localizedText(set.title)}
      </nav>

      {/* Settings: summarized read-only, editable behind the pencil. */}
      {editingMeta && draft ? (
        <div className="mb-8">
          <SetSettingsForm
            draft={draft}
            onChange={(patch) => setDraft({ ...draft, ...patch })}
            easyMode={easyMode}
          />
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void saveMetaEdit()}>
              {t("Save")}
            </Button>
            <Button variant="ghost" onClick={() => setEditingMeta(false)}>
              {t("Cancel")}
            </Button>
          </div>
          {metaError && <p className="mt-1 text-sm text-red-600">{metaError}</p>}
        </div>
      ) : (
        <div className="mb-8">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold">{localizedText(set.title)}</h1>
              {(() => {
                const Icon = SET_TYPES[set.type].icon;
                return (
                  <span
                    title={t(SET_TYPES[set.type].description)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${SET_TYPES[set.type].accent.badge}`}
                  >
                    <Icon aria-hidden className="h-3.5 w-3.5" />
                    {t(SET_TYPES[set.type].label)}
                  </span>
                );
              })()}
            </div>
            <MoreMenu label={t("Set actions")}>
              <MenuItem onClick={startMetaEdit}><Settings aria-hidden className="h-4 w-4" />{t("Settings")}</MenuItem>
              {/* Pulling in questions is core authoring — available in both
                  modes, unlike the Pro-only actions below (#87). */}
              <div data-tour="set.copy">
                <MenuItem onClick={() => void openPull()}>
                  <CopyPlus aria-hidden className="h-4 w-4" />
                  {t("Add questions from another set …")}
                </MenuItem>
              </div>
              {/* Easy mode (#52): hide duplicate / export / share / archive. */}
              {!easyMode && (
                <>
                  <MenuItem onClick={() => void openCopyDialog()}><Copy aria-hidden className="h-4 w-4" />{t("Duplicate")}</MenuItem>
                  <MenuItem onClick={doExport}><Download aria-hidden className="h-4 w-4" />{t("Export (JSON)")}</MenuItem>
                  <MenuItem onClick={() => void openSharePanel()}>
                    <Share2 aria-hidden className="h-4 w-4" />{t("Copy set (share link)")}
                  </MenuItem>
                  {/* Archive results & start fresh (#56) — same action as the
                      room's set table, only when there is something to archive. */}
                  {set.has_results && (
                    <MenuItem
                      onClick={() => {
                        setArchivedNotice(false);
                        setConfirmArchive(true);
                      }}
                    >
                      <Archive aria-hidden className="h-4 w-4" />{t("Archive results")}
                    </MenuItem>
                  )}
                </>
              )}
            </MoreMenu>
          </div>
          {confirmArchive && (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800/60 dark:bg-amber-950/40"
            >
              <div className="flex items-start gap-3">
                <Archive
                  aria-hidden
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400"
                />
                <div className="flex-1">
                  <p className="font-semibold text-amber-900 dark:text-amber-200">
                    {t("Archive results?")}
                  </p>
                  <p className="mt-1 text-sm text-amber-800 dark:text-amber-100/90">
                    {t(
                      "The next presentation of this question set starts fresh — results from earlier sessions are shown neither to participants nor to you. Archived results stay available in the evaluation.",
                    )}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button variant="primary" onClick={() => void handleArchiveResults()}>
                      {t("Archive results")}
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmArchive(false)}>
                      {t("Cancel")}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
          {archivedNotice && (
            <div
              role="status"
              className="mt-4 rounded-xl border border-brand-300 bg-brand-50 p-4 dark:border-brand-800/60 dark:bg-brand-950/40"
            >
              <div className="flex items-start gap-3">
                <Check
                  aria-hidden
                  className="mt-0.5 h-5 w-5 shrink-0 text-brand-700 dark:text-brand-300"
                />
                <div className="flex-1">
                  <p className="font-semibold text-brand-900 dark:text-brand-200">
                    {t("Results archived.")}
                  </p>
                  <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
                    {t(
                      "The next presentation starts fresh. The archived session stays available under Results.",
                    )}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Link
                      to={`/sets/${id}/results`}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-brand-400 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:bg-brand-500"
                    >
                      <BarChart3 aria-hidden className="h-4 w-4" />{t("View results")}
                    </Link>
                    <Button variant="ghost" onClick={() => setArchivedNotice(false)}>
                      {t("Dismiss")}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
          {/* Rendered as rich HTML from the WYSIWYG editor (#49). Nothing shown
              when empty — the "No description" placeholder was just noise (#78). */}
          {localizedText(set.description) && (
            <div className="mt-1 max-w-2xl text-sm">
              <RichText html={localizedText(set.description)} />
            </div>
          )}
          {/* Answer-flow summary reflects pro-only settings, so it is hidden in
              the decluttered simple mode (#78). Quiz-Block (#75) has its own
              settings, so it shows a self-paced-specific summary. */}
          {!easyMode && set.type === "self_paced" && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t("Show correct answers right after answering")}:{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">
                {set.reveal_answers !== "never" ? t("yes") : t("no")}
              </strong>{" "}
              · {t("Show the results in the presentation afterwards")}:{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">
                {set.present_results_after ? t("yes") : t("no")}
              </strong>{" "}
              · {t("Total time limit")}:{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">
                {set.quiz_time_limit == null
                  ? t("Unlimited")
                  : `${set.quiz_time_limit / 60} min`}
              </strong>
            </p>
          )}
          {!easyMode && set.type === "self_check" && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t("Show questions in a random order")}:{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">
                {set.shuffle_questions ? t("yes") : t("no")}
              </strong>{" "}
              · {t("Show results only in the summary at the end")}:{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">
                {set.reveal_only_in_summary ? t("yes") : t("no")}
              </strong>
            </p>
          )}
          {!easyMode && set.type !== "self_paced" && set.type !== "self_check" && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t("Correct answers:")}{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">
                {t(REVEAL_LABEL[set.reveal_answers])}
              </strong>{" "}
              · {t("Immediately answerable:")}{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">
                {set.open_on_show ? t("yes") : t("no")}
              </strong>{" "}
              · {t("Results for participants:")}{" "}
              <strong className="font-semibold text-slate-700 dark:text-slate-200">
                {set.show_results_to_participants ? t("yes") : t("no")}
              </strong>
            </p>
          )}
          {!easyMode && (
            <p className="mt-1 text-xs text-slate-400">
              {t("Created {{created}} · Updated {{updated}}", {
                created: formatDate(set.created_at),
                updated: formatDate(set.updated_at),
              })}
              {set.share_token && t(" · shareable via link")}
            </p>
          )}
          {metaError && <p className="mt-1 text-sm text-red-600">{metaError}</p>}
        </div>
      )}

      {/* Lernkontrolle "Veröffentlichen" panel (#75 phase 3): permanent link,
          LMS hint, attempt stats, unpublish/reset — shown once the standing
          practice link exists. Neutral card: the green box is the app's dialog
          style, not an info panel. */}
      {set.type === "self_check" && selfCheckToken && (
        <div className="mb-8 grid max-w-2xl gap-3 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-900/40">
          <div>
            <p className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">
              {t("Permanent link")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <TextInput
                readOnly
                value={selfCheck.url(selfCheckToken)}
                onFocus={(event) => event.target.select()}
                aria-label={t("Permanent link")}
                className="!w-96 font-mono !text-xs"
              />
              <Button
                onClick={() => void copySelfCheckLink("set", selfCheck.url(selfCheckToken))}
                className="inline-flex items-center gap-1.5"
              >
                {copiedKey === "set" ? (
                  <>
                    <Check aria-hidden className="h-4 w-4" />
                    {t("Copied")}
                  </>
                ) : (
                  <>
                    <Copy aria-hidden className="h-4 w-4" />
                    {t("Copy link")}
                  </>
                )}
              </Button>
            </div>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t(
              "In your LMS, choose this set in the Abstimmbar deep link — learners land here directly.",
            )}
          </p>
          <p className="text-sm text-slate-700 dark:text-slate-300">
            {selfCheckStats &&
              (selfCheckStats.ratio !== null
                ? t("{{n}} attempts · {{pct}} % correct", {
                    n: selfCheckStats.attempts,
                    pct: Math.round(selfCheckStats.ratio * 100),
                  })
                : t("{{n}} attempts", { n: selfCheckStats.attempts }))}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => void handleUnpublish()}
              className="inline-flex items-center gap-1.5"
            >
              <Square aria-hidden className="h-4 w-4 fill-current" />
              {t("Stop")}
            </Button>
            {confirmResetStats ? (
              <ConfirmInline
                message={t("Reset the attempt counter?")}
                confirmLabel={t("Reset counter")}
                onConfirm={() => void handleResetStats()}
                onCancel={() => setConfirmResetStats(false)}
              />
            ) : (
              <Button variant="ghost" onClick={() => setConfirmResetStats(true)}>
                {t("Reset counter")}
              </Button>
            )}
          </div>
        </div>
      )}

      {copyOpen && (
        <div className="mb-8 flex max-w-xl flex-wrap items-end gap-3 rounded-2xl border border-brand-200 dark:border-brand-900 bg-brand-50/50 p-4 dark:bg-brand-950/40">
          <Field label={t("Copy to which room?")}>
            <select
              value={copyTarget ?? undefined}
              onChange={(event) => setCopyTarget(Number(event.target.value))}
              className="w-64 rounded-lg border border-slate-300 dark:border-slate-700 bg-white px-3 py-2 text-sm dark:bg-slate-900 dark:text-slate-100"
            >
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {localizedText(room.title)}
                  {room.id === set.room ? t(" (this room)") : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("New title (optional)")}>
            <TextInput
              value={copyTitle}
              onChange={(event) => setCopyTitle(event.target.value)}
              placeholder={localizedText(set.title)}
              className="!w-64"
            />
          </Field>
          <Button variant="primary" onClick={() => void handleCopy()}>
            {t("Copy")}
          </Button>
          <Button variant="ghost" onClick={() => setCopyOpen(false)}>
            {t("Cancel")}
          </Button>
        </div>
      )}

      {sharePanelOpen && set.share_token && (
        <div className="mb-8 grid max-w-2xl gap-3 rounded-2xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-900 dark:bg-brand-950/40">
          <p className="text-sm text-slate-700 dark:text-slate-200">
            <Trans i18nKey="share_copy_hint">
              Anyone signed in with this link can <strong>copy</strong> the set into their own rooms (not edit it):
            </Trans>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <TextInput
              readOnly
              value={shareUrl}
              onFocus={(event) => event.target.select()}
              aria-label={t("Share link")}
              className="!w-96 font-mono !text-xs"
            />
            <Button onClick={() => void copyShareLink()} className="inline-flex items-center gap-1.5">
              {linkCopied ? (<><Check aria-hidden className="h-4 w-4" />{t("Copied")}</>) : t("Copy link")}
            </Button>
          </div>
          <Field label={t("License for sharing (optional)")}>
            <select
              value={set.license}
              onChange={(event) => changeLicense(event.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:outline-none"
            >
              {LICENSE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          {licenseNeedsHolder(set.license) && (
            <Field label={t("Rights holder / attribution")}>
              <TextInput
                defaultValue={set.license_holder}
                key={set.license_holder}
                placeholder={whoamiName}
                onBlur={(event) => {
                  const holder = event.target.value.trim();
                  if (holder !== set.license_holder)
                    void saveMeta({ license_holder: holder });
                }}
              />
            </Field>
          )}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                void toggleShare(false);
                setSharePanelOpen(false);
              }}
            >
              {t("End sharing")}
            </Button>
            <Button onClick={() => setSharePanelOpen(false)}>{t("Close")}</Button>
          </div>
          {metaError && <p className="text-sm text-red-600">{metaError}</p>}
        </div>
      )}

      {generateOpen && (
        <div className="mb-4 border-t border-slate-100 pt-6 dark:border-slate-800">
          <AiGenerateForm
            setId={id}
            maxQuestions={maxQuestions}
            initialFile={pendingUpload}
            onStarted={() => {
              setGenerateOpen(false);
              setPendingUpload(null);
              void refreshReviewHint();
            }}
            onClose={() => {
              setGenerateOpen(false);
              setPendingUpload(null);
            }}
          />
        </div>
      )}

      {aiEnabled && reviewOpen && (
        <div className="mb-4 border-t border-slate-100 pt-6 dark:border-slate-800">
          <AiReviewPanel
            setId={id}
            onClose={() => {
              setReviewOpen(false);
              void refreshReviewHint();
            }}
            onImported={reloadQuestions}
          />
        </div>
      )}

      {aiEnabled && !reviewOpen && reviewJob && (
        <GenerationReviewHint
          job={reviewJob}
          onReview={() => setReviewOpen(true)}
          onRestart={() => {
            setGenerateOpen(true);
          }}
          onDiscard={async () => {
            await api.aiGenerateReviewed(id, reviewJob.id);
            void refreshReviewHint();
          }}
        />
      )}

      <div data-tour="set.questions">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-6 dark:border-slate-800">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{t("Questions")}</h2>
          {questions.length > 0 && (
            <>
              {/* #75: only the run action matching the set's type is offered. */}
              {SET_TYPES[set.type].runAction === "present" && (
                <div data-tour="set.present">
                  <Button
                    variant="primary"
                    onClick={() =>
                      navigate(`/sets/${id}/present${recordMode ? "?recording=1" : ""}`)
                    }
                    className="inline-flex items-center gap-1.5"
                  >
                    <Play aria-hidden className="h-4 w-4" />{t("Present")}
                  </Button>
                </div>
              )}
              {/* A self_paced-typed set has no other run action, so it is
                  always offered regardless of easy mode (#75). */}
              {SET_TYPES[set.type].runAction === "self_paced" && (
                <div data-tour="set.present">
                  <Button
                    variant="primary"
                    title={t(
                      "Participants answer all questions at their own pace, with immediate feedback",
                    )}
                    onClick={() => navigate(`/sets/${id}/quiz`)}
                    className="inline-flex items-center gap-1.5"
                  >
                    <Play aria-hidden className="h-4 w-4" />{t("Present")}
                  </Button>
                </div>
              )}
              {/* Lernkontrolle (#75 phase 3): "run" means publishing the
                  standing link once; once published the panel below carries
                  the actions, so no primary button is shown here. */}
              {SET_TYPES[set.type].runAction === "self_check" && !selfCheckToken && (
                <Button
                  variant="primary"
                  onClick={() => void handlePublish()}
                  className="inline-flex items-center gap-1.5"
                >
                  <Link2 aria-hidden className="h-4 w-4" />{t("Publish")}
                </Button>
              )}
              {/* A Lernkontrolle has no run results — it's per-question
                  attempt stats instead, shown in the publish panel. */}
              {SET_TYPES[set.type].runAction !== "self_check" && (
                <div data-tour="set.results">
                  <Button onClick={() => navigate(`/sets/${id}/results`)} className="inline-flex items-center gap-1.5">
                    <BarChart3 aria-hidden className="h-4 w-4" />{t("Results")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Authoring actions surfaced next to "Neue Frage" (#21, #23).
              Easy mode (#52): sections are a Pro feature. */}
          {!easyMode && (
            <Button
              variant={editingSections ? "primary" : "secondary"}
              aria-pressed={editingSections}
              disabled={questions.length === 0}
              title={
                questions.length === 0
                  ? t("Create a question first — sections group existing questions.")
                  : undefined
              }
              onClick={() => setEditingSections((value) => !value)}
              className="inline-flex items-center gap-1.5"
            >
              <ListTree aria-hidden className="h-4 w-4" />{t("Sections")}
            </Button>
          )}
          {aiVisible && (
            <div data-tour="set.ai-generate">
              <Button
                onClick={() => {
                  setGenerateOpen(true);
                  setEditingSections(false);
                }}
                className="inline-flex items-center gap-1.5"
              >
                <Sparkles aria-hidden className="h-4 w-4" />{t("From document")}
              </Button>
            </div>
          )}
          <div data-tour="set.add-question">
            <NewQuestionMenu
              onPick={(kind, template) => void addQuestion(kind, template)}
              allowedKinds={allowedKindsFor(set.type)}
            />
          </div>
        </div>
      </div>

      {/* Recording mode (#53): opt-in before presenting (Pro only). A
          Lernkontrolle is never presented, so it has no recording mode. */}
      {!easyMode && set.type !== "self_check" && questions.length > 0 && (
        <label className="mb-4 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={recordMode}
            onChange={(event) => setRecordMode(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
          />
          {t("Recording mode")}
          <InfoHint
            text={t(
              "If the presentation is recorded with an external tool, viewers of the recording can vote afterward: each question shows a unique QR code leading straight to that question.",
            )}
          />
        </label>
      )}

      {editingSections && (
        <p className="mb-3 rounded-xl bg-brand-50 px-4 py-2 text-sm text-slate-700 dark:bg-brand-950 dark:text-slate-300">
          {t(
            "Editing sections: use “+ Section” to insert a heading, click a name to rename it, drag by the handle to move it. Drag questions below the matching heading.",
          )}
        </p>
      )}
      {/* Section names are translatable: dock the controls above the outline
          on phones while sections are being edited. */}
      {editingSections && <TranslationControlsSlot className="mb-3" />}

      {rows.length === 0 ? (
        <EmptyState icon={CircleHelp} title={t("No questions yet")}>
          {t(
            "Create the first question above — Single Choice starts with three empty answer fields.",
          )}
          <div className="mx-auto mt-4 flex max-w-sm flex-col items-center gap-3">
            <Button
              variant="primary"
              onClick={() => void openPull()}
              className="inline-flex items-center gap-1.5"
            >
              <CopyPlus aria-hidden className="h-4 w-4" />
              {t("Add questions from another set …")}
            </Button>
            {aiVisible && (
              <FileDropzone
                accept=".pdf,.pptx,.odp"
                file={null}
                onFile={(f) => {
                  setPendingUpload(f);
                  setGenerateOpen(true);
                }}
                hint={t("Generate questions from a document (PDF, PPTX or ODP)")}
                className="w-full"
              />
            )}
          </div>
        </EmptyState>
      ) : (
        <>
          <SortableOutline
            items={rows.map((row) => ({
              ...row,
              disabled: row.kind === "section" ? !editingSections : false,
            }))}
            onReorder={(items) => void persistOutline(items)}
            renderItem={(row, { handle }) => {
              const index = rows.findIndex((r) => r.id === row.id);
              const insertBar = editingSections && (
                <button
                  type="button"
                  onClick={() => void insertSectionAt(index)}
                  className="mb-2 w-full rounded-lg border border-dashed border-slate-300 py-1 text-xs text-slate-400 hover:border-brand-500 hover:text-brand-700 dark:border-slate-700 dark:hover:text-brand-300"
                >
                  + {t("Section here")}
                </button>
              );
              if (row.kind === "section") {
                return (
                  <>
                    {insertBar}
                    <div className="flex items-center gap-2 pt-2">
                      {handle}
                      <span className="text-brand-700 dark:text-brand-300" aria-hidden>
                        §
                      </span>
                      {editingSections ? (
                        <>
                          <SectionTitleField
                            section={row.section}
                            onRename={(id, title) => void renameSection(id, title)}
                          />
                          <Button
                            variant="ghost"
                            aria-label={t("Delete section {{title}}", {
                              title: localizedText(row.section.title),
                            })}
                            onClick={() => void deleteSection(row.section.id)}
                          >
                            <Trash2 aria-hidden className="h-4 w-4" />
                          </Button>
                        </>
                      ) : (
                        <h3 className="text-base font-bold text-slate-800 dark:text-slate-200">
                          {localizedText(row.section.title)}
                        </h3>
                      )}
                    </div>
                  </>
                );
              }
              const question = row.question;
              // Before/after pair (#54): mark both rows, offer "add
              // after-question" only for an eligible, unpaired choice/likert.
              const hasAfter = question.after_question != null;
              const paired = question.is_after || hasAfter;
              // #91: a persisted stale translation (one language edited after
              // the last sync) — surfaced here so it's visible without opening
              // the question.
              const hasStaleTranslation = Object.values(
                question.translation_stale ?? {},
              ).some((langs) => langs.length > 0);
              // Easy mode (#52): before/after is a Pro feature — hide the
              // action (existing pairs still render/work).
              const canAddAfter =
                !easyMode && !paired && CHOICE_KINDS.includes(question.kind);
              return (
                <>
                  {insertBar}
                  <div
                    className={`flex items-center gap-2 rounded-xl border bg-white px-3 py-2 dark:bg-slate-900 ${
                      paired
                        ? "border-slate-200 border-l-4 border-l-brand-400 dark:border-slate-800"
                        : "border-slate-200 dark:border-slate-800"
                    }`}
                  >
                    {handle}
                    <Link
                      to={`/sets/${id}/questions/${question.id}`}
                      className="min-w-0 flex-1"
                    >
                      <span className="flex items-center gap-2">
                        {paired && (
                          <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                            {question.is_after ? t("After") : t("Before")}
                          </span>
                        )}
                        {/* Phones (#179): two lines instead of ~12 characters. */}
                        <span className="block text-sm font-medium text-slate-900 max-sm:line-clamp-2 max-sm:[overflow-wrap:anywhere] sm:truncate dark:text-slate-100">
                          {stripHtml(localizedText(question.text)) || (
                            <span className="italic text-slate-400">{t("No question text")}</span>
                          )}
                        </span>
                      </span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {t(KIND_LABEL[question.kind])}
                        {question.kind !== "word_cloud" &&
                          question.kind !== "open_text" &&
                          ` · ${t("{{count}} answers", { count: question.options.length })}`}
                        {question.time_limit ? (<span className="inline-flex items-center gap-1"> · <Timer aria-hidden className="h-3.5 w-3.5" />{question.time_limit} s</span>) : null}
                      </span>
                    </Link>
                    {confirmDelete === question.id ? (
                      <ConfirmInline
                        message={
                          hasAfter
                            ? t("Delete this question and its after-question?")
                            : t("Delete question?")
                        }
                        onConfirm={() => void handleDelete(question.id)}
                        onCancel={() => setConfirmDelete(null)}
                      />
                    ) : (
                      <>
                        {/* #75 Phase 3: a self-check question without a solution
                            (no correct option / no model solution) gives the
                            learner no feedback — flag it. */}
                        {set.type === "self_check" && missingSolution(question) && (
                          <span
                            title={t(missingSolutionHint(question))}
                            className="inline-flex shrink-0 px-1 text-amber-500"
                          >
                            <TriangleAlert
                              aria-label={t(missingSolutionHint(question))}
                              className="h-4 w-4"
                            />
                          </span>
                        )}
                        {/* Pro only (#91): a persisted stale-translation flag,
                            sitting with the row actions. */}
                        {!easyMode && hasStaleTranslation && (
                          <span
                            title={t("translation may be outdated")}
                            className="inline-flex shrink-0 px-1 text-amber-500"
                          >
                            <Languages
                              aria-label={t("translation may be outdated")}
                              className="h-4 w-4"
                            />
                          </span>
                        )}
                        {!easyMode && set.type !== "self_check" && (
                          <Button
                            variant="ghost"
                            aria-label={t("Present this question")}
                            title={t("Present this question")}
                            onClick={() =>
                              window.open(
                                `/sets/${id}/present?question=${question.id}`,
                                "_blank",
                              )
                            }
                          >
                            <Play aria-hidden className="h-4 w-4" />
                          </Button>
                        )}
                        {/* Lernkontrolle (#75 phase 3): per-question deep
                            link into the standing practice page. */}
                        {set.type === "self_check" && selfCheckToken && (
                          <Button
                            variant="ghost"
                            aria-label={t("Copy link to this question")}
                            title={t("Copy link to this question")}
                            onClick={() =>
                              void copySelfCheckLink(
                                question.id,
                                selfCheck.url(selfCheckToken, question.id),
                              )
                            }
                          >
                            {copiedKey === question.id ? (
                              <Check aria-hidden className="h-4 w-4" />
                            ) : (
                              <Link2 aria-hidden className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                        <MoreMenu label={t("Question actions")}>
                          {!easyMode && (
                            <MenuItem onClick={() => void copyQuestionLink(question.id)}>
                              <Copy aria-hidden className="h-4 w-4" />
                              {t("Copy link")}
                            </MenuItem>
                          )}
                          <MenuItem onClick={() => void openXfer(question.id, "move")}>
                            <FolderInput aria-hidden className="h-4 w-4" />
                            {t("Move to another set …")}
                          </MenuItem>
                          <MenuItem onClick={() => void openXfer(question.id, "copy")}>
                            <Files aria-hidden className="h-4 w-4" />
                            {t("Copy to another set …")}
                          </MenuItem>
                          {canAddAfter && (
                            <MenuItem onClick={() => void handleAddAfter(question.id)}>
                              <CopyPlus aria-hidden className="h-4 w-4" />
                              {t("Add after-question")}
                            </MenuItem>
                          )}
                          <MenuItem danger onClick={() => setConfirmDelete(question.id)}>
                            <Trash2 aria-hidden className="h-4 w-4" />
                            {t("Delete")}
                          </MenuItem>
                        </MoreMenu>
                      </>
                    )}
                  </div>
                </>
              );
            }}
          />
          {editingSections && (
            <button
              type="button"
              onClick={() => void insertSectionAt(rows.length)}
              className="mt-2 w-full rounded-lg border border-dashed border-slate-300 py-1.5 text-sm text-slate-400 hover:border-brand-500 hover:text-brand-700 dark:border-slate-700 dark:hover:text-brand-300"
            >
              + {t("Section at the end")}
            </button>
          )}
        </>
      )}
      </div>
      {toastMessage && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">
          {toastMessage}
        </div>
      )}

      {/* Shared move/copy picker for a single question (#87), ported from
          QuestionPage's move modal. */}
      {xfer !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setXfer(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
              {xfer.mode === "move"
                ? t("Move to another question set …")
                : t("Copy to another question set …")}
            </h2>
            {xferTargets && xferTargets.length === 0 ? (
              <p className="text-sm text-slate-400">
                {xfer.mode === "move"
                  ? t("There is no other question set to move this to.")
                  : t("There is no other question set to copy this to.")}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <Field label={t("Room")}>
                  <select
                    value={xferRoom ?? undefined}
                    onChange={(event) => pickXferRoom(Number(event.target.value))}
                    className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {xferRooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("Question set")}>
                  {(() => {
                    // #75: disable target sets whose type forbids this
                    // question's kind — shown, but not selectable.
                    const xferKind = xfer
                      ? questions?.find((q) => q.id === xfer.id)?.kind
                      : undefined;
                    const roomTargets =
                      xferTargets?.filter((entry) => entry.room === xferRoom) ?? [];
                    const noneEligible =
                      roomTargets.length > 0 &&
                      !roomTargets.some(
                        (entry) =>
                          !xferKind || allowedKindsFor(entry.type).includes(xferKind),
                      );
                    return (
                      <>
                        <select
                          value={xferTarget ?? ""}
                          onChange={(event) => setXferTarget(Number(event.target.value))}
                          className="w-72 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        >
                          {xferTarget === null && (
                            <option value="" disabled>
                              {t("No eligible set")}
                            </option>
                          )}
                          {roomTargets.map((entry) => {
                            const disallowed =
                              !!xferKind &&
                              !allowedKindsFor(entry.type).includes(xferKind);
                            return (
                              <option key={entry.id} value={entry.id} disabled={disallowed}>
                                {localizedText(entry.title)}
                                {disallowed && ` — ${t("not allowed for this question type")}`}
                              </option>
                            );
                          })}
                        </select>
                        {noneEligible && (
                          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                            {t("No set in this room allows this question type.")}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </Field>
              </div>
            )}
            {xferError && <p className="mt-3 text-sm text-red-600">{xferError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setXfer(null)}>
                {t("Cancel")}
              </Button>
              {xferTargets && xferTargets.length > 0 && (
                <Button disabled={xferTarget === null} onClick={() => void confirmXfer()}>
                  {xfer.mode === "move" ? t("Move") : t("Copy")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pull picker (#87): copy several questions from a chosen source set
          into this one. */}
      {pullTargets !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setPullTargets(null)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
              {t("Add questions from another set …")}
            </h2>
            {pullTargets.length === 0 ? (
              <p className="text-sm text-slate-400">
                {t("There is no other set to copy questions from.")}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-3">
                  <Field label={t("Room")}>
                    <select
                      value={pullRoom ?? undefined}
                      onChange={(event) => pickPullRoom(Number(event.target.value))}
                      className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    >
                      {pullRooms.map((room) => (
                        <option key={room.id} value={room.id}>
                          {room.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("Question set")}>
                    <select
                      value={pullSourceSet ?? undefined}
                      onChange={(event) => pickPullSourceSet(Number(event.target.value))}
                      className="w-64 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    >
                      {pullTargets
                        .filter((entry) => entry.room === pullRoom)
                        .map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {localizedText(entry.title)}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>

                {pullQuestions && (() => {
                  // #75: the target set's type limits which question kinds may
                  // be copied in. Disallowed kinds stay visible but are shown
                  // disabled, so it's clear why they can't be picked.
                  const allowed = allowedKindsFor(set.type);
                  const selectableCount = pullQuestions.filter((q) =>
                    allowed.includes(q.kind),
                  ).length;
                  return (
                  <div className="mt-4 flex min-h-0 flex-1 flex-col">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                        {t("Questions")}
                      </span>
                      {selectableCount > 0 && (
                        <button
                          type="button"
                          onClick={toggleSelectAllPull}
                          className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
                        >
                          {pullSelected.size >= selectableCount
                            ? t("Deselect all")
                            : t("Select all")}
                        </button>
                      )}
                    </div>
                    <ul className="flex-1 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800">
                      {pullQuestions.length === 0 ? (
                        <li className="px-3 py-4 text-sm text-slate-400">
                          {t("No questions yet")}
                        </li>
                      ) : (
                        pullQuestions.map((question) => {
                          const disallowed = !allowed.includes(question.kind);
                          return (
                          <li
                            key={question.id}
                            className="border-b border-slate-100 last:border-b-0 dark:border-slate-800"
                          >
                            <label
                              className={`flex items-start gap-2 px-3 py-2 ${
                                disallowed
                                  ? "cursor-not-allowed opacity-60"
                                  : "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60"
                              }`}
                            >
                              <input
                                type="checkbox"
                                disabled={disallowed}
                                checked={!disallowed && pullSelected.has(question.id)}
                                onChange={() => togglePullQuestion(question.id)}
                                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 dark:border-slate-700 accent-brand-600 disabled:cursor-not-allowed"
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm text-slate-900 dark:text-slate-100">
                                  {stripHtml(localizedText(question.text)) || (
                                    <span className="italic text-slate-400">
                                      {t("No question text")}
                                    </span>
                                  )}
                                </span>
                                <span className="block text-xs text-slate-500 dark:text-slate-400">
                                  {t(KIND_LABEL[question.kind])}
                                  {disallowed && (
                                    <span className="text-amber-600 dark:text-amber-400">
                                      {" · "}
                                      {t("not allowed in this set type")}
                                    </span>
                                  )}
                                </span>
                              </span>
                            </label>
                          </li>
                          );
                        })
                      )}
                    </ul>
                  </div>
                  );
                })()}
              </>
            )}
            {pullError && <p className="mt-3 text-sm text-red-600">{pullError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPullTargets(null)}>
                {t("Cancel")}
              </Button>
              {pullTargets.length > 0 && (
                <Button
                  variant="primary"
                  disabled={pullSelected.size === 0 || pullBusy}
                  onClick={() => void confirmPull()}
                >
                  {pullBusy
                    ? t("Saving …")
                    : t("Copy {{count}} questions", { count: pullSelected.size })}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
