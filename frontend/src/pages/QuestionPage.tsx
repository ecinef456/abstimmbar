// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Check, ChevronLeft, ChevronRight, Eye, Files, FolderInput, ImageOff, ImagePlus, Link2, Pencil, Shuffle, TriangleAlert, X } from "lucide-react";
import {
  API_BASE_URL,
  api,
  type AnswerOption,
  type MindmapRatingMode,
  type Question,
  type QuestionSet,
  type RevealAnswers,
} from "../api";
import { useApp, useEasyMode } from "../App";
import {
  getDefaultContentLang,
  localizedMap,
  localizedText,
  setLocalizedLang,
  useTheme,
  type LocalizedText,
  RichText,
  isEmptyHtml,
  stripHtml,
  TranslationControlsSlot,
} from "@basicbar/ui";
import AiAssistPanel from "../components/AiAssistPanel";
import MindmapSeedEditor, {
  fromEditableSeed,
  seedProblem,
  toEditableSeed,
  type EditableSeedNode,
} from "../components/MindmapSeedEditor";
import HomeCrumb from "../components/HomeCrumb";
import SortableList from "../components/SortableList";
import TranslatableField from "../components/TranslatableField";
import { Button, Field, InfoHint, MenuItem, MoreMenu, SegmentedControl, TextInput, ToggleSwitch } from "../components/ui";
import { KIND_LABEL, REVEAL_LABEL } from "./SetPage";

function aiErrorText(err: unknown): string {
  try {
    return JSON.parse((err as Error).message).detail ?? String(err);
  } catch {
    return String(err);
  }
}

/** Which languages of a translatable field look outdated, computed live in
 * the editor (#91) so the amber marker appears the moment you edit one
 * language — no save needed. A language is stale when it is unchanged since
 * the field was loaded (its snapshot) and non-empty, while another language
 * HAS changed. With no live edit yet, fall back to the server's persisted
 * `translation_stale` (a stale state saved in an earlier session), unless the
 * author already brought the field back in sync this session (`synced`). */
function liveStaleLangs(
  baseline: LocalizedText,
  current: LocalizedText,
  serverStale: readonly string[],
  synced: boolean,
): string[] {
  const base = localizedMap(baseline);
  const cur = localizedMap(current);
  const langs = [...new Set([...Object.keys(base), ...Object.keys(cur)])];
  const raw = (m: Partial<Record<string, string>>, l: string) => m[l] ?? "";
  const anyChanged = langs.some((l) => raw(cur, l) !== raw(base, l));
  const stale = new Set<string>();
  for (const l of langs) {
    if (raw(cur, l) !== raw(base, l)) continue; // this language was touched
    if (isEmptyHtml(raw(cur, l))) continue; // empty → "not translated", not stale
    if (anyChanged) stale.add(l);
    else if (!synced && serverStale.includes(l)) stale.add(l);
  }
  return [...stale];
}

/** Options get a stable client-side id for drag-and-drop before they have a
 * server id (negative values never collide with real primary keys). Text is
 * kept as the full `{de, en}` map so each option can be edited bilingually
 * via TranslatableField (#33 MR2 Task 9). */
type EditableOption = Omit<AnswerOption, "text"> & { text: LocalizedText; clientId: number };
let nextClientId = -1;

// Mirrors backend Question.kind choices; used to validate the `?kind=`
// query param on a new (unsaved) question.
const QUESTION_KINDS = [
  "single_choice", "multiple_choice", "word_cloud", "likert",
  "open_text", "priorities", "ordering", "mindmap",
] as const;

/** Per-kind default options for a brand-new question, moved out of
 * `SetPage.addQuestion` now that creation is deferred to the first save. */
function defaultOptions(kind: string, template?: string | null): EditableOption[] {
  if (kind === "word_cloud" || kind === "open_text" || kind === "likert" || kind === "mindmap") return [];
  // The binary preset starts as Ja/Nein; the editor's template quick-fill
  // lets the author switch to Wahr/Falsch or type their own (#79).
  const texts = template === "binary" ? ["Ja", "Nein"] : ["", "", ""];
  return texts.map((text) => ({ clientId: nextClientId--, text, is_correct: false }));
}

/** Likert scales use a fixed step count (3–7 steps, plus optional
 * abstention) rather than freely editable items — that would make the
 * question plain single choice and break ordinal analyses (review
 * feedback). Only the two endpoints carry text (bilingual, #103); the emoji
 * preset instead fills one emoji per step (#86). */
const ABSTENTION = "Enthaltung";
// Labels are English source strings, translated with t() at the render site
// (same pattern as TIME_PRESETS below).
const LIKERT_PRESETS: {
  key: string;
  label: string;
  left?: LocalizedText;
  right?: LocalizedText;
  emoji?: boolean;
}[] = [
  {
    key: "agreement",
    label: "Agreement",
    left: { de: "Stimme nicht zu", en: "Disagree" },
    right: { de: "Stimme zu", en: "Agree" },
  },
  {
    key: "probability",
    label: "Probability",
    left: { de: "Unwahrscheinlich", en: "Unlikely" },
    right: { de: "Wahrscheinlich", en: "Likely" },
  },
  { key: "emoji", label: "Emoji", emoji: true },
];

const LIKERT_EMOJI: Record<number, string[]> = {
  3: ["😞", "😐", "😀"],
  4: ["😞", "🙁", "🙂", "😀"],
  5: ["😠", "😞", "😐", "🙂", "😀"],
  6: ["😡", "😞", "🙁", "🙂", "😀", "😍"],
  7: ["😡", "😠", "😞", "😐", "🙂", "😀", "😍"],
};

const emptyLoc: LocalizedText = { de: "", en: "" };

/** Typical time limits as one-click presets that fill the always-visible
 * seconds field; "keine" (empty) is the default, any other value can be
 * typed directly (#5). */
// Labels are English source strings, translated with t() at the render site.
const TIME_PRESETS: { label: string; value: string }[] = [
  { label: "none", value: "" },
  { label: "30 s", value: "30" },
  { label: "60 s", value: "60" },
  { label: "2 min", value: "120" },
  { label: "5 min", value: "300" },
];

// Free-text AI evaluation scales: two presets plus free categories.
// Labels are English source strings, translated with t() at the render site
// (same pattern as TIME_PRESETS below). The category VALUES stay German —
// they are authored content inserted into the question, not UI chrome.
const EVAL_PRESETS: { value: string; label: string; categories: string[] }[] = [
  { value: "correctness", label: "Correctness (correct · unclear · wrong)", categories: ["korrekt", "unklar", "falsch"] },
  { value: "sentiment", label: "Sentiment (positive · neutral · negative)", categories: ["positiv", "neutral", "negativ"] },
  { value: "custom", label: "Custom categories …", categories: [] },
];

function detectEvalPreset(categories: string[]): string {
  const eq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i].toLowerCase());
  const preset = EVAL_PRESETS.find((p) => p.categories.length && eq(categories, p.categories));
  return preset?.value ?? "custom";
}

function isEmojiOnly(s: string): boolean {
  return !!s && /^\p{Extended_Pictographic}$/u.test(s.trim());
}
function detectLikertPreset(left?: LocalizedText, right?: LocalizedText): string {
  // Compare per-language via localizedMap (not raw `.de`/`.en`) since
  // LocalizedText also accepts a legacy plain string.
  const eq = (a?: LocalizedText, b?: LocalizedText) => {
    const am = localizedMap(a);
    const bm = localizedMap(b);
    return am.de === bm.de && am.en === bm.en;
  };
  const match = LIKERT_PRESETS.find((p) => p.left && eq(p.left, left) && eq(p.right, right));
  return match ? match.key : "custom";
}

/** Question editor: rich text, kind-specific options, save on demand. */
export default function QuestionPage() {
  const { t } = useTranslation();
  const { setId, questionId } = useParams();
  const [searchParams] = useSearchParams();
  const isNew = questionId === "new";
  const navigate = useNavigate();
  const [question, setQuestion] = useState<Question | null>(null);
  const [set, setSet] = useState<QuestionSet | null>(null);
  const [text, setText] = useState<LocalizedText>("");
  // Snapshot of the question text per language as loaded (or last brought in
  // sync), so staleness can be flagged live while editing — see liveStaleLangs.
  const [textBaseline, setTextBaseline] = useState<LocalizedText>("");
  // Per-option text snapshot (keyed by clientId) for the same live staleness
  // check as the question text (#91). Answer options aren't tracked
  // server-side, so this is purely the in-editor live marker.
  const [optionBaseline, setOptionBaseline] = useState<Record<number, LocalizedText>>({});
  const setOptionSynced = (clientId: number, value: LocalizedText) =>
    setOptionBaseline((prev) => ({ ...prev, [clientId]: value }));
  // Fields to report as back-in-sync on the next save (#91): a machine
  // translation pre-fill or an explicit "Mark as up to date" click both
  // flag the field here so `synced_fields` reaches the API.
  const [syncedFields, setSyncedFields] = useState<Set<string>>(new Set());
  function markSynced(field: string) {
    setSyncedFields((prev) => new Set(prev).add(field));
  }
  const [shuffle, setShuffle] = useState(false);
  const [binaryChoice, setBinaryChoice] = useState(false);
  const [reveal, setReveal] = useState<"inherit" | RevealAnswers>("inherit");
  const [options, setOptions] = useState<EditableOption[]>([]);
  // #75 Phase 3: a self-check choice question without a marked correct answer
  // gives no feedback — warn before saving (questions may be copied around, so
  // it is allowed, just flagged).
  const [confirmNoCorrect, setConfirmNoCorrect] = useState(false);
  const [timeLimit, setTimeLimit] = useState("");
  const [likertPreset, setLikertPreset] = useState<string>("agreement");
  const [likertSteps, setLikertSteps] = useState(5);
  const [likertLeft, setLikertLeft] = useState<LocalizedText>({ de: "Stimme nicht zu", en: "Disagree" });
  const [likertRight, setLikertRight] = useState<LocalizedText>({ de: "Stimme zu", en: "Agree" });
  const [abstention, setAbstention] = useState(false);
  const [aiEvaluate, setAiEvaluate] = useState(false);
  const [evaluationHint, setEvaluationHint] = useState("");
  const [evalCategories, setEvalCategories] = useState<string[]>(["korrekt", "unklar", "falsch"]);
  const [evalScale, setEvalScale] = useState<string>("correctness");
  const [evalChart, setEvalChart] = useState(false);
  const [modelSolution, setModelSolution] = useState("");
  const [participantFeedback, setParticipantFeedback] = useState(false);
  const [wordcloudMaxAnswers, setWordcloudMaxAnswers] = useState(5);
  const [wordcloudBatchSubmit, setWordcloudBatchSubmit] = useState(false);
  const [wordcloudLive, setWordcloudLive] = useState(true);
  const [wordcloudAiEnabled, setWordcloudAiEnabled] = useState(false);
  const [wordcloudGrouping, setWordcloudGrouping] = useState("");
  // Free text: send the model solution along to the AI grouping (default on).
  const [groupingUseSolution, setGroupingUseSolution] = useState(true);
  // What the AI "Cleaned up" view merges (defaults mirror the backend).
  const [wordcloudMergeVariants, setWordcloudMergeVariants] = useState(true);
  const [wordcloudMergeSynonyms, setWordcloudMergeSynonyms] = useState(true);
  const [wordcloudMergeConcepts, setWordcloudMergeConcepts] = useState(false);
  // Mindmap (stage 1): root label, depth, terms per person, switches and the
  // predefined branches (outline editor). Defaults mirror the backend.
  const [mindmapRoot, setMindmapRoot] = useState<LocalizedText>(emptyLoc);
  const [mindmapDepth, setMindmapDepth] = useState(5);
  const [mindmapMaxPerPerson, setMindmapMaxPerPerson] = useState(10);
  const [mindmapDescriptions, setMindmapDescriptions] = useState(false);
  const [mindmapHighlight, setMindmapHighlight] = useState(true);
  const [mindmapSeed, setMindmapSeed] = useState<EditableSeedNode[]>([]);
  // Optional rating phase after collecting ("" = off).
  const [mindmapRatingMode, setMindmapRatingMode] = useState<MindmapRatingMode>("");
  const [mindmapRatingBudget, setMindmapRatingBudget] = useState(5);
  const [mindmapRatingMulti, setMindmapRatingMulti] = useState(true);
  const [mindmapRatingLive, setMindmapRatingLive] = useState(false);
  // Server refusal for the rating mode (locked while a running session has
  // ratings), shown at the field.
  const [ratingModeError, setRatingModeError] = useState("");
  const [saving, setSaving] = useState(false);
  // #74: switch between editing and an interactive participant preview (iframe).
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [previewNonce, setPreviewNonce] = useState(0);
  const [error, setError] = useState("");
  const [moveTargets, setMoveTargets] = useState<QuestionSet[] | null>(null);
  const [moveMode, setMoveMode] = useState<"move" | "copy">("move");
  const [moveRooms, setMoveRooms] = useState<{ id: number; title: string }[]>([]);
  const [moveRoom, setMoveRoom] = useState<number | null>(null);
  const [moveTarget, setMoveTarget] = useState<number | null>(null);
  const [moveError, setMoveError] = useState("");
  const { whoami } = useApp();
  const easyMode = useEasyMode();
  // #73: the preview iframe is cross-origin in dev and can't read the app's
  // localStorage, so pass the resolved theme explicitly via ?theme=.
  const { appearance } = useTheme();
  const previewTheme =
    appearance === "dark"
      ? "dark"
      : appearance === "light"
        ? "light"
        : window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
  const aiEnabled = !!whoami?.ai_enabled && !easyMode;
  const [aiBusy, setAiBusy] = useState<"" | "distractors" | "rephrase">("");
  const [aiError, setAiError] = useState("");
  const [aiDistractorError, setAiDistractorError] = useState("");
  const [aiDistractors, setAiDistractors] = useState<string[]>([]);
  const [aiVariants, setAiVariants] = useState<string[]>([]);
  // #92: page between the set's questions from the editor. siblingIds is the
  // set's questions in order; a baseline snapshot detects unsaved edits.
  const [siblingIds, setSiblingIds] = useState<number[]>([]);
  const [pendingNav, setPendingNav] = useState<number | null>(null);
  const baselineRef = useRef<string>("");

  useEffect(() => {
    void api.getQuestionSet(Number(setId)).then(setSet);
    if (isNew) {
      const raw = searchParams.get("kind") ?? "single_choice";
      const kind = (QUESTION_KINDS as readonly string[]).includes(raw)
        ? (raw as Question["kind"])
        : "single_choice";
      const template = searchParams.get("template");
      // Synthetic question so kind-based derivations and the `!question`
      // render guard work; id 0 until the first save creates the real row.
      setQuestion({ id: 0, kind, is_after: false } as Question);
      setText("");
      setTextBaseline("");
      setBinaryChoice(template === "binary");
      setOptions(defaultOptions(kind, template));
      setOptionBaseline({});
      return;
    }
    // Already have this question in state (e.g. just created via save →
    // URL replaced to the real id) — don't refetch and clobber live edits.
    if (question && question.id === Number(questionId)) return;
    void api.getQuestion(Number(questionId)).then((data) => {
      setQuestion(data);
      setText(data.text);
      setTextBaseline(data.text);
      setShuffle(data.shuffle_options);
      setBinaryChoice(data.binary_choice ?? false);
      setReveal(data.reveal_answers);
      setAiEvaluate(data.ai_evaluate);
      setEvaluationHint(data.evaluation_hint);
      const cats = data.evaluation_categories?.length
        ? data.evaluation_categories
        : ["korrekt", "unklar", "falsch"];
      setEvalCategories(cats);
      setEvalScale(detectEvalPreset(cats));
      setEvalChart(data.evaluation_chart);
      setModelSolution(data.model_solution ?? "");
      setParticipantFeedback(data.participant_feedback ?? false);
      setWordcloudMaxAnswers(data.wordcloud_max_answers ?? 5);
      setWordcloudBatchSubmit(data.wordcloud_batch_submit ?? false);
      setWordcloudLive(data.wordcloud_live);
      setWordcloudAiEnabled(data.wordcloud_ai_enabled);
      setWordcloudGrouping(data.wordcloud_grouping);
      setGroupingUseSolution(data.wordcloud_grouping_use_solution ?? true);
      setWordcloudMergeVariants(data.wordcloud_merge_variants ?? true);
      setWordcloudMergeSynonyms(data.wordcloud_merge_synonyms ?? true);
      setWordcloudMergeConcepts(data.wordcloud_merge_concepts ?? false);
      setMindmapRoot(data.mindmap_root ?? emptyLoc);
      setMindmapDepth(data.mindmap_depth ?? 5);
      setMindmapMaxPerPerson(data.mindmap_max_per_person ?? 10);
      setMindmapDescriptions(data.mindmap_descriptions ?? false);
      setMindmapHighlight(data.mindmap_highlight_duplicates ?? true);
      setMindmapSeed(toEditableSeed(data.mindmap_seed));
      setMindmapRatingMode(data.mindmap_rating_mode ?? "");
      setMindmapRatingBudget(data.mindmap_rating_budget ?? 5);
      setMindmapRatingMulti(data.mindmap_rating_multi ?? true);
      setMindmapRatingLive(data.mindmap_rating_live ?? false);
      setTimeLimit(data.time_limit ? String(data.time_limit) : "");
      // Options keep the full {de, en} map so each can be edited bilingually
      // (#33 MR2 Task 9).
      const editableOptions = data.options.map((option) => ({
        ...option,
        clientId: option.id ?? nextClientId--,
      }));
      if (data.kind === "likert") {
        const scale = editableOptions.filter((o) => !o.is_abstention);
        setLikertSteps(Math.min(7, Math.max(3, scale.length || 5)));
        setAbstention(editableOptions.some((option) => option.is_abstention));
        const allEmoji =
          scale.length > 0 && scale.every((o) => isEmojiOnly(localizedText(o.text)));
        if (allEmoji) {
          setLikertPreset("emoji");
        } else {
          setLikertLeft(scale[0]?.text ?? emptyLoc);
          setLikertRight(scale[scale.length - 1]?.text ?? emptyLoc);
          setLikertPreset(detectLikertPreset(scale[0]?.text, scale[scale.length - 1]?.text));
        }
      }
      setOptions(editableOptions);
      setOptionBaseline(
        Object.fromEntries(editableOptions.map((o) => [o.clientId, o.text])),
      );
    });
  }, [questionId]);

  // #92: the set's question order, for the previous/next arrows.
  useEffect(() => {
    if (isNew) {
      setSiblingIds([]);
      return;
    }
    void api
      .listQuestions(Number(setId))
      .then((page) => setSiblingIds(page.results.map((q) => q.id)));
  }, [setId, isNew]);

  // Baseline of the editable fields, recaptured whenever a question loads or is
  // saved (setQuestion replaces the object), so isDirty() is false right after.
  useEffect(() => {
    if (question) baselineRef.current = editSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question]);

  // Clear the stale error banner (validation guard or a prior save's server
  // error) as soon as the user edits the text or the options — otherwise it
  // lingers even after the field that triggered it is fixed (#90/#100).
  useEffect(() => {
    setError("");
  }, [text, options]);

  // #75 Phase 3: a brand-new free-text question in a Lernkontrolle starts with
  // AI evaluation (and own-answer feedback) on — that is the point of the type.
  useEffect(() => {
    if (isNew && set?.type === "self_check" && question?.kind === "open_text" && aiEnabled) {
      setAiEvaluate(true);
      setParticipantFeedback(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, set?.type, question?.kind, aiEnabled]);

  function updateOption(clientId: number, patch: Partial<EditableOption>) {
    setOptions((current) =>
      current.map((option) => {
        if (option.clientId !== clientId) return option;
        const updated = { ...option, ...patch };
        return updated;
      }),
    );
  }

  async function uploadOptionImage(clientId: number, file: File) {
    const uploaded = await api.uploadImage(file);
    updateOption(clientId, { image: uploaded.url });
  }

  function setCorrect(clientId: number, checked: boolean) {
    setOptions((current) =>
      current.map((option) => {
        if (option.clientId === clientId) return { ...option, is_correct: checked };
        // Single choice: at most one correct answer.
        if (checked && question?.kind === "single_choice")
          return { ...option, is_correct: false };
        return option;
      }),
    );
  }

  // Binary template quick-fill (#79): overwrite the two option texts with a
  // preset (Ja/Nein or Wahr/Falsch), keeping which one is marked correct.
  function applyBinaryTemplate(texts: [string, string]) {
    setOptions((current) =>
      texts.map((text, i) => ({
        clientId: current[i]?.clientId ?? nextClientId--,
        text,
        is_correct: current[i]?.is_correct ?? false,
      })),
    );
  }

  function likertOptions(): AnswerOption[] {
    const n = Math.min(7, Math.max(3, likertSteps));
    const preset = LIKERT_PRESETS.find((p) => p.key === likertPreset);
    // Reuse the existing option rows by position so a re-save UPDATES them
    // instead of delete+recreate — otherwise votes (which point at option ids)
    // are orphaned on every edit (#86). `options` holds the loaded rows.
    const existingScale = options.filter((o) => !o.is_abstention);
    const existingAbstention = options.find((o) => o.is_abstention);
    const withId = (i: number, rest: AnswerOption): AnswerOption =>
      existingScale[i]?.id ? { id: existingScale[i].id, ...rest } : rest;
    let result: AnswerOption[];
    if (preset?.emoji) {
      result = (LIKERT_EMOJI[n] ?? LIKERT_EMOJI[5]).map((e, i) =>
        withId(i, { text: { de: e, en: e }, is_correct: false }),
      );
    } else {
      result = Array.from({ length: n }, (_, i) =>
        withId(i, {
          text: i === 0 ? likertLeft : i === n - 1 ? likertRight : emptyLoc,
          is_correct: false,
        }),
      );
    }
    if (abstention) {
      result.push({
        ...(existingAbstention?.id ? { id: existingAbstention.id } : {}),
        text: { de: ABSTENTION, en: "Abstain" },
        is_correct: false,
        is_abstention: true,
      });
    }
    return result;
  }

  // #75 Phase 3: a self-check question without a solution gives the learner
  // no feedback. Warn on save (bypassable), never block.
  const missingSolutionForSelfCheck =
    set?.type === "self_check" &&
    !!question &&
    (((question.kind === "single_choice" || question.kind === "multiple_choice") &&
      !options.some((o) => o.is_correct && !o.is_abstention)) ||
      (question.kind === "open_text" && !modelSolution.trim()));
  const missingSolutionMessage =
    question?.kind === "open_text"
      ? "No model solution entered. Learners then get no feedback on this question in the self-check. Save anyway?"
      : "No correct answer is marked. Learners then get no feedback on this question in the self-check. Save anyway?";

  async function save({
    stay = false,
    extraSynced = [],
  }: { stay?: boolean; extraSynced?: string[] } = {}) {
    if (!question) return false;
    if (invalid) {
      setError(
        textMissing
          ? t("Question text is required.")
          : mindmapProblem
            ? t(mindmapProblem.key, mindmapProblem.values)
            : t("Add at least two answer options, each with text."),
      );
      return false;
    }
    setSaving(true);
    setError("");
    try {
      const parsedLimit = parseInt(timeLimit, 10);
      const textKind = question.kind === "word_cloud" || question.kind === "open_text";
      const payload = {
        kind: question.kind,
        text,
        shuffle_options: shuffle,
        binary_choice: question.kind === "single_choice" && binaryChoice,
        reveal_answers:
          question.kind === "single_choice" || question.kind === "multiple_choice"
            ? reveal
            : "inherit",
        ai_evaluate: question.kind === "open_text" && aiEvaluate,
        evaluation_hint: question.kind === "open_text" ? evaluationHint : "",
        evaluation_categories:
          question.kind === "open_text"
            ? evalCategories.map((c) => c.trim()).filter(Boolean)
            : ["korrekt", "unklar", "falsch"],
        evaluation_chart: question.kind === "open_text" && evalChart,
        model_solution: question.kind === "open_text" ? modelSolution : "",
        participant_feedback: question.kind === "open_text" && participantFeedback,
        // #88: a single answer is wordcloud_max_answers === 1; allow_multiple
        // is derived server-side too, but send it for older code paths.
        allow_multiple: question.kind === "word_cloud" && wordcloudMaxAnswers !== 1,
        wordcloud_max_answers:
          question.kind === "word_cloud" ? wordcloudMaxAnswers : 0,
        wordcloud_batch_submit:
          question.kind === "word_cloud" &&
          wordcloudMaxAnswers !== 1 &&
          wordcloudBatchSubmit,
        wordcloud_live: question.kind !== "word_cloud" || wordcloudLive,
        // Word clouds (AI cleanup) and free text (AI key statements) share
        // these fields; other kinds reset them.
        wordcloud_ai_enabled: textKind && wordcloudAiEnabled,
        wordcloud_grouping: textKind ? wordcloudGrouping : "",
        wordcloud_grouping_use_solution: groupingUseSolution,
        wordcloud_merge_variants: wordcloudMergeVariants,
        wordcloud_merge_synonyms: wordcloudMergeSynonyms,
        wordcloud_merge_concepts: wordcloudMergeConcepts,
        // Mindmap settings are only sent for a mindmap (others keep defaults).
        ...(question.kind === "mindmap"
          ? {
              mindmap_root: mindmapRoot,
              mindmap_depth: mindmapDepth,
              mindmap_max_per_person: mindmapMaxPerPerson,
              mindmap_descriptions: mindmapDescriptions,
              mindmap_highlight_duplicates: mindmapHighlight,
              mindmap_seed: fromEditableSeed(mindmapSeed),
              mindmap_rating_mode: mindmapRatingMode,
              mindmap_rating_budget: mindmapRatingBudget,
              mindmap_rating_multi: mindmapRatingMulti,
              mindmap_rating_live: mindmapRatingLive,
            }
          : {}),
        time_limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null,
        // #91: report fields whose (non-canonical) translation now matches
        // what's being saved, so the API re-baselines their sync state.
        synced_fields: Array.from(new Set([...syncedFields, ...extraSynced])),
        options:
          question.kind === "word_cloud" || question.kind === "open_text" ||
          question.kind === "mindmap"
            ? []
            : question.kind === "likert"
              ? likertOptions()
              : filledOptions.map(({ clientId, id, ...option }) => ({
                  ...(id ? { id } : {}),
                  ...option,
                })),
      };
      if (isNew) {
        const created = await api.createQuestion({
          question_set: Number(setId),
          ...payload,
        });
        setQuestion(created);
        setTextBaseline(created.text);
        setSyncedFields(new Set());
        if (stay) {
          // Adopt the real id so the editor leaves new mode; the effect
          // re-runs once on the new questionId and reloads the saved data.
          navigate(`/sets/${setId}/questions/${created.id}`, { replace: true });
        } else {
          navigate(`/sets/${setId}`);
        }
        return true;
      }
      const updated = await api.updateQuestion(question.id, payload);
      // Refresh from the response (not just clear local edit state) so a
      // freshly-stale `translation_stale` from the API shows up (#91).
      setQuestion(updated);
      setSyncedFields(new Set());
      if (!stay) navigate(`/sets/${setId}`);
      return true;
    } catch (err) {
      let modeError = "";
      try {
        const body = JSON.parse((err as Error).message);
        const msg = body?.mindmap_rating_mode;
        modeError = Array.isArray(msg) ? String(msg[0] ?? "") : typeof msg === "string" ? msg : "";
      } catch {
        /* not a JSON body */
      }
      setRatingModeError(modeError ? t(modeError) : "");
      setError(modeError ? t(modeError) : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  // #74: save first (so the preview reflects the stored state), then show the
  // interactive participant preview in an iframe. The nonce reloads the iframe.
  async function showPreview() {
    if (await save({ stay: true })) {
      setPreviewNonce((n) => n + 1);
      setTab("preview");
    }
  }

  async function openMove(mode: "move" | "copy" = "move") {
    setMoveMode(mode);
    // Two-stage picker (review feedback): choose the room first, then one
    // of its sets. Defaults to the room the question currently lives in.
    const [page, currentSet] = await Promise.all([
      api.listAllQuestionSets(),
      api.getQuestionSet(Number(setId)),
    ]);
    const targets = page.results.filter((entry) => entry.id !== Number(setId));
    const rooms = [
      ...new Map(targets.map((entry) => [entry.room, entry.room_title])),
    ].map(([id, title]) => ({ id, title }));
    const startRoom = rooms.some((room) => room.id === currentSet.room)
      ? currentSet.room
      : (rooms[0]?.id ?? null);
    setMoveTargets(targets);
    setMoveRooms(rooms);
    setMoveRoom(startRoom);
    setMoveTarget(targets.find((entry) => entry.room === startRoom)?.id ?? null);
    setMoveError("");
  }

  function pickMoveRoom(roomId: number) {
    setMoveRoom(roomId);
    setMoveTarget(
      moveTargets?.find((entry) => entry.room === roomId)?.id ?? null,
    );
  }

  async function handleMove() {
    if (!question || moveTarget === null) return;
    setMoveError("");
    try {
      if (moveMode === "copy") {
        await api.copyQuestions(moveTarget, [question.id]);
      } else {
        await api.moveQuestion(question.id, moveTarget);
      }
      // A copy leaves this question in place; go to the target either way so
      // the result is visible.
      navigate(`/sets/${moveTarget}`);
    } catch (err) {
      try {
        setMoveError(JSON.parse((err as Error).message).detail ?? String(err));
      } catch {
        setMoveError(String(err));
      }
    }
  }

  async function runDistractors() {
    if (!question) return;
    setAiBusy("distractors");
    setAiDistractorError("");
    setAiDistractors([]);
    try {
      const payload = {
        text: localizedText(text),
        options: options.map((o) => ({ text: localizedText(o.text), is_correct: o.is_correct })),
        count: 3,
      };
      // Not saved yet — no question id to scope the endpoint to, so use the
      // set-scoped variant instead (same logic, reads the draft body).
      const { distractors } = isNew
        ? await api.aiDistractorsForSet(Number(setId), payload)
        : await api.aiDistractors(question.id, payload);
      setAiDistractors(distractors);
      if (distractors.length === 0) setAiDistractorError(t("No suggestions received."));
    } catch (err) {
      setAiDistractorError(aiErrorText(err));
    } finally {
      setAiBusy("");
    }
  }

  async function runRephrase() {
    if (!question) return;
    setAiBusy("rephrase");
    setAiError("");
    setAiVariants([]);
    try {
      // Not saved yet — use the set-scoped variant (see runDistractors above).
      const { variants } = isNew
        ? await api.aiRephraseForSet(Number(setId), localizedText(text))
        : await api.aiRephrase(question.id, localizedText(text));
      setAiVariants(variants);
      if (variants.length === 0) setAiError(t("No suggestions received."));
    } catch (err) {
      setAiError(aiErrorText(err));
    } finally {
      setAiBusy("");
    }
  }

  function applyDistractor(value: string) {
    // Binary (Ja/Nein, Wahr/Falsch) must stay exactly two options — never add
    // a third one here (#101; the AI panel is also hidden for binary above,
    // this is defense-in-depth).
    if (binaryChoice) return;
    setOptions((current) => {
      // Fill the first empty option before adding a new row (review feedback).
      const emptyIndex = current.findIndex(
        (option) => !localizedText(option.text).trim() && !option.image,
      );
      const canonical = getDefaultContentLang() as "de" | "en";
      if (emptyIndex >= 0) {
        return current.map((option, index) =>
          index === emptyIndex
            ? { ...option, text: setLocalizedLang(option.text, canonical, value) }
            : option,
        );
      }
      return [...current, { clientId: nextClientId--, text: value, is_correct: false }];
    });
    setAiDistractors((current) => current.filter((item) => item !== value));
  }

  if (!question) return null;
  const isLikert = question.kind === "likert";
  const isMindmap = question.kind === "mindmap";
  const isChoice =
    question.kind !== "word_cloud" &&
    question.kind !== "open_text" &&
    !isMindmap &&
    !isLikert;
  const isPriorities = question.kind === "priorities";
  const isOrdering = question.kind === "ordering";
  // Kinds with a "correct answer" concept. Priorities, Ordering and Likert
  // use the option list but have no correct answer (#58, #72).
  const hasCorrect =
    question.kind === "single_choice" || question.kind === "multiple_choice";

  // Content validity (#32/#23): canonical-language question text required
  // (image-only text counts); option-bearing kinds need >=2 filled options
  // (text or image). Mirrors the backend QuestionSerializer.validate rule.
  const canonicalLang = getDefaultContentLang() as "de" | "en";
  const canonicalHtml = localizedMap(text)[canonicalLang] ?? "";
  const textMissing = isEmptyHtml(canonicalHtml);
  // Ignore unfilled trailing options (e.g. a freshly-added blank row) rather
  // than failing validation on their account — only options that actually
  // carry text or an image count, and only those are sent to the backend
  // (#90, #100; applies to single/multiple choice, priorities and ordering
  // alike, since they all share this option list).
  const filledOptions = options.filter(
    (o) => (localizedMap(o.text)[canonicalLang] ?? "").trim() !== "" || !!o.image,
  );
  const optionsMissing = isChoice && filledOptions.length < 2;
  // Mindmap: the predefined branches must fit the depth, have a term each and
  // no duplicate siblings (mirrors backend rooms/mindmap.clean_seed).
  const mindmapProblem = isMindmap
    ? seedProblem(fromEditableSeed(mindmapSeed), mindmapDepth)
    : null;
  const invalid = textMissing || optionsMissing || !!mindmapProblem;

  // Serialized editable state — compared against the baseline to know whether
  // there are unsaved changes before paging to another question (#92).
  function editSnapshot() {
    return JSON.stringify({
      text, shuffle, binaryChoice, reveal, options,
      timeLimit, likertPreset, abstention,
      // Likert step count and endpoint labels live outside `options` until
      // save (likertOptions() bakes them in), so the unsaved-changes guard
      // must watch them directly — otherwise editing only an endpoint label or
      // the step count and hitting the next-arrow discards it silently (#86).
      likertSteps, likertLeft, likertRight,
      aiEvaluate, evaluationHint, evalCategories, evalScale, evalChart,
      modelSolution, participantFeedback,
      wordcloudMaxAnswers, wordcloudBatchSubmit, wordcloudLive,
      wordcloudAiEnabled, wordcloudGrouping, groupingUseSolution,
      wordcloudMergeVariants, wordcloudMergeSynonyms, wordcloudMergeConcepts,
      mindmapRoot, mindmapDepth, mindmapMaxPerPerson, mindmapDescriptions,
      mindmapHighlight, mindmapSeed: fromEditableSeed(mindmapSeed),
      mindmapRatingMode, mindmapRatingBudget, mindmapRatingMulti, mindmapRatingLive,
    });
  }

  const currentIdx = siblingIds.indexOf(Number(questionId));
  const prevId = currentIdx > 0 ? siblingIds[currentIdx - 1] : null;
  const nextId =
    currentIdx >= 0 && currentIdx < siblingIds.length - 1
      ? siblingIds[currentIdx + 1]
      : null;

  function goToQuestion(id: number | null) {
    if (id == null) return;
    if (!isNew && editSnapshot() !== baselineRef.current) setPendingNav(id);
    else navigate(`/sets/${setId}/questions/${id}`);
  }

  async function saveAndGo() {
    if (pendingNav == null) return;
    const target = pendingNav;
    const ok = await save({ stay: true });
    if (ok) {
      setPendingNav(null);
      navigate(`/sets/${setId}/questions/${target}`);
    }
  }

  const breadcrumb = (leaf: string) => (
    <nav className="mb-4 text-sm text-slate-500 dark:text-slate-400">
      <HomeCrumb />{" "}
      /{" "}
      {set && (
        <>
          <Link
            to={`/rooms/${set.room}`}
            className="hover:text-brand-700 dark:hover:text-brand-300"
          >
            {set.room_title}
          </Link>{" "}
          /{" "}
        </>
      )}
      <Link to={`/sets/${setId}`} className="hover:text-brand-700 dark:hover:text-brand-300">
        {set ? localizedText(set.title) : t("Question set")}
      </Link>{" "}
      / {leaf}
    </nav>
  );

  // Locked after-question (#54): content mirrors the before-question and is
  // edited there — show a read-only preview + a link, no editable fields.
  if (question.is_after) {
    return (
      <div className="max-w-2xl">
        {breadcrumb(t("After-question"))}
        <div className="mb-4 rounded-xl border border-brand-200 bg-brand-50/60 px-4 py-3 dark:border-brand-900 dark:bg-brand-950/40">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {t("This is an after-question. Its content mirrors the before-question and is edited there.")}
          </p>
          <Link
            to={`/sets/${setId}/questions/${question.before_question}`}
            className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:underline dark:text-brand-300"
          >
            <Link2 aria-hidden className="h-4 w-4" />
            {t("Open before-question")}
          </Link>
        </div>
        <div className="grid gap-4">
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              {t("Question text")}
            </span>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900/60">
              {localizedText(text) ? (
                <RichText html={localizedText(text)} />
              ) : (
                <span className="italic text-slate-400">{t("No question text")}</span>
              )}
            </div>
          </div>
          {(isChoice || isLikert) && (
            <div>
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                {isLikert ? t("Scale") : t("Answer options")}
              </span>
              <ul className="grid gap-1.5">
                {options.map((option) => (
                  <li
                    key={option.clientId}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
                  >
                    {option.is_correct && (
                      <Check aria-label={t("Correct")} className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    )}
                    <span className="text-slate-700 dark:text-slate-200">
                      {localizedText(option.text) || <span className="italic text-slate-400">—</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="mt-5">
          <Button variant="ghost" onClick={() => navigate(`/sets/${setId}`)}>
            {t("Back")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      {breadcrumb(t("Edit question"))}

      <span className="mb-4 inline-block shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-950 dark:text-brand-300">
        {t(KIND_LABEL[question.kind])}
      </span>

      {question.after_question != null && (
        <div className="mb-4 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <Link2 aria-hidden className="h-3.5 w-3.5" />
          {t("This question has an after-question — its content follows this one.")}{" "}
          <Link
            to={`/sets/${setId}/questions/${question.after_question}`}
            className="font-semibold text-brand-700 hover:underline dark:text-brand-300"
          >
            {t("Open after-question")}
          </Link>
        </div>
      )}

      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {!isNew && (
            <>
              {/* aria-disabled (not the disabled attribute) so the native
                  title tooltip still shows at the ends of the list, where the
                  button is greyed out (#92 follow-up). */}
              <Button
                variant="ghost"
                aria-label={t("Previous question")}
                title={t("Previous question")}
                aria-disabled={prevId == null || saving}
                className={prevId == null || saving ? "opacity-40 cursor-not-allowed" : ""}
                onClick={() => {
                  if (prevId != null && !saving) goToQuestion(prevId);
                }}
              >
                <ChevronLeft aria-hidden className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                aria-label={t("Next question")}
                title={t("Next question")}
                aria-disabled={nextId == null || saving}
                className={nextId == null || saving ? "opacity-40 cursor-not-allowed" : ""}
                onClick={() => {
                  if (nextId != null && !saving) goToQuestion(nextId);
                }}
              >
                <ChevronRight aria-hidden className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
        <SegmentedControl
          ariaLabel={t("View")}
          value={tab}
          disabled={saving}
          onChange={(v) => (v === "preview" ? void showPreview() : setTab("edit"))}
          options={[
            {
              value: "edit",
              label: (
                <>
                  <Pencil aria-hidden className="h-3.5 w-3.5" />
                  {t("Edit")}
                </>
              ),
            },
            {
              value: "preview",
              label: (
                <>
                  <Eye aria-hidden className="h-3.5 w-3.5" />
                  {t("Preview")}
                </>
              ),
            },
          ]}
        />
        {!isNew && (
          <MoreMenu label={t("Question actions")}>
            <MenuItem onClick={() => void openMove("copy")}>
              <Files aria-hidden className="h-4 w-4" />
              {t("Copy to another question set …")}
            </MenuItem>
            <MenuItem onClick={() => void openMove("move")}>
              <FolderInput aria-hidden className="h-4 w-4" />
              {t("Move to another question set …")}
            </MenuItem>
          </MoreMenu>
        )}
      </div>

      {tab === "preview" && (
        <div className="mx-auto max-w-sm overflow-hidden rounded-2xl border border-slate-200 shadow-sm dark:border-slate-700">
          <iframe
            key={previewNonce}
            title={t("Preview")}
            src={`${API_BASE_URL}/question-preview/${question.id}/?theme=${previewTheme}`}
            className="h-[640px] w-full bg-white dark:bg-slate-950"
          />
        </div>
      )}

      {tab === "edit" && (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5" data-tour="question.editor">
        {/* minmax(0,1fr): an implicit `auto` track grows to its widest
            child's min-content (the rich-text toolbar) and overflowed phones
            (#179). On phones the translation controls dock into the slot,
            first grid item, instead of floating over the editor. */}
        <TranslationControlsSlot />
        <div data-tour="question.lang-tabs">
          <TranslatableField
            variant="rich"
            label={t("Question text")}
            value={text}
            onChange={setText}
            stale={liveStaleLangs(
              textBaseline,
              text,
              question?.translation_stale?.text ?? [],
              syncedFields.has("text"),
            )}
            onTranslated={(lang, value) => {
              // The translation just made both languages match again: move the
              // baseline to the new state so it's no longer flagged live, and
              // record the sync on the next save.
              setTextBaseline(setLocalizedLang(text, lang, value));
              markSynced("text");
            }}
            onMarkSynced={() => {
              setTextBaseline(text);
              markSynced("text");
              void save({ stay: true, extraSynced: ["text"] });
            }}
          />
        </div>
        {textMissing && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">
            {t("Question text is required.")}
          </p>
        )}

        {aiEnabled && (
          <AiAssistPanel title={t("Rephrase question")}>
            <Button onClick={() => void runRephrase()} disabled={aiBusy === "rephrase"}>
              {aiBusy === "rephrase" ? t("Generating …") : t("Generate suggestions")}
            </Button>
            {aiVariants.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {aiVariants.map((variant, index) => (
                  <li key={index}>
                    <button
                      type="button"
                      onClick={() => {
                        // Rephrasing is generated from (and replaces) the
                        // canonical language only — any existing translation
                        // in the other language is left in place.
                        setText((current) => setLocalizedLang(current, getDefaultContentLang() as "de" | "en", variant));
                        setAiVariants([]);
                      }}
                      className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-brand-500 dark:border-slate-700"
                    >
                      {variant}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {aiError && <p className="mt-1 text-sm text-red-600">{aiError}</p>}
          </AiAssistPanel>
        )}

        {isChoice && (
          <>
            <div>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  {t("Answer options")}
                </span>
                {hasCorrect && (
                  <span className="text-xs text-slate-400">
                    {t("Checkbox = correct answer")}
                  </span>
                )}
                {isPriorities && (
                  <span className="text-xs text-slate-400">
                    {t("Participants distribute up to 100 points")}
                  </span>
                )}
              </div>
              {isOrdering && (
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                  {t("The option order is the correct solution — participants see it shuffled.")}
                </p>
              )}
              {binaryChoice && (
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="text-slate-500 dark:text-slate-400">{t("Template")}</span>
                  <button
                    type="button"
                    onClick={() => applyBinaryTemplate(["Ja", "Nein"])}
                    className="rounded-full border border-slate-300 px-3 py-1 text-slate-600 transition-colors hover:border-brand-500 hover:text-brand-700 dark:border-slate-700 dark:text-slate-300 dark:hover:text-brand-300"
                  >
                    {t("Yes/No")}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyBinaryTemplate(["Wahr", "Falsch"])}
                    className="rounded-full border border-slate-300 px-3 py-1 text-slate-600 transition-colors hover:border-brand-500 hover:text-brand-700 dark:border-slate-700 dark:text-slate-300 dark:hover:text-brand-300"
                  >
                    {t("True/False")}
                  </button>
                </div>
              )}
              <SortableList
                items={options.map((option) => ({ ...option, id: option.clientId }))}
                onReorder={(items) =>
                  setOptions(
                    items.map(
                      (item) =>
                        options.find((option) => option.clientId === item.id)!,
                    ),
                  )
                }
                renderItem={(item) => (
                  <>
                    {hasCorrect && (
                      <input
                        type="checkbox"
                        aria-label={t("Mark as correct")}
                        checked={item.is_correct}
                        onChange={(event) => setCorrect(item.id, event.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                      />
                    )}
                    <TranslatableField
                      value={item.text}
                      placeholder={t("Answer text")}
                      ariaLabel={t("Answer text")}
                      onChange={(text) => updateOption(item.id, { text })}
                      // Phones (#179): the input takes a full row of its
                      // own below the handle/checkbox/image/delete row.
                      className="min-w-0 flex-1 max-sm:order-last max-sm:basis-full"
                      stale={liveStaleLangs(
                        optionBaseline[item.id] ?? "",
                        item.text,
                        [],
                        false,
                      )}
                      onTranslated={(lang, value) =>
                        setOptionSynced(item.id, setLocalizedLang(item.text, lang, value))
                      }
                      onMarkSynced={() => setOptionSynced(item.id, item.text)}
                    />
                    {/* Phones: pushes image/delete to the row's right end. */}
                    <span aria-hidden className="flex-1 sm:hidden" />
                    {!isLikert && (
                      <label
                        title={item.image ? t("Replace image") : t("Add image")}
                        className="shrink-0 cursor-pointer rounded-lg px-1.5 py-1 hover:bg-slate-100 dark:hover:bg-slate-800"
                      >
                        {item.image ? (
                          <img
                            src={`${API_BASE_URL}${item.image}`}
                            alt={t("Answer image")}
                            className="h-9 w-9 rounded-lg border border-slate-200 object-cover dark:border-slate-700"
                          />
                        ) : (
                          <ImagePlus aria-hidden className="h-5 w-5 opacity-60" />
                        )}
                        <input
                          type="file"
                          accept="image/*"
                          className="sr-only"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) void uploadOptionImage(item.id, file);
                            event.target.value = "";
                          }}
                        />
                      </label>
                    )}
                    {!isLikert && item.image && (
                      <Button
                        variant="ghost"
                        aria-label={t("Remove image")}
                        title={t("Remove image")}
                        onClick={() => updateOption(item.id, { image: "" })}
                      >
                        <ImageOff aria-hidden className="h-4 w-4" />
                      </Button>
                    )}
                    {!binaryChoice && (
                      <Button
                        variant="ghost"
                        aria-label={t("Delete answer")}
                        onClick={() =>
                          setOptions((current) =>
                            current.filter((option) => option.clientId !== item.id),
                          )
                        }
                      >
                        <X aria-hidden className="h-4 w-4" />
                      </Button>
                    )}
                  </>
                )}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {!binaryChoice && (
                  <Button
                    onClick={() =>
                      setOptions((current) => [
                        ...current,
                        { clientId: nextClientId--, text: "", is_correct: false },
                      ])
                    }
                  >
                    + {t("Add answer")}
                  </Button>
                )}
              </div>
              {optionsMissing && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                  {t("Add at least two answer options, each with text.")}
                </p>
              )}

              {/* Settings every question kind shares: random order + when the
                  correct answer is revealed (#onboarding question.settings
                  anchor — kept as a plain block so the tour can spotlight it). */}
              <div data-tour="question.settings">
                {/* Offer random order for choice and priorities questions —
                    the listed order shouldn't nudge participants toward a
                    ranking (#96). Ordering is excluded: the server always
                    shuffles it (finding the right order is the task). */}
                {!isOrdering && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <ToggleSwitch
                      checked={shuffle}
                      onChange={setShuffle}
                      icon={Shuffle}
                      label={t("Show answer options to participants in random order")}
                    />
                  </div>
                )}

                {/* Per-question reveal of the correct answer (#28); only for
                    kinds that have a correct answer. */}
                {hasCorrect && (
                  <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                    {t("Reveal correct answer:")}
                    <select
                      value={reveal}
                      onChange={(event) =>
                        setReveal(event.target.value as "inherit" | RevealAnswers)
                      }
                      className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:outline-none"
                    >
                      <option value="inherit">
                        {t("As in the set")}
                        {set ? ` (${t(REVEAL_LABEL[set.reveal_answers])})` : ""}
                      </option>
                      <option value="immediately">{t(REVEAL_LABEL.immediately)}</option>
                      <option value="after_close">{t(REVEAL_LABEL.after_close)}</option>
                      <option value="never">{t(REVEAL_LABEL.never)}</option>
                    </select>
                    {/* #75: the per-question reveal only matters for live polls —
                        the self-paced and self-check flows use the set's own
                        rule. Keep the option (questions get copied between sets)
                        but say so. */}
                    {set?.type === "self_check" && (
                      <InfoHint
                        text={t(
                          "In a self-check this has no effect — the correct answer or model solution is always shown right away. The setting is kept in case the question is copied to another set.",
                        )}
                      />
                    )}
                    {set?.type === "self_paced" && (
                      <InfoHint
                        text={t(
                          "In a self-paced quiz the set's own setting (show correct answers right after answering) applies; this per-question option has no effect there. It is kept in case the question is copied to a live poll.",
                        )}
                      />
                    )}
                  </label>
                )}
              </div>

              {aiEnabled && hasCorrect && !binaryChoice && (
                <div className="mt-3">
                  <AiAssistPanel title={t("Suggest distractors")}>
                    <Button
                      onClick={() => void runDistractors()}
                      disabled={aiBusy === "distractors"}
                    >
                      {aiBusy === "distractors" ? t("Generating …") : t("Suggest wrong answers")}
                    </Button>
                    {aiDistractors.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {aiDistractors.map((distractor, index) => (
                          <li key={index} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-300">
                              {distractor}
                            </span>
                            <Button onClick={() => applyDistractor(distractor)}>
                              + {t("Use")}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {aiDistractorError && (
                      <p className="mt-1 text-sm text-red-600">{aiDistractorError}</p>
                    )}
                  </AiAssistPanel>
                </div>
              )}
            </div>

          </>
        )}

        {isLikert && (
          <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("Scale")}>
                <select
                  value={likertPreset}
                  onChange={(event) => {
                    const key = event.target.value;
                    const preset = LIKERT_PRESETS.find((p) => p.key === key);
                    setLikertPreset(key);
                    if (preset?.left) setLikertLeft(preset.left);
                    if (preset?.right) setLikertRight(preset.right);
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:outline-none"
                >
                  {LIKERT_PRESETS.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {t(preset.label)}
                    </option>
                  ))}
                  {/* A pencil makes the "define your own" entry stand out in
                      the native option list (an <option> can't hold an SVG). */}
                  <option value="custom">{`✏️ ${t("Define your own")}`}</option>
                </select>
              </Field>
              <Field label={t("Steps")}>
                <div className="flex flex-wrap items-center gap-1.5">
                  {[3, 4, 5, 6, 7].map((n) => {
                    const active = likertSteps === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setLikertSteps(n)}
                        className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                          active
                            ? "border-slate-400 bg-slate-200 font-semibold text-slate-900 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100"
                            : "border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900/60"
                        }`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
              </Field>
            </div>

            {!LIKERT_PRESETS.find((p) => p.key === likertPreset)?.emoji && (
              <div className="grid gap-3 sm:grid-cols-2">
                <TranslatableField
                  label={t("Left label (negative)")}
                  value={likertLeft}
                  onChange={(value) => {
                    setLikertLeft(value);
                    setLikertPreset(detectLikertPreset(value, likertRight));
                  }}
                />
                <TranslatableField
                  label={t("Right label (positive)")}
                  value={likertRight}
                  onChange={(value) => {
                    setLikertRight(value);
                    setLikertPreset(detectLikertPreset(likertLeft, value));
                  }}
                />
              </div>
            )}

            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={abstention}
                onChange={(event) => setAbstention(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
              />
              {t("Offer “{{abstention}}” as an additional option", {
                abstention: ABSTENTION,
              })}
            </label>

          </div>
        )}

        {isMindmap && (
          <div className="grid gap-4">
            <p className="rounded-xl bg-brand-50 dark:bg-brand-950 px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
              <strong>{t("Mind map:")}</strong>{" "}
              {t(
                "Participants build one shared mind map together: they add terms below any term (with “+”); identical terms at the same place are merged and counted. There are no answer options here.",
              )}
            </p>
            <TranslatableField
              label={t("Root term (optional)")}
              value={mindmapRoot}
              onChange={setMindmapRoot}
              placeholder={t("Empty = the question text is used")}
              inputClassName="max-w-md"
            />
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                {t("Depth")}
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={String(mindmapDepth)}
                  onChange={(event) =>
                    setMindmapDepth(Math.min(8, Math.max(1, Number(event.target.value) || 1)))
                  }
                  className="w-16 rounded-lg border border-slate-300 dark:border-slate-700 bg-white px-2 py-1 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:outline-none"
                />
                <InfoHint
                  text={t(
                    "How many levels below the root participants may add (1–8).",
                  )}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                {t("Terms per person")}
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={String(mindmapMaxPerPerson)}
                  onChange={(event) =>
                    setMindmapMaxPerPerson(
                      Math.min(300, Math.max(0, Number(event.target.value) || 0)),
                    )
                  }
                  className="w-20 rounded-lg border border-slate-300 dark:border-slate-700 bg-white px-2 py-1 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:outline-none"
                />
                <span className="text-slate-400">{t("(0 = no limit)")}</span>
              </label>
            </div>
            <div className="grid gap-2">
              <ToggleSwitch
                checked={mindmapDescriptions}
                onChange={setMindmapDescriptions}
                label={t("Title + description")}
              />
              <ToggleSwitch
                checked={mindmapHighlight}
                onChange={setMindmapHighlight}
                label={t("Highlight duplicate terms")}
              />
            </div>
            <div>
              <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
                {t("Predefined branches")}
              </span>
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                {t(
                  "Optional terms the mind map starts with. Participants can add to them but not delete them.",
                )}
              </p>
              <MindmapSeedEditor
                value={mindmapSeed}
                onChange={setMindmapSeed}
                depth={mindmapDepth}
                descriptions={mindmapDescriptions}
                rootLabel={localizedText(mindmapRoot) || stripHtml(localizedText(text)).slice(0, 60)}
              />
              {mindmapProblem && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                  {t(mindmapProblem.key, mindmapProblem.values)}
                </p>
              )}
            </div>
            <div className="grid gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
              <div>
                <span className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                  {t("Rating phase")}
                </span>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {t(
                    "Optional: after collecting, you start a rating on the beamer and participants rate the terms. The scores stay hidden until you show the results.",
                  )}
                </p>
              </div>
              <SegmentedControl
                className="max-w-md"
                ariaLabel={t("Rating phase")}
                value={mindmapRatingMode === "" ? "off" : mindmapRatingMode}
                onChange={(v) => {
                  setMindmapRatingMode(v === "off" ? "" : v);
                  setRatingModeError("");
                }}
                options={[
                  { value: "off", label: t("Off") },
                  { value: "points", label: t("Points") },
                  { value: "updown", label: t("Plus/minus") },
                ]}
              />
              {ratingModeError && (
                <p className="text-sm text-red-600 dark:text-red-400" data-testid="rating-mode-error">
                  {ratingModeError}
                </p>
              )}
              {mindmapRatingMode !== "" && (
                <>
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                    {mindmapRatingMode === "points" ? t("Points per person") : t("Ratings per person")}
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={String(mindmapRatingBudget)}
                      onChange={(event) =>
                        setMindmapRatingBudget(
                          Math.min(50, Math.max(1, Number(event.target.value) || 1)),
                        )
                      }
                      className="w-16 rounded-lg border border-slate-300 dark:border-slate-700 bg-white px-2 py-1 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:outline-none"
                    />
                    <InfoHint
                      text={
                        mindmapRatingMode === "points"
                          ? t("Each participant distributes this many points among the terms (1–50).")
                          : t("Each participant may rate this many terms with 👍 or 👎 (1–50).")
                      }
                    />
                  </label>
                  <div className="grid gap-2">
                    {mindmapRatingMode === "points" && (
                      <ToggleSwitch
                        checked={mindmapRatingMulti}
                        onChange={setMindmapRatingMulti}
                        label={t("Allow several points per term")}
                      />
                    )}
                    <ToggleSwitch
                      checked={mindmapRatingLive}
                      onChange={setMindmapRatingLive}
                      label={t("Show ratings during the rating")}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {question.kind === "word_cloud" && (
          <div className="grid gap-3">
            <p className="rounded-xl bg-brand-50 dark:bg-brand-950 px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
              <strong>{t("Word cloud:")}</strong>{" "}
              {t(
                "Participants enter free-form terms; spelling variants (upper/lower case) are merged. There are no answer options here.",
              )}
            </p>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              {t("Maximum contributions per person")}
              <input
                type="number"
                min={0}
                value={String(wordcloudMaxAnswers)}
                onChange={(event) =>
                  setWordcloudMaxAnswers(Math.max(0, Number(event.target.value) || 0))
                }
                className="w-20 rounded-lg border border-slate-300 dark:border-slate-700 bg-white px-2 py-1 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:outline-none"
              />
              <span className="text-slate-400">{t("(0 = no limit, 1 = a single answer)")}</span>
            </label>
            {!easyMode && wordcloudMaxAnswers !== 1 && (
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={wordcloudBatchSubmit}
                  onChange={(event) => setWordcloudBatchSubmit(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                />
                {t("Collect answers and submit them together")}
                <span className="text-slate-400">{t("(up to 5 fields at a time)")}</span>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={wordcloudLive}
                onChange={(event) => setWordcloudLive(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
              />
              {t("Show the word cloud on the projector while voting is still open")}
              <span className="text-slate-400">{t("(otherwise only after closing)")}</span>
            </label>
          </div>
        )}
        {question.kind === "word_cloud" && aiEnabled && (
          <AiAssistPanel title={t("Clean up word cloud with AI (presentation)")}>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={wordcloudAiEnabled}
                onChange={(event) => setWordcloudAiEnabled(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
              />
              {t("Merge similar terms, synonyms and typos")}
            </label>
            <p className="mt-1 text-xs text-slate-400">
              {t(
                "In addition to the automatic upper/lower case correction. In presentation mode, switch between Original, Cleaned up and Grouped with the “a” key / “View” button.",
              )}
            </p>
            {/* What "Cleaned up" merges (beyond case). All off = case only. */}
            <fieldset className="mt-3">
              <legend className="text-sm text-slate-700 dark:text-slate-300">
                {t("“Cleaned up” merges:")}
              </legend>
              <div className="mt-1 grid gap-1 pl-1">
                {(
                  [
                    [
                      wordcloudMergeVariants,
                      setWordcloudMergeVariants,
                      t("Spelling variants and typos (e.g. müde / muede / mühde)"),
                    ],
                    [
                      wordcloudMergeSynonyms,
                      setWordcloudMergeSynonyms,
                      t("Synonyms and word forms (e.g. einsam / Einsamkeit)"),
                    ],
                    [
                      wordcloudMergeConcepts,
                      setWordcloudMergeConcepts,
                      t("Similar concepts (e.g. Gebäude / Haus / Wohnung)"),
                    ],
                  ] as const
                ).map(([checked, setChecked, label]) => (
                  <label
                    key={label}
                    className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => setChecked(event.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            {/* Independent of the merge checkbox above — grouping can be
                enabled/edited on its own (#34). */}
            <label className="mt-3 grid gap-1 text-sm text-slate-700 dark:text-slate-300">
              {t("Group by … (optional)")}
              <input
                type="text"
                value={wordcloudGrouping}
                onChange={(event) => setWordcloudGrouping(event.target.value)}
                placeholder={t("e.g. “by topic area” — empty = automatic topics")}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <span className="text-xs text-slate-400">
                {t("Controls the “Grouped” AI view — works independently of merging above.")}
              </span>
            </label>
          </AiAssistPanel>
        )}
        {question.kind === "open_text" && (
          <p className="rounded-xl bg-brand-50 dark:bg-brand-950 px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
            <strong>{t("Free text:")}</strong>{" "}
            {t(
              "Participants write a free-form answer (max. 500 characters); the answers are shown as a list.",
            )}
          </p>
        )}
        {question.kind === "open_text" && aiEnabled && (
          <AiAssistPanel title={t("AI evaluation (live)")}>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={aiEvaluate}
                onChange={(event) => setAiEvaluate(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
              />
              {t("Have the AI evaluate answers")}
            </label>
            {aiEvaluate && (
              <div className="mt-2">
                <textarea
                  value={evaluationHint}
                  onChange={(event) => setEvaluationHint(event.target.value)}
                  rows={2}
                  placeholder={t(
                    "Hints for evaluation – e.g. the expected answer or a rating criterion (optional)",
                  )}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <p className="mt-1 text-xs text-slate-400">
                  {t("The AI assigns each answer to one category of the scale.")}
                </p>

                <div className="mt-2">
                  <textarea
                    value={modelSolution}
                    onChange={(event) => setModelSolution(event.target.value)}
                    rows={2}
                    placeholder={t("Model solution (optional)")}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <p className="mt-1 text-xs text-slate-400">
                    {t("The AI scores answers against this reference.")}
                  </p>
                </div>

                <label className="mt-3 grid gap-1 text-sm text-slate-700 dark:text-slate-300">
                  {t("Scale")}
                  <select
                    value={evalScale}
                    onChange={(event) => {
                      const value = event.target.value;
                      setEvalScale(value);
                      const preset = EVAL_PRESETS.find((p) => p.value === value);
                      if (preset && preset.categories.length) {
                        setEvalCategories(preset.categories);
                      } else if (evalCategories.length < 2) {
                        // Switching to custom: seed two blank category inputs.
                        setEvalCategories(["", ""]);
                      }
                    }}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:outline-none"
                  >
                    {EVAL_PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {t(p.label)}
                      </option>
                    ))}
                  </select>
                </label>

                {evalScale === "custom" && (
                  <div className="mt-2 grid gap-1.5">
                    {evalCategories.map((cat, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={cat}
                          onChange={(event) =>
                            setEvalCategories((cs) =>
                              cs.map((c, j) => (j === i ? event.target.value : c)),
                            )
                          }
                          placeholder={t("Category {{n}}", { n: i + 1 })}
                          className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                        />
                        {evalCategories.length > 2 && (
                          <button
                            type="button"
                            aria-label={t("Remove category {{n}}", { n: i + 1 })}
                            onClick={() =>
                              setEvalCategories((cs) => cs.filter((_, j) => j !== i))
                            }
                            className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                          >
                            <X aria-hidden className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))}
                    {evalCategories.length < 5 && (
                      <button
                        type="button"
                        onClick={() => setEvalCategories((cs) => [...cs, ""])}
                        className="justify-self-start rounded-lg border border-slate-300 px-3 py-1 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        + {t("Category")}
                      </button>
                    )}
                    <p className="text-xs text-slate-400">
                      {t("2–5 categories; the AI assigns each answer to one of them.")}
                    </p>
                  </div>
                )}

                <label className="mt-3 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={evalChart}
                    onChange={(event) => setEvalChart(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Show distribution as bar chart")}
                </label>

                {set?.type === "self_check" ? (
                  <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                    {t("In a self-check, learners always see the evaluation of their own answer.")}
                  </p>
                ) : (
                  <label className="mt-3 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={participantFeedback}
                      onChange={(event) => setParticipantFeedback(event.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                    />
                    {t("Show each participant the evaluation of their own answer")}
                  </label>
                )}
              </div>
            )}
          </AiAssistPanel>
        )}

        {/* Free-text AI summary (presentation): key statements + grouping in
            the beamer views and the Quiz-Block walkthrough. Self-checks have
            no beamer. Shares the word-cloud fields: merge_concepts = also
            merge similar statements, grouping = grouping instruction. */}
        {question.kind === "open_text" && aiEnabled && set?.type !== "self_check" && (
          <AiAssistPanel title={t("AI summary (presentation)")}>
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                role="switch"
                checked={wordcloudAiEnabled}
                onChange={(event) => setWordcloudAiEnabled(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
              />
              {t("AI summary (key statements, grouping)")}
            </label>
            <p className="mt-1 text-xs text-slate-400">
              {t(
                "In presentation mode, switch to Key statements or Grouped with the “a” key / “View” button. The beamer then shows AI statements with counts instead of the answers.",
              )}
            </p>
            {wordcloudAiEnabled && (
              <div className="mt-3 grid gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={wordcloudMergeConcepts}
                    onChange={(event) => setWordcloudMergeConcepts(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                  />
                  {t("Also merge similar statements")}
                </label>
                <label className="grid gap-1 text-sm text-slate-700 dark:text-slate-300">
                  {t("Grouping instruction")}
                  <textarea
                    value={wordcloudGrouping}
                    onChange={(event) => setWordcloudGrouping(event.target.value)}
                    rows={2}
                    maxLength={1000}
                    placeholder={t("e.g. “by advantage for students vs. teachers” — empty = automatic topics")}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  />
                  <span className="text-xs text-slate-400">
                    {t("Controls the “Grouped” view; the key statements stay the same.")}
                  </span>
                </label>
                {modelSolution.trim() && (
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={groupingUseSolution}
                      onChange={(event) => setGroupingUseSolution(event.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
                    />
                    {t("Consider the model solution when grouping")}
                  </label>
                )}
              </div>
            )}
          </AiAssistPanel>
        )}

        {/* #onboarding question.timer anchor; plain block, layout-neutral. */}
        <div data-tour="question.timer">
          <Field label={t("Time limit")}>
            <div className="flex flex-wrap items-center gap-1.5">
              {TIME_PRESETS.map((preset) => {
                const active = timeLimit === preset.value;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTimeLimit(preset.value)}
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
                max={3600}
                value={timeLimit}
                onChange={(event) => setTimeLimit(event.target.value)}
                placeholder={t("e.g. 90")}
                aria-label={t("Time limit in seconds")}
                className="!w-28"
              />
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {t("Seconds")}
              </span>
            </div>
          </Field>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {confirmNoCorrect && missingSolutionForSelfCheck && (
          <div
            role="alert"
            className="grid gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
          >
            <div className="flex items-start gap-3">
              <TriangleAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <p>{t(missingSolutionMessage)}</p>
            </div>
            <div className="flex flex-wrap gap-2 pl-8">
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmNoCorrect(false);
                  void save();
                }}
              >
                {t("Save anyway")}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmNoCorrect(false)}>
                {t("Cancel")}
              </Button>
            </div>
          </div>
        )}
        <div className="sticky bottom-0 z-20 mt-4 flex gap-2 bg-white/90 py-3 backdrop-blur shadow-[0_-6px_16px_-8px_rgba(15,23,42,0.18)] dark:bg-slate-950/90">
          <Button
            variant="primary"
            disabled={saving || invalid}
            onClick={() => {
              if (missingSolutionForSelfCheck && !confirmNoCorrect) setConfirmNoCorrect(true);
              else void save();
            }}
          >
            {saving ? t("Saving …") : t("Save")}
          </Button>
          <Button onClick={() => navigate(`/sets/${setId}`)}>{t("Cancel")}</Button>
        </div>
      </div>
      )}

      {pendingNav !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setPendingNav(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="mb-4 text-sm text-slate-700 dark:text-slate-200">
              {t("You have unsaved changes. Save before switching questions?")}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="primary" disabled={saving} onClick={() => void saveAndGo()}>
                {t("Save & continue")}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  const target = pendingNav;
                  setPendingNav(null);
                  navigate(`/sets/${setId}/questions/${target}`);
                }}
              >
                {t("Discard & continue")}
              </Button>
              <Button variant="ghost" onClick={() => setPendingNav(null)}>
                {t("Cancel")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {moveTargets !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setMoveTargets(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="mb-4 text-lg font-semibold text-slate-900 dark:text-slate-100">
              {t("Move to another question set …")}
            </h2>
            {moveTargets.length === 0 ? (
              <p className="text-sm text-slate-400">
                {t("There is no other question set to move this to.")}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <Field label={t("Room")}>
                  <select
                    value={moveRoom ?? undefined}
                    onChange={(event) => pickMoveRoom(Number(event.target.value))}
                    className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {moveRooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("Question set")}>
                  <select
                    value={moveTarget ?? undefined}
                    onChange={(event) => setMoveTarget(Number(event.target.value))}
                    className="w-72 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                  >
                    {moveTargets
                      .filter((entry) => entry.room === moveRoom)
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {localizedText(entry.title)}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
            )}
            {moveError && <p className="mt-3 text-sm text-red-600">{moveError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setMoveTargets(null)}>
                {t("Cancel")}
              </Button>
              {moveTargets.length > 0 && (
                <Button disabled={moveTarget === null} onClick={() => void handleMove()}>
                  {t("Move")}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
