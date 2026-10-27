// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Presentation mode (concept §6.1): a reduced fullscreen view for the
 * beamer. Keyboard-first — S start/stop, A cycles the footer's view
 * switcher, E/R first result view, L solution ("after_close" mode), Q QR,
 * ←/→ navigate, Esc ends. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { ChevronDown, ChevronLeft, ChevronRight, Info, Loader2, Pencil, Redo2, Sparkles, ThumbsUp, Timer, Undo2, Unlink, Users, X } from "lucide-react";
import {
  API_BASE_URL,
  aiErrorText,
  api,
  detailText,
  errorDetail,
  live,
  quizbar,
  results,
  type LiveCounter,
  type SetNextInfo,
  type LiveState,
  type Question,
  type RunResults,
  type WordCloudAI,
  type WordCloudAIWord as AiWord,
  type WordCloudModeration,
} from "../api";
import { localizedText, RichText, stripHtml } from "@basicbar/ui";
import { mathHtml, MathText } from "../math";
import i18n from "../i18n";
import LikertResult from "../components/LikertResult";
import { useTourSignal } from "../tour/signals";
import ResultBar, { type BarState } from "../results/ResultBar";
import ProgressPill from "../results/ProgressPill";
import PriorityBar from "../results/PriorityBar";
import OrderingResult from "../results/OrderingResult";
import { useReducedMotion } from "../results/motion";
import MindMap, { AI_MARK, hiddenMindmapNodes, mindmapBranchHues } from "../results/MindMap";
import MindmapRanking, { rankMindmap } from "../results/MindmapRanking";
import { useMindmapModeration } from "../results/mindmapModeration";
import { MindmapAiDrawer, useMindmapAi } from "../results/mindmapAi";
import MindmapModerationList from "../results/MindmapModerationList";
import { Footer, FooterIconButton, buildViewSegments, type ViewSegment } from "./presenter/footer";
import HelpOverlay from "./presenter/HelpOverlay";
import MatrixPanel from "./presenter/MatrixPanel";
import { GameLobby, LeaderboardOverlay, MuteBadge, Podium, useGameSounds } from "../quizbar/Game";
import { INK, evalColor, categoryColor, categoryDeep, categoryHue, termColor } from "../results/palette";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Beamer view of a word cloud / free-text question (#Wortwolke-KI). Free text
 *  reads "consolidated" as key statements; "results" = its AI verdict bars. */
/** Mindmaps reuse the view mechanism: "raw" = the map (compact/detailed is a
 *  display option in the zoom handle), "ranking" = the rated entries as bars
 *  (rating phase). */
type WcView = "raw" | "results" | "consolidated" | "grouped" | "ranking";

/** View options of a free-text question (live presenter and the Quiz-Block
 *  walkthrough share them): Original, Evaluation (AI verdict bars, only when
 *  evaluated), Key statements + Grouped (only with the AI summary on). */
function freeTextViewOptions(
  t: (key: string) => string,
  hasEval: boolean,
  ai: boolean,
): { value: WcView; label: string }[] {
  return [
    { value: "raw", label: t("Original") },
    ...(hasEval ? [{ value: "results" as const, label: t("Evaluation") }] : []),
    ...(ai
      ? [
          { value: "consolidated" as const, label: t("Key statements") },
          { value: "grouped" as const, label: t("Grouped") },
        ]
      : []),
  ];
}

function evalLabel(verdict: string) {
  return verdict ? verdict[0].toUpperCase() + verdict.slice(1) : verdict;
}

/** Seconds until `endsAt`, ticking every 250 ms; null without deadline. */
// Countdown display: colour warns in the final seconds; long timers show
// minutes so the number on the beamer changes slowly, not every second.
function countdownColor(remaining: number) {
  if (remaining <= 10) return "text-red-600";
  if (remaining <= 20) return "text-amber-500";
  return "text-slate-700";
}
function countdownLabel(remaining: number) {
  return remaining > 60 ? `${Math.ceil(remaining / 60)} min` : `${remaining} s`;
}

function useCountdown(endsAt: string | undefined) {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!endsAt) {
      setRemaining(null);
      return;
    }
    const compute = () =>
      setRemaining(Math.max(0, Math.ceil((Date.parse(endsAt) - Date.now()) / 1000)));
    compute();
    const timer = window.setInterval(compute, 250);
    return () => window.clearInterval(timer);
  }, [endsAt]);
  return remaining;
}

function useEventSource(code: string | null, onState: (s: LiveState) => void) {
  useEffect(() => {
    if (!code) return;
    const source = new EventSource(live.streamUrl(code), { withCredentials: true });
    source.onmessage = (event) => onState(JSON.parse(event.data));
    return () => source.close();
  }, [code, onState]);
}

/** True while the presenter types in a text field (drawer inputs, the AI
 *  grouping textarea, …): beamer shortcuts must not fire then. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "number", "password", "tel"]);
function isTextField(target: EventTarget | null): target is HTMLElement {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.tagName === "INPUT") {
    // `.type` reports "text" for a missing/unknown type attribute.
    return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  }
  return el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

/** Marks the word-cloud drawers and their edge handles (see `onKey`). */
const WC_DRAWER_ATTR = "data-wc-drawer";
function inWcDrawer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${WC_DRAWER_ATTR}]`) != null;
}
/** After a mouse click in a drawer, drop the button's focus so a clicker's
 *  Enter/Space advances the presentation instead of re-pressing it. */
function blurClickedButton(e: { target: EventTarget }) {
  if (e.target instanceof Element && e.target.closest("button")) {
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
}

export default function PresentPage({ mode = "live" }: { mode?: "live" | "self_paced" }) {
  const { t } = useTranslation();
  const { setId } = useParams();
  const id = Number(setId);
  const navigate = useNavigate();
  const selfPaced = mode === "self_paced";

  const [questions, setQuestions] = useState<Question[]>([]);
  const [openOnShow, setOpenOnShow] = useState(false);
  // Quiz-Block post-run walkthrough (#75): the set's opt-in for stepping
  // through per-question results on the beamer once the teacher ends a
  // self-paced run, and the walkthrough data/position while it is shown.
  const [presentResultsAfter, setPresentResultsAfter] = useState(true);
  const [walk, setWalk] = useState<RunResults["questions"] | null>(null);
  const [walkIndex, setWalkIndex] = useState(0);
  // Walkthrough view of a free-text slide (Original / Evaluation / Key
  // statements / Grouped) and the one-shot AI summaries, cached per
  // "run:question" ("error" = the last request failed; absent = not loaded).
  const [walkViewState, setWalkView] = useState<WcView>("raw");
  const [walkAi, setWalkAi] = useState<Record<string, WordCloudAI | "error">>({});
  const walkAiLoading = useRef<Set<string>>(new Set());
  const [runId, setRunId] = useState<number | null>(null);
  // Recording mode (#53): opted in on the set page (checkbox), carried here as
  // ?recording=1; live only (self-paced is already async).
  const [searchParams] = useSearchParams();
  const recording = searchParams.get("recording") === "1" && mode !== "self_paced";
  // Deep link (#7): jump straight to a specific question.
  const targetQuestionId = Number(searchParams.get("question")) || null;
  // ?resume=continue|archive|delete (guided tour): answer the "existing
  // results" dialog up front, as if that button had been clicked. Invalid or
  // absent values leave the dialog behaviour unchanged.
  const resumeParam = searchParams.get("resume");
  const resume =
    resumeParam === "continue" || resumeParam === "archive" || resumeParam === "delete"
      ? resumeParam
      : null;
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<LiveState | null>(null);
  const [dialog, setDialog] = useState(false);
  // Section interstitial (v2 "Zwischenfolie"): shown when advancing into a
  // section for the first time, before its first question is called up.
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  // Section id -> its interstitial content (title + optional rich description).
  const [sectionInfo, setSectionInfo] = useState<Map<number, SectionSlide>>(new Map());

  // Institution logo for the beamer (shown only if the room opts in).
  useEffect(() => {
    void api.getSite().then((s) => setLogoUrl(s.logo)).catch(() => setLogoUrl(null));
  }, []);
  const beamerLogo = state?.room.show_logo && logoUrl ? logoUrl : null;
  const [interstitial, setInterstitial] = useState<(SectionSlide & { index: number }) | null>(null);
  const announcedRef = useRef<Set<number>>(new Set());
  const indexRef = useRef(-1);
  // #7 deep link: index the lobby Start should open, and a one-shot guard.
  const pendingStartIndexRef = useRef<number | null>(null);
  const appliedTargetRef = useRef(false);
  // Keyed by the deadline (not the question): re-opening the same question
  // gets a fresh opened_at/ends_at and must auto-close again.
  const autoClosedRef = useRef<string | null>(null);
  // #10: in-page prompt when advancing away from a question that was dwelled
  // on. Two cases: it was never started ("not_started" — the main worry), or
  // it is still open and left too early. Quick paging stays silent. The
  // teacher can silence the prompt for the rest of this presentation.
  const shownSinceRef = useRef<number>(Date.now());
  const openSinceRef = useRef<number | null>(null);
  const [leaveWarn, setLeaveWarn] = useState<
    { mode: "not_started" | "still_open"; go: () => void } | null
  >(null);
  const [suppressLeaveWarn, setSuppressLeaveWarn] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  // After ending, dwell on a closing slide instead of jumping straight back
  // to the management screen (#32).
  const [ended, setEnded] = useState(false);
  // On-demand QR/join panel on the beamer (#): a scannable side panel the
  // presenter can flash without changing the vote phase. Toggled by the
  // footer icon or the "q" key; Esc closes it.
  const [showJoin, setShowJoin] = useState(false);
  // "?" help overlay: labels every visible control (HelpOverlay). While it is
  // open it swallows all keys itself, so `onKey` never sees them.
  const [showHelp, setShowHelp] = useState(false);
  // Word-cloud view cycle: raw → AI-consolidated → AI-grouped (#Wortwolke-KI).
  // Free text adds "results" (AI verdict bars) and reads "consolidated" as
  // key statements. The effective view (`wcView`) is derived below.
  const [wcViewState, setWcView] = useState<WcView>("raw");
  const [modHintSeen, setModHintSeen] = useState(() => {
    try {
      return localStorage.getItem("abstimmbar_wc_moderation_hint") === "1";
    } catch {
      return false;
    }
  });
  const dismissModHint = () => {
    setModHintSeen(true);
    try {
      localStorage.setItem("abstimmbar_wc_moderation_hint", "1");
    } catch {
      /* ignore */
    }
  };
  // Mindmap counterpart of the moderation hint (+, drag, double-click, ×,
  // undo). "_v3": shown again once so presenters learn the "Attach here"
  // tab (merge vs. attach was not discoverable; "_v2" was the stage-2 gestures).
  const [mmHintSeen, setMmHintSeen] = useState(() => {
    try {
      return localStorage.getItem("abstimmbar_mm_moderation_hint_v3") === "1";
    } catch {
      return false;
    }
  });
  const dismissMmHint = () => {
    setMmHintSeen(true);
    try {
      localStorage.setItem("abstimmbar_mm_moderation_hint_v3", "1");
    } catch {
      /* ignore */
    }
  };
  // Second one-time hint, for the AI panel button (shown after the
  // moderation hint has been dismissed — never both at once).
  const [aiHintSeen, setAiHintSeen] = useState(() => {
    try {
      return localStorage.getItem("abstimmbar_wc_ai_hint") === "1";
    } catch {
      return false;
    }
  });
  const dismissAiHint = () => {
    setAiHintSeen(true);
    try {
      localStorage.setItem("abstimmbar_wc_ai_hint", "1");
    } catch {
      /* ignore */
    }
  };
  // whoami bits the AI panel needs (easy mode, AI provider configured).
  // Until whoami answers, assume easy mode: no editing/AI handles flash up.
  const [whoAi, setWhoAi] = useState({ easy: true, ai: false });
  const activeAiRef = useRef<number | null>(null);

  // --- setup: load questions, ask about old results, start the run --------
  // Easy mode (#52) is fetched here rather than via `useEasyMode()`: this
  // page is a top-level route outside App's <Outlet> (fullscreen, no header
  // shell), so the outlet context useApp() relies on is unavailable.
  useEffect(() => {
    void (async () => {
      const [page, status, setData, sectionPage, who] = await Promise.all([
        api.listQuestions(id),
        live.status(id),
        api.getQuestionSet(id),
        api.listSections(id),
        api.whoami(),
      ]);
      const easyMode = !!who.easy_mode;
      setWhoAi({ easy: easyMode, ai: !!who.ai_enabled });
      setQuestions(page.results);
      setSectionInfo(
        new Map(
          sectionPage.results.map((s) => [
            s.id,
            {
              title: localizedText(s.title),
              description: localizedText(s.description ?? ""),
            },
          ]),
        ),
      );
      setOpenOnShow(setData.open_on_show);
      setPresentResultsAfter(setData.present_results_after);
      // quizbar (fork): the room's language, already for the start dialog.
      api.getRoom(setData.room).then((room) => setFetchedRoomLanguage(room.language), () => {});
      // quizbar (fork): the next quiz of an ordered folder ("Next quiz").
      quizbar.nextSet(id).then((info) => setNextQuiz(info.next), () => {});
      // Offer the start dialog whenever we'd otherwise touch stored answers:
      // either there are results and no run is active, OR the run we'd resume
      // already carries answers (presenter left it unfinished) — so archiving
      // is reliably offered instead of silently appending (#70).
      if (
        !easyMode &&
        !status.recently_started &&
        ((status.has_votes && !status.active_run) || status.active_run_has_votes)
      ) {
        if (resume) await startAfterDialog(resume); // pre-answered via ?resume=
        else setDialog(true); // ask before touching stored results
      } else {
        const started = await live.startRun(
          id, easyMode ? undefined : "continue", mode, recording,
        );
        setRunId(started.run);
        setCode(started.room_code);
      }
    })();
  }, [id, mode]);

  async function startAfterDialog(existing: "continue" | "delete" | "archive") {
    setDialog(false);
    const started = await live.startRun(id, existing, mode, recording);
    setRunId(started.run);
    setCode(started.room_code);
  }

  const handleState = useCallback((s: LiveState) => {
    setState(s);
  }, []);
  useEventSource(code, handleState);

  // Track which question is active (for ←/→ navigation).
  const activeId = state?.question?.id;
  indexRef.current = activeId
    ? questions.findIndex((q) => q.id === activeId)
    : indexRef.current;

  const activeKind = state?.question?.kind;

  // quizbar (fork): present in the room's language (phones use it too), and
  // give the presenter their own UI language back when leaving.
  const [fetchedRoomLanguage, setFetchedRoomLanguage] = useState<string>("");
  const [nextQuiz, setNextQuiz] = useState<SetNextInfo["next"]>(null);
  const roomLanguage = state?.room?.language ?? fetchedRoomLanguage;
  const ownLanguage = useRef(i18n.resolvedLanguage ?? i18n.language);
  useEffect(() => {
    if (!roomLanguage) return;
    void i18n.changeLanguage(roomLanguage);
    return () => {
      void i18n.changeLanguage(ownLanguage.current);
    };
  }, [roomLanguage]);

  // Word-cloud editing and the AI views are expert-mode tools; easy mode
  // shows the plain cloud only.
  const expert = !whoAi.easy;
  // AI cleanup/grouping views are opt-in per question (#Wortwolke-KI).
  // Free text shares the word-cloud machinery (moderation, AI summary views).
  const isTextKind = activeKind === "word_cloud" || activeKind === "open_text";
  const isOpenText = activeKind === "open_text";
  const aiCloud =
    expert && isTextKind && state?.question?.wordcloud_ai_enabled === true;
  // AI-evaluated free text: the verdict bars are the default beamer view —
  // verbatim answers appear only once the presenter picks "Original".
  const hasEval = isOpenText && !!state?.evaluation;
  const defaultView: WcView = hasEval ? "results" : "raw";
  // The result views of the question, in switcher order (the footer's view
  // switcher, `A`/`E` and the AI panel all use this one list). Free text puts
  // its default first (`E` = the evaluation when there is one).
  const wcViewOptions: { value: WcView }[] = isOpenText
    ? [...freeTextViewOptions(t, hasEval, aiCloud)].sort(
        (a, b) => Number(b.value === defaultView) - Number(a.value === defaultView),
      )
    : activeKind === "mindmap"
      ? [
          { value: "raw" },
          // Only once the scores are on screen (live rating or revealed).
          ...(Object.keys(state?.mindmap?.rating?.scores ?? {}).length > 0
            ? [{ value: "ranking" as const }]
            : []),
        ]
      : activeKind === "matrix"
        ? [
            { value: "raw" },
            // Matrix rating: likewise once the scores are on screen.
            ...(Object.keys(state?.matrix?.rating?.scores ?? {}).length > 0
              ? [{ value: "ranking" as const }]
              : []),
          ]
      : [
          { value: "raw" },
          ...(aiCloud ? [{ value: "consolidated" as const }, { value: "grouped" as const }] : []),
        ];
  // Mind map: compact / detailed (descriptions) — a display option in the
  // zoom handle, not a view of its own.
  const [mmDetailedState, setMmDetailed] = useState(false);
  const wcView: WcView = wcViewOptions.some((o) => o.value === wcViewState)
    ? wcViewState
    : defaultView;
  const isAiView = wcView === "consolidated" || wcView === "grouped";
  const mmDetailed = mmDetailedState && !!state?.mindmap?.descriptions;

  // Each new question starts on its default view (raw; "results" for
  // AI-evaluated free text); a question whose AI was just switched off falls
  // back to it as well (the AI views would otherwise linger).
  // Layout effect: corrected before paint, so an AI-evaluated question never
  // flashes the verbatim chips of a leftover "Original" view for a frame.
  useLayoutEffect(() => {
    setWcView(defaultView);
    setMmDetailed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  useEffect(() => {
    if (!aiCloud)
      setWcView((v) => (v === "consolidated" || v === "grouped" ? defaultView : v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiCloud]);

  // Tell the backend to keep the live AI views fresh only while one is shown
  // (capacity); deactivate the previous question when switching away.
  useEffect(() => {
    const wantAi = aiCloud && isAiView && activeId != null;
    const target = wantAi ? activeId! : null;
    if (activeAiRef.current === target) return;
    if (activeAiRef.current != null && runId) {
      void live.wordcloudAi(runId, activeAiRef.current, false);
    }
    if (target != null && runId) void live.wordcloudAi(runId, target, true);
    activeAiRef.current = target;
  }, [isAiView, activeId, aiCloud, runId]);

  // Stop the live AI computation when leaving the presentation.
  useEffect(
    () => () => {
      if (activeAiRef.current != null && runId) {
        void live.wordcloudAi(runId, activeAiRef.current, false);
      }
    },
    [runId],
  );

  // --- Word-cloud moderation (#Wortwolke): hide/merge with client undo/redo. ---
  type ModOp = {
    op: "hide" | "unhide" | "merge" | "unmerge" | "rename";
    keys: string[];
    label?: string;
  };
  const [showModPanel, setShowModPanel] = useState(false);
  const undoStack = useRef<{ done: ModOp[]; inverse: ModOp[] }[]>([]);
  const redoStack = useRef<{ done: ModOp[]; inverse: ModOp[] }[]>([]);
  const mod = state?.wordcloud_moderation;
  // Ops of one compound action are sent strictly in order.
  const sendMod = (ops: ModOp[]) => {
    if (runId == null || activeId == null) return;
    const rid = runId;
    const qid = activeId;
    void ops.reduce<Promise<unknown>>(
      (p, op) => p.then(() => live.wordcloudModeration(rid, qid, op)),
      Promise.resolve(),
    );
  };
  const moderate = (done: ModOp | ModOp[], inverse: ModOp | ModOp[]) => {
    const d = Array.isArray(done) ? done : [done];
    const inv = Array.isArray(inverse) ? inverse : [inverse];
    undoStack.current.push({ done: d, inverse: inv });
    redoStack.current = [];
    if (!modHintSeen) dismissModHint();
    sendMod(d);
  };
  const undoMod = () => {
    const last = undoStack.current.pop();
    if (!last) return;
    redoStack.current.push(last);
    sendMod(last.inverse);
  };
  const redoMod = () => {
    const item = redoStack.current.pop();
    if (!item) return;
    undoStack.current.push(item);
    sendMod(item.done);
  };
  // A merge group's current label (for the rename/split inverses).
  const mergeLabel = (keys: string[]) => {
    const norm = [...keys].sort().join("\u0000");
    return (mod?.merges ?? []).find((m) => [...m.keys].sort().join("\u0000") === norm)?.label;
  };
  // Shared by raw / consolidated / grouped clouds; AI words carry the raw keys
  // they stand for. Keyless words never moderate (no empty-key calls).
  const onModerateWord = (op: "hide" | "merge", keys: string[], label?: string) => {
    if (keys.length === 0) return;
    if (op === "hide") {
      const already = new Set((mod?.hidden ?? []).map((h) => h.key));
      const fresh = keys.filter((k) => !already.has(k));
      if (fresh.length === 0) return;
      moderate({ op: "hide", keys: fresh }, { op: "unhide", keys: fresh });
      return;
    }
    // Merging dissolves overlapping manual groups; undo must restore them.
    const ks = new Set(keys);
    const dissolved = (mod?.merges ?? []).filter((m) => m.keys.some((k) => ks.has(k)));
    moderate({ op: "merge", keys, label }, [
      { op: "unmerge", keys },
      ...dissolved.map((m) => ({ op: "merge" as const, keys: m.keys, label: m.label })),
    ]);
  };
  const wcHasWords =
    wcView === "raw"
      ? (state?.words ?? []).length > 0
      : wcView === "consolidated"
        ? (state?.wordcloud_ai?.merged.length ?? 0) > 0
        : wcView === "grouped"
          ? (state?.wordcloud_ai?.clusters ?? []).some((c) => c.words.length > 0)
          : false; // free-text verdict bars: nothing to moderate there
  const wcHasMod = (mod?.hidden.length ?? 0) > 0 || (mod?.merges.length ?? 0) > 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      if ((activeKind !== "word_cloud" && activeKind !== "open_text") || !expert) return;
      // Don't hijack native undo while the presenter types in a field.
      if (isTextField(e.target)) return;
      e.preventDefault();
      if (e.shiftKey) redoMod();
      else undoMod();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKind, runId, activeId, expert]);

  const phase = state?.phase ?? "lobby";
  // quizbar (fork): game mode — leaderboard (P), podium, the teacher's sounds.
  const game = state?.game;
  const [boardOpen, setBoardOpen] = useState(false);
  const gameRunRef = useRef<number | null>(null);
  if (game && runId) gameRunRef.current = runId;
  const sounds = useGameSounds(Boolean(game) || (ended && gameRunRef.current !== null));
  const soundPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (ended) return; // the podium runs its own sounds
    if (!game) {
      sounds.loop(null);
      return;
    }
    sounds.loop(phase === "lobby" ? "lobby" : phase === "open" ? "question" : null);
    if (phase === "results" && soundPhaseRef.current !== "results") sounds.play("reveal");
    if (phase === "open") setBoardOpen(false);
    soundPhaseRef.current = phase;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, Boolean(game), ended]);
  useEffect(() => {
    if (boardOpen) sounds.play("leaderboard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardOpen]);

  // Matrix / mind map on a closed vote (Stop, the timer, ✕ and re-entering
  // the presentation): the board / map stays on the beamer, like a closed
  // rating, WITHOUT changing the phase (the results phase would reveal hidden
  // rating scores). Only an explicit "Question" (footer segment, A, or E back
  // from the results) shows the bare question: `questionOnly` remembers that
  // choice for the active question until it is opened again, previewed or
  // left (it is set while still in "results", so that phase keeps it).
  const [questionOnly, setQuestionOnly] = useState<number | null>(null);
  useEffect(() => {
    if (
      questionOnly != null &&
      (questionOnly !== activeId || (phase !== "closed" && phase !== "results"))
    )
      setQuestionOnly(null);
  }, [questionOnly, activeId, phase]);
  const closedBoard =
    phase === "closed" &&
    (activeKind === "matrix" || activeKind === "mindmap") &&
    questionOnly !== activeId;

  // --- AI panel (#Wortwolke-KI): switch AI on (expert), pick view, regroup. ---
  // Settings are saved permanently on the question; the AI views themselves
  // are activated through `wcView` (same path as the footer / `A`).
  const [showAiPanel, setShowAiPanel] = useState(false);
  // "regroup" = a recompute (grouping or merge settings) waiting for its result.
  const [aiBusy, setAiBusy] = useState<"toggle" | "regroup" | "merge" | null>(null);
  const recomputeBusy = aiBusy === "regroup" || aiBusy === "merge";
  const [aiError, setAiError] = useState<string | null>(null);
  const serverGrouping = state?.question?.wordcloud_grouping ?? "";
  const [groupingDraft, setGroupingDraft] = useState("");
  useEffect(() => {
    setGroupingDraft(serverGrouping);
  }, [activeId, serverGrouping]);
  // Free text: "Consider the model solution when grouping" — a draft like
  // the instruction, applied with "Regroup". Only offered with a solution.
  const serverUseSolution = state?.question?.wordcloud_grouping_use_solution ?? true;
  const modelSolution = (state?.question?.model_solution ?? "").trim();
  const [useSolutionDraft, setUseSolutionDraft] = useState(true);
  useEffect(() => {
    setUseSolutionDraft(serverUseSolution);
  }, [activeId, serverUseSolution]);
  // "Show model solution" disclosure: collapsed every time the panel opens or
  // the question changes (the beamer may be mirrored); never persisted.
  const [solutionOpen, setSolutionOpen] = useState(false);
  useEffect(() => {
    setSolutionOpen(false);
  }, [activeId, showAiPanel]);
  // "Cleaned up" merge switches: a local draft (no model call per click),
  // applied with "Merge again".
  const serverMergeVariants = state?.question?.wordcloud_merge_variants ?? true;
  const serverMergeSynonyms = state?.question?.wordcloud_merge_synonyms ?? true;
  const serverMergeConcepts = state?.question?.wordcloud_merge_concepts ?? false;
  const [mergeDraft, setMergeDraft] = useState({
    variants: serverMergeVariants,
    synonyms: serverMergeSynonyms,
    concepts: serverMergeConcepts,
  });
  useEffect(() => {
    setMergeDraft({
      variants: serverMergeVariants,
      synonyms: serverMergeSynonyms,
      concepts: serverMergeConcepts,
    });
  }, [activeId, serverMergeVariants, serverMergeSynonyms, serverMergeConcepts]);
  useEffect(() => {
    setShowAiPanel(false);
    setShowModPanel(false);
    setAiBusy(null);
    setAiError(null);
  }, [activeId]);
  // The cloud is on screen (same rule as its rendering below); the pencil
  // shows once there is something to moderate. The sparkles share that rule,
  // except that the expert switch may be offered on a visible empty cloud.
  // Free text shows its answers/views on "Ergebnis" only (as before).
  const wcCloudShown =
    (activeKind === "word_cloud" &&
      (phase === "results" ||
        (phase === "open" && state?.question?.wordcloud_live !== false))) ||
    (isOpenText && phase === "results");
  // No pencil over the free-text verdict bars (nothing to moderate there).
  // Free text: the drawer lists raw keys (verbatim answers), so it is only
  // offered in "Original" (restoring stays possible there).
  const showModHandle =
    expert &&
    wcCloudShown &&
    wcView !== "results" &&
    !(isOpenText && isAiView) &&
    (wcHasWords || wcHasMod);
  const showAiButton = expert && wcCloudShown && whoAi.ai;
  // Mindmap: the map grows live while open and stays after Stop and on
  // "Ergebnis"; only an explicit "Frage" (and the preview) shows the question
  // text alone.
  const mindmap = activeKind === "mindmap" ? state?.mindmap : undefined;
  // Rating phase (optional, per question): while rating only hiding is
  // possible on the beamer — add/merge/move/rename would change what people
  // are rating under their hands. Back in "collect" everything returns.
  const mmRating = mindmap?.rating;
  const mmRate = mmRating?.stage === "rate";
  // Stopping a rating with hidden scores only closes the vote (the map stays,
  // without scores); "Ergebnis" / E reveals. That holds while rating and
  // also back in collecting as long as hidden ratings exist (someone rated,
  // live display off, scores not on screen — the presenter payload carries
  // `raters` but no `scores`): Stop / the timer only close, A never reaches
  // the scores, E is the deliberate reveal. Otherwise collecting (and a
  // live-shown rating) still goes straight to the results.
  const mmScoresHidden =
    !!mmRating && !mmRating.live && (mmRate || (mmRating.raters > 0 && !mmRating.scores));
  const mmStopCloses = activeKind === "mindmap" && mmScoresHidden;
  const mmShown =
    !!mindmap &&
    (phase === "open" || phase === "results" || (phase === "closed" && (mmScoresHidden || closedBoard)));
  // Matrix: the board is live while open and stays after Stop and on
  // "Matrix" (results); only an explicit "Frage" shows the question alone.
  // Arranging and moderating are for every presenter (not expert-only).
  const matrixBoard = activeKind === "matrix" ? state?.matrix : undefined;
  const matrixSettings = activeKind === "matrix" ? state?.matrix_settings : undefined;
  // Matrix rating: mirrors the mind map's (Stop with hidden scores only
  // closes; the board stays on a closed rating until E reveals).
  const mxRating = matrixBoard?.rating;
  const mxRate = mxRating?.stage === "rate";
  const mxScoresHidden =
    !!mxRating && !mxRating.live && (mxRate || (mxRating.raters > 0 && !mxRating.scores));
  const mxShown =
    !!matrixBoard &&
    !!matrixSettings &&
    (phase === "open" || phase === "results" || (phase === "closed" && (mxScoresHidden || closedBoard)));
  // Matrix AI grouping (✦ handle): expert mode, AI configured, the
  // question's AI switch on (like the mind map's).
  const showMxAi = expert && mxShown && whoAi.ai && state?.question?.wordcloud_ai_enabled === true;
  const stopCloses = mmStopCloses || (activeKind === "matrix" && mxScoresHidden);
  // The rating whose raters the counter shows.
  const rateStats = mmRate ? mmRating : mxRate ? mxRating : undefined;
  // Full-width layouts (compact title, content fills the height).
  const wideShown = mmShown || mxShown;
  const mmRateRef = useRef(mmRate);
  mmRateRef.current = mmRate;
  const mmRanking = useMemo(
    () => (mindmap && mmRating?.scores ? rankMindmap(mindmap.nodes, mmRating.scores) : []),
    [mindmap, mmRating?.scores],
  );
  // Ranking bars take their term's main-branch colour from the map.
  const mmHues = useMemo(
    () => (mindmap ? mindmapBranchHues(mindmap.nodes, `${runId}:${activeId}`) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mindmap, runId, activeId, wcViewState, mmDetailed],
  );
  // Expert mode: × hides a term with its subtree; the pencil drawer lists the
  // hidden ones to restore.
  const mmHidden = mindmap ? hiddenMindmapNodes(mindmap.nodes) : [];
  const showMmHandle = expert && mmShown && (mindmap?.total ?? 0) > 0;
  // The hint also goes away by itself once it has been readable for ~20 s.
  // ("+" works on an empty map too, so it doesn't wait for terms.)
  const mmHintVisible = expert && mmShown && !mmHintSeen && !mmRate;
  useEffect(() => {
    if (!mmHintVisible) return;
    const id = window.setTimeout(dismissMmHint, 20_000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mmHintVisible]);
  // Moderation (add / merge / move / rename / hide) with undo/redo; server
  // refusals (409 details) show up as a small toast.
  const [mmToast, setMmToast] = useState<{
    text: string;
    n: number;
    action?: { label: string; run: () => void };
  } | null>(null);
  useEffect(() => {
    if (!mmToast) return;
    const id = window.setTimeout(() => setMmToast(null), 6000);
    return () => window.clearTimeout(id);
  }, [mmToast]);
  const mmMod = useMindmapModeration(runId, activeKind === "mindmap" ? activeId : null, {
    onError: (detail) => setMmToast((p) => ({ text: detailText(detail, t), n: (p?.n ?? 0) + 1 })),
    onInfo: (msg) => setMmToast((p) => ({ text: t(msg), n: (p?.n ?? 0) + 1 })),
    onAction: () => {
      if (!mmHintSeen) dismissMmHint();
    },
    onHiddenConflict: (node) =>
      setMmToast((p) => ({
        text: t("This term already exists there, but it is hidden."),
        n: (p?.n ?? 0) + 1,
        action: { label: t("Show again"), run: () => mmModRef.current.hide(node, false) },
      })),
  });
  const hideMindmapNode = (node: number, hidden: boolean) => mmMod.hide(node, hidden);
  // "Start rating" / "Keep collecting": switch the stage and (re)open the
  // vote in one request (no intermediate state on the beamer).
  const [mmStageBusy, setMmStageBusy] = useState(false);
  const setMindmapStage = async (stage: "collect" | "rate") => {
    if (runId == null || activeId == null || mmStageBusy) return;
    setMmStageBusy(true);
    try {
      await live.mindmapStage(runId, activeId, stage, true);
    } catch (err) {
      setMmToast((p) => ({ text: detailText(errorDetail(err), t), n: (p?.n ?? 0) + 1 }));
    } finally {
      setMmStageBusy(false);
    }
  };
  const [mxStageBusy, setMxStageBusy] = useState(false);
  const setMatrixStage = async (stage: "collect" | "rate") => {
    if (runId == null || activeId == null || mxStageBusy) return;
    setMxStageBusy(true);
    try {
      await live.matrixStage(runId, activeId, stage, true);
    } catch (err) {
      setMmToast((p) => ({ text: detailText(errorDetail(err), t), n: (p?.n ?? 0) + 1 }));
    } finally {
      setMxStageBusy(false);
    }
  };
  const mmModRef = useRef(mmMod);
  mmModRef.current = mmMod;
  // AI optimisation (expert mode, AI configured, the question's AI switch
  // on): star below the pencil → drawer with settings, proposal checklist
  // and a preview of the optimised map; applying is one undo entry.
  const showMmAi =
    expert && mmShown && whoAi.ai && state?.question?.wordcloud_ai_enabled === true;
  const mmAi = useMindmapAi({
    runId,
    questionId: activeKind === "mindmap" ? activeId : null,
    mindmap,
    settings: state?.question?.mindmap_ai,
    rating: !!mmRate,
    applyBatch: mmMod.applyAi,
    onApplied: ({ applied, skipped }) =>
      setMmToast((p) => ({
        text: [
          t("{{count}} changes applied — Ctrl/Cmd+Z undoes them.", { count: applied }),
          skipped > 0
            ? t("{{count}} no longer fitted the map and were skipped.", { count: skipped })
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        n: (p?.n ?? 0) + 1,
      })),
  });
  // The star going away (switch off, question change) closes the drawer.
  useEffect(() => {
    if (!showMmAi && mmAi.open) mmAi.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMmAi]);
  const mmAiRef = useRef(mmAi);
  mmAiRef.current = mmAi;
  // With the AI drawer (w-96) open the map fits beside it, so every
  // (marked) term stays visible next to the checklist.
  const mmPreview = mmAi.proposal?.preview;
  const mmPreviewRef = useRef(false);
  mmPreviewRef.current = !!mmPreview;
  useEffect(() => {
    if (!(expert && mmShown)) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      // Don't hijack native undo while the presenter types in a field.
      if (isTextField(e.target)) return;
      e.preventDefault();
      // While a preview is shown, the map isn't the live one: no undo.
      if (mmPreviewRef.current) return;
      if (e.shiftKey) mmModRef.current.redo(mmRateRef.current);
      else mmModRef.current.undo(mmRateRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expert, mmShown]);
  // Below the pencil when it is shown, otherwise in its place.
  // Right-edge handle column: pencil, then sparkles (word clouds) or the
  // zoom handle (mind map), placed clear of the logo / right QR corner.
  const handleColumnTop = useHandleColumn(
    (showModHandle || showMmHandle ? 1 : 0) +
      (showAiButton || mmShown ? 1 : 0) +
      (showMmAi ? 1 : 0) +
      // Matrix: pencil, AI star, display.
      (mxShown ? 2 : 0) +
      (showMxAi ? 1 : 0),
  );
  const aiHandleTop = handleColumnTop + (showModHandle ? HANDLE_STEP : 0);
  // Mind map: pencil, AI star, zoom.
  const mmAiTop = handleColumnTop + (showMmHandle ? HANDLE_STEP : 0);
  const mmZoomTop = mmAiTop + (showMmAi ? HANDLE_STEP : 0);
  // Full-width mind map: its title and hint stay centred but clear of the
  // QR boxes top-left (same margin on both sides). `rem` = the usual cap.
  const topLeftRight = useTopLeftExtent(mmShown);
  const mmClear = (rem: number): CSSProperties => {
    const side = Math.max(0, topLeftRight + 16 - 32); // 32 = main's px-8
    return { maxWidth: side ? `min(${rem}rem, calc(100% - ${2 * side}px))` : `${rem}rem` };
  };
  // Regroup / merge again stay busy until a finished AI result computed
  // *after* the save arrives: every compute gets a new, increasing `seq` (also
  // when its content is identical, also on error), and the save response
  // returns the mark (`ai_seq`) it has to exceed. 15 s fallback in case no
  // recompute happens at all.
  const aiSeq = state?.wordcloud_ai?.seq ?? 0;
  const aiPending = state?.wordcloud_ai?.pending ?? false;
  const regroupMark = useRef<number | null>(null);
  // The result may already be here when the save response arrives.
  const latestAi = useRef({ seq: aiSeq, pending: aiPending });
  latestAi.current = { seq: aiSeq, pending: aiPending };
  const markRecompute = (mark: number) => {
    if (!latestAi.current.pending && latestAi.current.seq > mark) {
      regroupMark.current = null;
      setAiBusy(null);
    } else {
      regroupMark.current = mark;
    }
  };
  useEffect(() => {
    if (!recomputeBusy || regroupMark.current == null) return;
    if (!aiPending && aiSeq > regroupMark.current) {
      regroupMark.current = null;
      setAiBusy(null);
    }
  }, [aiSeq, aiPending, recomputeBusy]);
  useEffect(() => {
    if (!recomputeBusy) return;
    const timer = window.setTimeout(() => setAiBusy(null), 15000);
    return () => window.clearTimeout(timer);
  }, [recomputeBusy]);
  const aiPanelTitle = isOpenText ? t("AI summary") : t("AI word cloud");
  const toggleAiPanel = () => {
    setShowModPanel(false);
    setShowAiPanel((s) => !s);
    if (!aiHintSeen) dismissAiHint();
  };
  const setQuestionAi = async (on: boolean) => {
    if (runId == null || activeId == null) return;
    setAiBusy("toggle");
    setAiError(null);
    try {
      await live.wordcloudAiSettings(runId, activeId, { ai_enabled: on });
    } catch (e) {
      setAiError(aiErrorText(e, t));
    } finally {
      setAiBusy(null);
    }
  };
  const regroup = async () => {
    if (runId == null || activeId == null) return;
    // At most one AI pass: with the AI view already active, `regroup`
    // forces the recompute; from the raw view the activation below computes
    // (after the save, so it uses the new instruction).
    const viewActive = isAiView;
    setAiBusy("regroup");
    setAiError(null);
    regroupMark.current = null;
    try {
      const res = await live.wordcloudAiSettings(runId, activeId, {
        grouping: groupingDraft,
        ...(isOpenText && modelSolution ? { grouping_use_solution: useSolutionDraft } : {}),
        regroup: viewActive,
      });
      setGroupingDraft(res.grouping);
      setUseSolutionDraft(res.grouping_use_solution);
      markRecompute(res.ai_seq);
      // Ensure the grouped view is shown and active (same path as footer / `A`).
      setWcView("grouped");
    } catch (e) {
      regroupMark.current = null;
      setAiBusy(null);
      setAiError(aiErrorText(e, t));
    }
  };
  // "Merge again": save the merge switches and recompute once — forced when
  // an AI view is already active, otherwise by activating "Cleaned up" (as
  // in Regroup, at most one AI pass). Same busy logic as Regroup.
  const mergeAgain = async () => {
    if (runId == null || activeId == null) return;
    setAiBusy("merge");
    setAiError(null);
    regroupMark.current = null;
    try {
      const res = await live.wordcloudAiSettings(runId, activeId, {
        merge_variants: mergeDraft.variants,
        merge_synonyms: mergeDraft.synonyms,
        merge_concepts: mergeDraft.concepts,
        regroup: isAiView,
      });
      setMergeDraft({
        variants: res.merge_variants,
        synonyms: res.merge_synonyms,
        concepts: res.merge_concepts,
      });
      markRecompute(res.ai_seq);
      setWcView("consolidated");
    } catch (e) {
      regroupMark.current = null;
      setAiBusy(null);
      setAiError(aiErrorText(e, t));
    }
  };

  const reveal = state?.reveal_answers ?? "after_close";
  const revealed = state?.revealed ?? false;
  // Only single/multiple choice have a correct answer to reveal (#82/#83).
  const hasCorrect = activeKind === "single_choice" || activeKind === "multiple_choice";
  const canReveal = hasCorrect && reveal === "after_close";
  const showCorrect =
    phase === "results" && (reveal === "immediately" || (reveal === "after_close" && revealed));

  // Countdown (v2): tick locally, auto-close once per question when time is up.
  // Live only — self-paced runs are also `phase === "open"` but use a
  // separate overall-quiz countdown below (that one must never auto-close
  // a question or fire this per-question effect).
  const remaining = useCountdown(!selfPaced && phase === "open" ? state?.ends_at : undefined);
  useEffect(() => {
    const deadline = state?.ends_at ?? null;
    if (
      !selfPaced &&
      runId &&
      phase === "open" &&
      remaining === 0 &&
      deadline !== null &&
      autoClosedRef.current !== deadline
    ) {
      autoClosedRef.current = deadline;
      // A rating with hidden scores (matrix / mind map) only closes, like
      // S/Stop (`stopCloses`) — the timer must not reveal the scores.
      if (!stopCloses && (activeKind === "word_cloud" || activeKind === "matrix")) {
        // Keep the cloud / matrix board on the beamer after the timer expires (and surface
        // #30's deferred cloud) — the same "results" landing as the Stop
        // button, instead of a bare closed slide that would hide it.
        // One transition (no transient "closed" that would hide the cloud).
        void live.control(runId, { phase: "results" });
      } else {
        void live.control(runId, { phase: "closed" });
      }
    }
  }, [selfPaced, remaining, phase, runId, activeKind, stopCloses, state?.ends_at]);

  // Self-paced overall countdown (#75, Quiz-Block): the deadline for the
  // whole quiz lives in the same `state.ends_at` field the live per-question
  // timer uses above, but here it drives a separate best-effort auto-finish
  // instead of closing/advancing a question. Keyed by the deadline (like
  // autoClosedRef) so a fresh run/deadline can finish again.
  const quizRemaining = useCountdown(selfPaced ? state?.ends_at : undefined);
  const autoFinishedRef = useRef<string | null>(null);
  useEffect(() => {
    const deadline = state?.ends_at ?? null;
    if (
      selfPaced &&
      runId &&
      quizRemaining === 0 &&
      deadline !== null &&
      autoFinishedRef.current !== deadline
    ) {
      autoFinishedRef.current = deadline;
      void finish();
    }
  }, [selfPaced, quizRemaining, runId, state?.ends_at]);

  // Track dwell time: when a new question slide appears, and when its vote
  // opens (both feed the leave prompt).
  useEffect(() => {
    shownSinceRef.current = Date.now();
  }, [activeId]);
  useEffect(() => {
    if (phase === "open") {
      if (openSinceRef.current === null) openSinceRef.current = Date.now();
    } else {
      openSinceRef.current = null;
    }
  }, [phase, activeId]);

  // --- presenter actions ----------------------------------------------------
  const goto = useCallback(
    async (index: number) => {
      if (!runId || questions.length === 0) return;
      const clamped = Math.max(0, Math.min(questions.length - 1, index));
      await live.control(runId, {
        // Set option: calling up a question can open it right away.
        phase: openOnShow ? "open" : "preview",
        question: questions[clamped].id,
      });
    },
    [runId, questions, openOnShow],
  );

  // Navigate, but first show the section interstitial when entering a
  // section for the first time this run (v2 "Zwischenfolie").
  // Plain-text question titles for the footer's jump menu ("3/12").
  const jumpTitles = useMemo(
    () => questions.map((q) => stripHtml(localizedText(q.text)).replace(/\s+/g, " ").trim()),
    [questions],
  );
  const requestGoto = useCallback(
    (index: number) => {
      if (!runId || questions.length === 0) return;
      const clamped = Math.max(0, Math.min(questions.length - 1, index));
      const section = questions[clamped].section;
      if (section !== null && !announcedRef.current.has(section)) {
        setInterstitial({ ...sectionSlide(sectionInfo, section), index: clamped });
        return;
      }
      void goto(clamped);
    },
    [runId, questions, sectionInfo, goto],
  );

  // Start from the lobby into the armed deep-link question (#7), or the first
  // question when there is no target.
  const startFromLobby = useCallback(() => {
    const index = pendingStartIndexRef.current ?? 0;
    pendingStartIndexRef.current = null;
    requestGoto(index);
  }, [requestGoto]);

  // Once the run is ready, apply the ?question=<id> target exactly once:
  // arm the lobby Start (fresh run) or jump straight (a question already live).
  useEffect(() => {
    if (appliedTargetRef.current) return;
    if (!runId || questions.length === 0 || !state) return;
    appliedTargetRef.current = true;
    if (targetQuestionId == null) return;
    const targetIndex = questions.findIndex((q) => q.id === targetQuestionId);
    if (targetIndex < 0) return; // unknown/deleted id → normal presenter start
    if (state.question?.id != null) {
      void goto(targetIndex); // run already showing a question → jump straight
    } else {
      pendingStartIndexRef.current = targetIndex; // fresh lobby → arm Start
    }
  }, [runId, questions, state, targetQuestionId, goto]);

  const confirmInterstitial = useCallback(() => {
    if (!interstitial) return;
    const section = questions[interstitial.index]?.section;
    if (section !== null && section !== undefined) announcedRef.current.add(section);
    const target = interstitial.index;
    setInterstitial(null);
    void goto(target);
  }, [interstitial, questions, goto]);

  // Going back from a section's first question lands on the section header
  // again (#7), rather than skipping straight to the previous question.
  const goPrev = useCallback(() => {
    const idx = indexRef.current;
    const current = questions[idx];
    if (
      current &&
      current.section != null &&
      (idx === 0 || questions[idx - 1].section !== current.section)
    ) {
      setInterstitial({ ...sectionSlide(sectionInfo, current.section), index: idx });
    } else {
      requestGoto(idx - 1);
    }
  }, [questions, sectionInfo, requestGoto]);

  // Guarded "advance" (#10). Quick paging stays silent; only when a slide was
  // dwelled on do we prompt — either "you didn't start this vote" (preview,
  // > 5 s) or "the vote is still running" (open, timed with the countdown not
  // yet up, or untimed under 30 s). Silenced for the presentation on request.
  const PREVIEW_DWELL_MS = 5000;
  const OPEN_MIN_MS = 30000;
  const advanceNext = useCallback(() => {
    if (phase === "lobby") return startFromLobby();
    // Past the last question there is nothing to page to — end the run so it
    // reaches the finished state (#29), instead of clamping onto the last
    // slide and appearing to do nothing.
    const go = () =>
      indexRef.current + 1 >= questions.length
        ? void finish()
        : requestGoto(indexRef.current + 1);
    if (suppressLeaveWarn) return go();
    const now = Date.now();
    if (phase === "preview" && now - shownSinceRef.current > PREVIEW_DWELL_MS) {
      setLeaveWarn({ mode: "not_started", go });
    } else if (
      phase === "open" &&
      (state?.ends_at != null ||
        (openSinceRef.current !== null && now - openSinceRef.current < OPEN_MIN_MS))
    ) {
      setLeaveWarn({ mode: "still_open", go });
    } else {
      go();
    }
  }, [suppressLeaveWarn, phase, state?.ends_at, requestGoto, questions.length, startFromLobby]);

  // Guided tour: show the first question (so the voting/reveal controls are
  // visible), and return to the lobby before the tour leaves the page, so a
  // later real presentation starts on the start screen. Always as a PREVIEW
  // (not startFromLobby, which honours "open on show"): the tour explains
  // Start and must not open voting itself.
  useTourSignal("present-first", () => {
    if (runId && phase === "lobby" && questions.length > 0) {
      void live.control(runId, { phase: "preview", question: questions[0].id });
    }
  });
  useTourSignal("present-lobby", () => {
    if (runId && phase !== "lobby" && phase !== "finished") {
      void live.control(runId, { phase: "lobby", question: null });
    }
  });

  // Prompt actions.
  function dismissWarn() {
    setLeaveWarn(null);
    setDontAskAgain(false);
  }
  function proceedLeave() {
    if (dontAskAgain) setSuppressLeaveWarn(true);
    const go = leaveWarn?.go;
    dismissWarn();
    go?.();
  }
  function startCurrentVote() {
    if (dontAskAgain) setSuppressLeaveWarn(true);
    dismissWarn();
    if (runId) void live.control(runId, { phase: "open" });
  }

  // Reveal-level controls for the footer pill (Frage · Ergebnisse · Lösung).
  // No-ops in lobby/finished so we never request results without a question.
  const showQuestion = useCallback(() => {
    if (runId && phase === "results") void live.control(runId, { phase: "closed" });
  }, [runId, phase]);

  const showResults = useCallback(async () => {
    if (!runId) return;
    if (phase === "results") {
      if (revealed) await live.control(runId, { reveal: false });
      return;
    }
    if (phase === "open" || phase === "closed" || phase === "preview") {
      // An open vote goes straight to "results" (one transition, which also
      // closes it): a detour via "closed" put a transient state on the beamer
      // (the live cloud / map vanished, "Question" active, Start shown) and a
      // key pressed in that window (e.g. A right after S) acted on it.
      // "Results" means without the solution, also when it was revealed
      // before the presenter went back to the question (un-reveal first: no
      // flash of the solution).
      if (revealed) await live.control(runId, { reveal: false });
      await live.control(runId, { phase: "results" });
    }
  }, [runId, phase, revealed]);

  const showSolution = useCallback(async () => {
    if (!runId) return;
    if (phase === "lobby" || phase === "finished") return; // no active question
    // Straight to "results" (also from an open vote — no transient "closed").
    if (phase !== "results") await live.control(runId, { phase: "results" });
    await live.control(runId, { reveal: true });
  }, [runId, phase]);

  // Walkthrough navigation (#75): advancing past the last question hands off
  // to the existing closing slide instead of a dedicated "done" state.
  const walkAdvance = useCallback(() => {
    if (!walk) return;
    // Functional updater (not a captured walkIndex) so rapid clicks/keypresses
    // can't under-advance or overshoot; the index never exceeds the last slide,
    // so the render's walk[walkIndex] is always defined. Past the last slide we
    // hand off to the closing slide (#75).
    setWalkIndex((i) => {
      if (i >= walk.length - 1) {
        setWalk(null);
        setEnded(true);
        return i;
      }
      return i + 1;
    });
  }, [walk]);
  const walkBack = useCallback(() => {
    setWalkIndex((i) => Math.max(0, i - 1));
  }, []);

  // Free-text slides get the live view picker (expert-gated AI views, fed by
  // an on-demand one-shot summary of the stored votes instead of the live
  // loop). Other kinds have a single view.
  const walkItem = walk ? walk[walkIndex] : undefined;
  const walkIsOpenText = walkItem?.kind === "open_text";
  const walkHasEval = walkIsOpenText && !!walkItem?.evaluation;
  const walkAiOn =
    walkIsOpenText &&
    expert &&
    whoAi.ai &&
    questions.find((q) => q.id === walkItem?.id)?.wordcloud_ai_enabled === true;
  const walkDefaultView: WcView = walkHasEval ? "results" : "raw";
  const walkViewOptions = walkIsOpenText ? freeTextViewOptions(t, walkHasEval, walkAiOn) : [];
  const walkView: WcView = walkViewOptions.some((o) => o.value === walkViewState)
    ? walkViewState
    : walkDefaultView;
  const walkAiKey = runId != null && walkItem ? `${runId}:${walkItem.id}` : "";
  const walkWantsAi = walkView === "consolidated" || walkView === "grouped";
  // Before paint (no one-frame flash of verbatim chips on an evaluated slide).
  useLayoutEffect(() => {
    setWalkView(walkDefaultView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walk, walkIndex]);
  useEffect(() => {
    if (!walkWantsAi || !walkAiKey || !walkItem || runId == null) return;
    if (walkAi[walkAiKey] !== undefined || walkAiLoading.current.has(walkAiKey)) return;
    const key = walkAiKey;
    walkAiLoading.current.add(key);
    void results
      .freeTextSummary(runId, walkItem.id)
      .then((res) => setWalkAi((m) => ({ ...m, [key]: { ...res, pending: false } })))
      .catch(() => setWalkAi((m) => ({ ...m, [key]: "error" })))
      .finally(() => walkAiLoading.current.delete(key));
  }, [walkWantsAi, walkAiKey, walkItem, runId, walkAi]);
  const retryWalkAi = () =>
    setWalkAi((m) => {
      const next = { ...m };
      delete next[walkAiKey];
      return next;
    });
  const walkViewKey = walkViewOptions.map((o) => o.value).join(",");
  const cycleWalkView = useCallback(() => {
    const values = walkViewKey.split(",") as WcView[];
    if (values.length < 2) return;
    const i = values.indexOf(walkView);
    setWalkView(values[(i + 1) % values.length]);
  }, [walkViewKey, walkView]);

  // --- View switcher (footer): Question · result view(s) · Solution --------
  // One ordered list per question; A cycles it, E jumps to the first result
  // view, L to the solution. The solution segment only appears when the
  // question has a correct answer to reveal after closing.
  const activeQuestion = activeId != null ? questions.find((q) => q.id === activeId) : undefined;
  const hasSolution = canReveal && !!activeQuestion?.options.some((o) => o.is_correct);
  const viewGroup =
    activeKind === "word_cloud"
      ? "wc"
      : isOpenText
        ? "ft"
        : activeKind === "mindmap"
          ? "mm"
          : activeKind === "matrix"
            ? "mx"
            : null;
  const viewValuesKey = wcViewOptions.map((o) => o.value).join(",");
  const viewSegments = useMemo(
    () =>
      buildViewSegments<WcView>({
        group: viewGroup,
        views: viewValuesKey ? (viewValuesKey.split(",") as WcView[]) : [],
        solution: hasSolution,
      }),
    [viewGroup, viewValuesKey, hasSolution],
  );
  // A live word cloud / mind map is on screen before the results phase (the
  // vote is open, or a closed rating): its result view is the current one,
  // and "Question" can't hide it.
  const liveShown =
    phase !== "results" &&
    ((activeKind === "word_cloud" && wcCloudShown) ||
      (activeKind === "mindmap" && mmShown) ||
      (activeKind === "matrix" && mxShown));
  const resultSegment = (view: WcView) =>
    viewSegments.find((sg) => sg.level === "results" && (sg.view === undefined || sg.view === view));
  const activeSegment: ViewSegment<WcView> =
    (phase === "results" && revealed && hasSolution
      ? viewSegments.find((sg) => sg.level === "solution")
      : phase === "results" || liveShown
        ? resultSegment(wcView)
        : undefined) ?? viewSegments[0];
  // The board on a closed vote (not a closed rating with hidden scores):
  // "Question" stays available — it just drops the board (the phase is
  // "closed" already).
  const resumeOnly = closedBoard && !mmScoresHidden && !mxScoresHidden;
  const disabledViews = useMemo(
    () => new Set(liveShown && !resumeOnly ? ["view.question"] : []),
    [liveShown, resumeOnly],
  );
  const applyView = useCallback(
    (seg: ViewSegment<WcView>) => {
      if (seg.level === "question") {
        if (resumeOnly) setQuestionOnly(activeId ?? null);
        else if (!liveShown) {
          setQuestionOnly(activeId ?? null);
          void showQuestion();
        }
        return;
      }
      if (seg.level === "solution") {
        void showSolution();
        return;
      }
      if (seg.view) setWcView(seg.view);
      if (phase === "results") {
        if (revealed) void showResults(); // back from the solution
      } else if (!(liveShown && phase === "open")) {
        // Closes an open vote and shows the results (a closed rating:
        // reveals its scores) — same path as E.
        void showResults();
      }
    },
    [liveShown, resumeOnly, activeId, phase, revealed, showQuestion, showResults, showSolution],
  );
  // A click on the segment already shown does nothing (e.g. a closed rating
  // with hidden scores must not reveal them).
  const selectView = useCallback(
    (seg: ViewSegment<WcView>) => {
      if (seg.id !== activeSegment.id) applyView(seg);
    },
    [activeSegment.id, applyView],
  );
  // A only looks — it never takes a question out of "open": during an open
  // vote it cycles the result views of a live cloud / map (nothing else is
  // on screen to switch); otherwise the whole list. Closing stays with S/E.
  // A live cloud / map before the results phase (open vote, closed rating)
  // only switches its views, never the phase; on a closed rating it skips
  // the Ranking (the scores) — those are revealed by E or a click only.
  const lookOnly = liveShown && !resumeOnly; // (liveShown implies phase !== "results")
  const cycleSegments = useMemo(
    () =>
      viewSegments.filter((sg) =>
        disabledViews.has(sg.id)
          ? false
          : lookOnly
            ? sg.level === "results" && !(phase === "closed" && sg.view === "ranking")
            : phase !== "open",
      ),
    [viewSegments, disabledViews, lookOnly, phase],
  );
  const canCycle = cycleSegments.length >= 2;
  // Why "Question" can't be chosen while a live view is on screen.
  const disabledViewReason =
    phase === "open"
      ? t("The results are shown live while the vote is open.")
      : t("The live view stays on screen until the results are shown.");
  const cycleView = useCallback(() => {
    if (cycleSegments.length < 2) return;
    const i = cycleSegments.findIndex((sg) => sg.id === activeSegment.id);
    const next = cycleSegments[(i + 1) % cycleSegments.length];
    if (lookOnly) {
      if (next.view) setWcView(next.view);
    } else selectView(next);
  }, [cycleSegments, lookOnly, activeSegment.id, selectView]);
  // E: to the first result view; from there back to the question (toggle);
  // an open vote closes onto it (word clouds / mind maps stay visible).
  const firstResults = viewSegments.find((sg) => sg.level === "results");
  const jumpToResults = useCallback(() => {
    if (!firstResults) return;
    if (phase !== "results") {
      if (firstResults.view) setWcView(firstResults.view);
      void showResults();
    } else if (activeSegment.id === firstResults.id && !revealed) {
      setQuestionOnly(activeId ?? null);
      void showQuestion();
    } else {
      applyView(firstResults);
    }
  }, [firstResults, phase, activeSegment.id, revealed, activeId, showResults, showQuestion, applyView]);
  // L: the solution, and back to the results.
  const toggleSolution = useCallback(() => {
    if (!hasSolution) return;
    if (phase === "results" && revealed) void showResults();
    else void showSolution();
  }, [hasSolution, phase, revealed, showResults, showSolution]);

  // quizbar (fork), key J: show/hide why each answer is right or wrong. The
  // server also switches to the results and reveals the correct answers.
  const justificationShown = !!state?.justification_shown;
  const hasJustification =
    (activeKind === "single_choice" || activeKind === "multiple_choice") &&
    !!activeQuestion?.options.some((o) => (o.justification ?? "").trim());
  const toggleJustification = useCallback(() => {
    if (!runId || !hasJustification) return;
    if (phase === "lobby" || phase === "finished") return;
    void quizbar.justification(runId, !justificationShown);
  }, [runId, hasJustification, phase, justificationShown]);

  // Memoized so the keydown effect (which lists it as a dependency) doesn't
  // re-register the window listener on every render — including the live
  // path's frequent SSE-driven re-renders (#75). Declared before onKey, which
  // references it.
  const leavePresentation = useCallback(() => {
    navigate(`/sets/${id}`);
  }, [navigate, id]);
  // ✕ / Esc (spec PR 2): leave WITHOUT ending — an open vote is closed and
  // participants see „paused"; the run is ended from the set overview (or
  // resumed by presenting again). Always back to the set overview in the same
  // tab — never closes the window, even when opened from the editor.
  // Runs once (double-click on ✕, ✕ then Esc); a hanging request must not
  // keep the presenter on the beamer — after a short wait it leaves anyway.
  const leavingRef = useRef(false);
  const leave = useCallback(async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    if (runId && !selfPaced) {
      await Promise.race([
        live.control(runId, { away: true }).catch(() => {
          // leave anyway — the run stays as it is
        }),
        new Promise((resolve) => window.setTimeout(resolve, 3000)),
      ]);
    }
    navigate(`/sets/${id}`, { replace: true });
  }, [runId, selfPaced, navigate, id]);
  // Closing slide reached in live mode, run not finished yet (see finish()).
  const [pendingFinish, setPendingFinish] = useState(false);
  const finishAndLeave = useCallback(async () => {
    if (pendingFinish && runId) {
      try {
        await live.control(runId, { phase: "finished" });
      } catch {
        // leave anyway — the run stays open and the next start resumes it
      }
    }
    leavePresentation();
  }, [pendingFinish, runId, leavePresentation]);
  // quizbar (fork): end this quiz and open the next one's start screen
  // (lobby with QR code) — a full page load, so it starts cleanly.
  const goNextQuiz = useCallback(async () => {
    if (!nextQuiz) return;
    if (pendingFinish && runId) {
      try {
        await live.control(runId, { phase: "finished" });
      } catch {
        // go on anyway — the run stays open and can be ended later
      }
    }
    window.location.assign(`/sets/${nextQuiz.id}/present`);
  }, [nextQuiz, pendingFinish, runId]);
  const backFromClosing = useCallback(() => {
    setPendingFinish(false);
    setEnded(false);
  }, []);

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      // Typing in a field: no beamer shortcuts; Escape just leaves the field
      // (it must not end the presentation).
      if (isTextField(event.target)) {
        if (event.key === "Escape") event.target.blur();
        return;
      }
      if (!runId) return;
      const key = event.key.toLowerCase();
      // Ctrl/Cmd/Alt + letter belongs to the browser / OS (Ctrl+A, Cmd+L, …),
      // never to a presenter shortcut.
      if ((event.ctrlKey || event.metaKey || event.altKey) && key.length === 1) return;
      // Shift+arrows pan the mind map / matrix board (their own listeners) —
      // they must not also navigate between questions.
      if (event.shiftKey && key.startsWith("arrow") && (mmShown || mxShown)) return;
      // Enter/Space on a focused drawer control activate that control
      // natively — they must not also advance the presentation.
      if ((key === "enter" || key === " ") && inWcDrawer(event.target)) return;
      // Space and Enter act as the primary "advance" key alongside S — a
      // presenter can page through with a clicker. Space must not scroll.
      if (key === " ") event.preventDefault();
      const advance = key === "s" || key === "enter" || key === " ";
      // Post-run results walkthrough (#75): its own tiny key scheme, kept
      // separate from the live/self-paced handling below so it can't
      // interfere with it (walk is only ever set once selfPaced+finished).
      if (walk !== null) {
        if (key === "escape") leavePresentation();
        else if (advance || key === "arrowright") walkAdvance();
        else if (key === "arrowleft") walkBack();
        else if (key === "a") cycleWalkView();
        return;
      }
      // On the closing slide (#32) any key ends and leaves — except "←",
      // which goes back to the last question while the run isn't finished.
      if (ended) {
        if (key === "m" && gameRunRef.current !== null) sounds.toggleMute();
        else if (key === "n" && nextQuiz) void goNextQuiz();
        else if (key === "arrowleft" && pendingFinish) backFromClosing();
        else if (!["shift", "control", "alt", "meta", "tab", "capslock"].includes(key)) void finishAndLeave();
        return;
      }
      if (selfPaced) {
        if (key === "escape") void finish();
        return;
      }
      // ? / H: the help overlay (labels every control; closes itself).
      if (key === "?" || key === "h") {
        setShowHelp(true);
        return;
      }
      // While the interstitial is up, S/→/Enter/Space confirm it, Esc dismisses.
      if (interstitial) {
        if (advance || key === "arrowright") confirmInterstitial();
        else if (key === "escape") setInterstitial(null);
        return;
      }
      // The QR/join panel is a transient overlay — Esc closes it first (so it
      // doesn't end the presentation), "q" toggles it. Neither touches the
      // vote phase.
      if (key === "escape" && showJoin) {
        setShowJoin(false);
        return;
      }
      // Likewise an open word-cloud drawer (AI panel / moderation).
      if (key === "escape" && (showAiPanel || showModPanel || mmAiRef.current.open)) {
        setShowAiPanel(false);
        setShowModPanel(false);
        if (mmAiRef.current.open) mmAiRef.current.close();
        return;
      }
      if (key === "q") {
        setShowJoin((v) => !v);
        return;
      }
      // quizbar (fork): game mode — P leaderboard, M sound on/off.
      if (game && key === "p" && runId && phase !== "lobby") {
        setBoardOpen((v) => !v);
        return;
      }
      if (game && key === "m") {
        sounds.toggleMute();
        return;
      }
      if (boardOpen && key === "escape") {
        setBoardOpen(false);
        return;
      }
      if (key === "arrowright") advanceNext();
      else if (key === "arrowleft") goPrev();
      else if (advance) {
        if (phase === "open")
          // Word clouds and mindmaps freeze onto the results view (they stay
          // visible), matching the Stop button; other kinds just close.
          (activeKind === "word_cloud" || activeKind === "mindmap" || activeKind === "matrix") && !stopCloses
            ? void showResults()
            : void live.control(runId, { phase: "closed" });
        else if (phase === "preview" || phase === "closed" || phase === "results")
          void live.control(runId, { phase: "open" });
        else if (phase === "lobby") startFromLobby();
      } else if (key === "e" || key === "r") {
        // E/R: the first result view. From a revealed solution it returns to
        // the results (#61), from there it toggles to the question.
        jumpToResults();
      } else if (key === "a") {
        // A cycles the footer's view switcher (Question → results → …).
        cycleView();
      } else if (key === "l") {
        toggleSolution();
      } else if (key === "j") {
        toggleJustification();
      } else if (key === "escape") {
        void leave();
      }
    },
    [leave, runId, phase, activeKind, requestGoto, goPrev, advanceNext, confirmInterstitial, interstitial, selfPaced, ended, jumpToResults, cycleView, toggleSolution, toggleJustification, startFromLobby, showResults, showJoin, showAiPanel, showModPanel, walk, walkAdvance, walkBack, cycleWalkView, leavePresentation, mmShown, mxShown, stopCloses, pendingFinish, backFromClosing, finishAndLeave, nextQuiz, goNextQuiz, game, sounds, boardOpen],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  async function finish() {
    // Live: the closing slide comes first and the run is only finished when
    // the presenter leaves it — so "←" can still go back to the last question
    // (a finished run can't be reopened).
    if (!selfPaced) {
      setPendingFinish(true);
      setEnded(true);
      return;
    }
    if (runId) await live.control(runId, { phase: "finished" });
    // Quiz-Block post-run walkthrough (#75): when the set opts in, step
    // through the just-finished run's per-question results instead of
    // jumping straight to the closing slide. Falls back to the closing
    // slide when the option is off, there's no run/results, or the fetch
    // fails.
    if (selfPaced && presentResultsAfter && runId) {
      try {
        const payload = await results.list(id);
        const run = payload.results.find((r) => r.run === runId) ?? payload.results[0];
        if (run && run.questions.length > 0) {
          setWalk(run.questions);
          setWalkIndex(0);
          return;
        }
      } catch {
        // fall through to the closing slide below
      }
    }
    setEnded(true); // show the closing slide; leaving is a separate step (#32)
  }


  // --- rendering --------------------------------------------------------------
  if (dialog) {
    return (
      <Shell>
        <div className="mx-auto max-w-xl rounded-2xl border border-slate-200 p-8 text-center">
          <h2 className="text-2xl font-bold">
            {selfPaced
              ? t("There are already answers for this quiz")
              : t("There are already results")}
          </h2>
          <p className="mt-2 text-slate-500">
            {selfPaced
              ? t("How do you want to handle the existing answers?")
              : t("How do you want to handle the existing results?")}
          </p>
          <div className="mt-6 grid gap-2 text-left">
            <button
              className="rounded-xl bg-brand-400 px-5 py-3 font-semibold text-slate-900 hover:bg-brand-500"
              onClick={() => void startAfterDialog("continue")}
            >
              {t("Keep counting")}
              <span className="block text-sm font-normal text-slate-700">
                {selfPaced
                  ? t("New answers count into the same run.")
                  : t("New votes count into the same run.")}
              </span>
            </button>
            <button
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold hover:bg-slate-50"
              onClick={() => void startAfterDialog("archive")}
            >
              {t("Archive & restart")}
              <span className="block text-sm font-normal text-slate-500">
                {t("The existing run stays archived.")}
              </span>
            </button>
            <button
              className="rounded-xl border border-red-200 px-5 py-3 font-semibold text-red-700 hover:bg-red-50"
              onClick={() => void startAfterDialog("delete")}
            >
              {t("Delete")}
              <span className="block text-sm font-normal text-red-700">
                {selfPaced
                  ? t("All existing answers are discarded.")
                  : t("All existing results are discarded.")}
              </span>
            </button>
            <button
              className="mt-1 rounded-xl px-5 py-2 text-sm font-medium text-slate-500 hover:bg-slate-50"
              onClick={() => navigate(`/sets/${id}`)}
            >
              {t("Cancel")}
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // Post-run results walkthrough (#75, Quiz-Block): one slide per question,
  // teacher-driven, correct answers always revealed. Rendered independently
  // of the live phase/results block above — it feeds from the stored
  // RunResults item for `walkIndex`, not from `state`.
  if (walk !== null) {
    const item = walk[walkIndex];
    const btn =
      "inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50";
    return (
      <Shell
        logo={beamerLogo}
        footer={
          <footer className="flex items-center justify-between border-t border-slate-200 px-6 py-3 text-sm text-slate-500">
            <div className="flex items-center gap-3">
              <span>
                {t("Question {{current}}/{{total}}", {
                  current: walkIndex + 1,
                  total: walk.length,
                })}
              </span>
              {walkViewOptions.length > 1 && (
                <label className={`${btn} gap-2`}>
                  {t("View")}
                  <select
                    value={walkView}
                    onChange={(event) => setWalkView(event.target.value as WcView)}
                    className="bg-transparent font-medium text-slate-700 focus:outline-none dark:text-slate-200"
                  >
                    {walkViewOptions.map((view) => (
                      <option key={view.value} value={view.value}>
                        {view.label}
                      </option>
                    ))}
                  </select>
                  <Kbd>A</Kbd>
                </label>
              )}
            </div>
            <div className="flex gap-2">
              <button className={`${btn} text-red-700`} onClick={leavePresentation}>
                {t("Back to overview")} <Kbd>Esc</Kbd>
              </button>
              <button
                className={btn}
                onClick={walkBack}
                disabled={walkIndex === 0}
                aria-label={t("Back (←)")}
              >
                <ChevronLeft aria-hidden className="h-5 w-5" />
              </button>
              <button className={btn} onClick={walkAdvance} aria-label={t("Next (→)")}>
                <ChevronRight aria-hidden className="h-5 w-5" />
              </button>
            </div>
          </footer>
        }
      >
        <div key={item.id} className="ab-fade-in mx-auto flex min-h-full max-w-4xl flex-col justify-center">
          <RichText
            className="text-xl font-semibold leading-snug sm:text-2xl md:text-3xl [&_img]:mx-auto [&_img]:my-4 [&_img]:max-h-64 [&_ul]:list-disc [&_ul]:pl-8"
            html={mathHtml(localizedText(item.text))}
          />
          <WalkthroughResultBody
            item={item}
            view={walkView}
            ai={walkAi[walkAiKey]}
            onRetryAi={retryWalkAi}
          />
        </div>
      </Shell>
    );
  }

  // Closing slide (#32): the run is finished — dwell here until the presenter
  // actively leaves, rather than snapping back to the management screen.
  if (ended) {
    return (
      <Shell logo={beamerLogo}>
        <div className="ab-fade-in flex min-h-full flex-col items-center justify-center gap-6 text-center">
          {gameRunRef.current !== null ? (
            // quizbar (fork): game mode ends on the podium.
            <Podium runId={gameRunRef.current} sounds={sounds} />
          ) : (
            <>
              <div className="text-7xl" aria-hidden>✅</div>
              <h1 className="text-5xl font-bold">{t("The survey has ended")}</h1>
              <p className="text-2xl text-slate-500">{t("Thanks for taking part!")}</p>
            </>
          )}
          <div className="mt-4 flex items-center gap-3">
            {pendingFinish && (
              <button
                onClick={backFromClosing}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-300 px-5 py-3 text-lg font-medium text-slate-700 hover:bg-slate-50"
              >
                <ChevronLeft aria-hidden className="h-5 w-5" />
                {t("Back")}
              </button>
            )}
            <button
              onClick={() => void finishAndLeave()}
              className={
                nextQuiz
                  ? "inline-flex items-center gap-2 rounded-xl border border-slate-300 px-5 py-3 text-lg font-medium text-slate-700 hover:bg-slate-50"
                  : "inline-flex items-center gap-2 rounded-xl bg-brand-400 px-6 py-3 text-lg font-semibold text-slate-900 hover:bg-brand-500"
              }
            >
              {t("Back to overview")}
            </button>
            {/* quizbar (fork): next set of the ordered folder. */}
            {nextQuiz && (
              <button
                onClick={() => void goNextQuiz()}
                className="inline-flex items-center gap-2 rounded-xl bg-brand-400 px-6 py-3 text-lg font-semibold text-slate-900 hover:bg-brand-500"
              >
                {t("Next quiz: {{title}}", {
                  title: `${nextQuiz.number} – ${localizedText(nextQuiz.title)}`,
                })}
                <ChevronRight aria-hidden className="h-5 w-5" />
              </button>
            )}
          </div>
          <p className="text-sm text-slate-500">
            {pendingFinish
              ? t("Any key ends the survey · ← back to the last question")
              : t("Any key returns to the overview")}
            {nextQuiz && <> · {t("N: next quiz")}</>}
          </p>
        </div>
      </Shell>
    );
  }

  if (!state) return <Shell>{t("Connecting …")}</Shell>;

  // Self-paced dashboard (concept §6.3): QR for joining plus live progress;
  // participants drive themselves, the teacher only watches and ends.
  if (selfPaced) {
    const progress = state.progress ?? [];
    const denominator = Math.max(
      state.participants ?? 0,
      ...progress.map((row) => row.votes),
      1,
    );
    return (
      <Shell
        logo={beamerLogo}
        footer={
          <footer className="flex items-center justify-between border-t border-slate-200 px-6 py-3 text-sm text-slate-500">
            <span className="flex items-center gap-4">
              <span>
                <Users aria-hidden className="inline h-4 w-4" /> {state.participants ?? 0} · {state.votes_total ?? 0}{" "}
                {t("answer", { count: state.votes_total ?? 0 })}
              </span>
            </span>
            <button
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-slate-50"
              onClick={() => void finish()}
            >
              {t("End quiz (Esc)")}
            </button>
          </footer>
        }
      >
        <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-10 lg:flex-row lg:items-center">
          <div className="flex flex-col items-center gap-4 text-center">
            {/* Quiz-Block accent (#75): amber, matching the set-type badge
                everywhere else — not the green brand color. */}
            <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              {t("Self-paced quiz")}
            </span>
            {quizRemaining !== null && (
              <div className="flex flex-col items-center gap-1">
                <span
                  className={`flex items-center gap-3 text-5xl font-bold tabular-nums ${countdownColor(quizRemaining)}`}
                >
                  <Timer aria-hidden className="h-10 w-10" />
                  {String(Math.floor(quizRemaining / 60)).padStart(2, "0")}:
                  {String(quizRemaining % 60).padStart(2, "0")}
                </span>
                <span className="text-sm font-medium text-slate-500">{t("Time left")}</span>
              </div>
            )}
            <h1 className="text-3xl font-bold">{localizedText(state.set_title)}</h1>
            <img
              src={live.qrUrl(state.room.code)}
              alt={t("QR code for {{url}}", { url: live.participantUrl(state.room.code) })}
              className="h-64 w-64 rounded-2xl border border-slate-200"
            />
            <p className="text-xl text-slate-600">
              {live.participantHost(state.room.code)}
            </p>
            <p className="text-4xl font-extrabold tracking-widest text-brand-700">
              {state.room.code}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="mb-4 text-lg font-semibold text-slate-700">
              {t("Answers per question")}
            </h2>
            <ol className="space-y-3">
              {progress.map((row, i) => (
                <li key={row.id}>
                  <div className="mb-1 flex items-baseline justify-between gap-4">
                    <span className="truncate text-slate-700">
                      <span className="font-bold text-brand-700">{i + 1}.</span>{" "}
                      {localizedText(row.text) || t("(no text)")}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-500">
                      {row.votes}
                    </span>
                  </div>
                  <div className="h-4 rounded-md bg-slate-100">
                    <div
                      className="h-4 rounded-md transition-all duration-500"
                      style={{ background: categoryColor(i), width: `${Math.round((row.votes / denominator) * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </Shell>
    );
  }

  // Section interstitial (v2 "Zwischenfolie"): a full slide with the section
  // name; the teacher confirms with S / → to call up the section's first
  // question.
  if (interstitial) {
    const target = interstitial.index;
    return (
      <Shell
        logo={beamerLogo}
        overlay={<JoinCorner room={state.room} />}
        stats={<LiveStats state={state} />}
        footer={
          <Footer
            phase={phase}
            index={target}
            count={questions.length}
            variant="section"
            onPrev={() => {
              setInterstitial(null);
              requestGoto(target - 1);
            }}
            onNext={confirmInterstitial}
            onLeave={() => void leave()}
            onHelp={() => setShowHelp(true)}
            helpShown={showHelp}
          />
        }
      >
        {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
        <SectionInterstitial title={interstitial.title} description={interstitial.description} />
      </Shell>
    );
  }

  const question = state.question;
  const total = state.votes ?? 0;
  // QR boxes in the top-left corner (join badge there, recording QR): the
  // content keeps clear of them and the countdown moves below them.
  const cornerBoxes =
    phase !== "lobby" ? topLeftBoxes(state.room, !!(state.recording_token && question)) : 0;

  return (
    <Shell
      logo={beamerLogo}
      // The mind map uses the full width (it is pannable and fits itself
      // around the QR boxes) — no left column for it.
      reserveTopLeft={mmShown ? 0 : cornerBoxes}
      overlay={
        phase !== "lobby" ? (
          <>
            <JoinCorner room={state.room} />
            {state.recording_token && question && (
              <RecordingCorner
                room={state.room}
                token={state.recording_token}
                questionId={question.id}
              />
            )}
            {showJoin && (
              <JoinPanel room={state.room} onClose={() => setShowJoin(false)} />
            )}
          </>
        ) : null
      }
      stats={
        // Rating stage: ✓ counts those who have rated so far (the points /
        // ratings against the budget come from `progress`).
        <LiveStats state={state} raters={rateStats?.raters} />
      }
      footer={
        <Footer
          phase={phase}
          index={indexRef.current}
          rating={(mmRate || mxRate) && phase !== "lobby"}
          extra={
            activeKind === "mindmap" && mmRating && phase !== "lobby" ? (
              mmRate ? (
                <FooterIconButton
                  help="mm.collect"
                  label={t("Back to collecting")}
                  icon={Undo2}
                  detail={t("Back to collecting: participants add terms again; the ratings are kept.")}
                  disabled={mmStageBusy}
                  onClick={() => void setMindmapStage("collect")}
                />
              ) : phase === "results" || phase === "closed" ? (
                <FooterIconButton
                  help="mm.rate"
                  testId="mm-start-rating"
                  label={t("Start rating")}
                  icon={ThumbsUp}
                  detail={
                    mmRating.mode === "points"
                      ? t("Participants distribute {{count}} points among the terms.", { count: mmRating.budget })
                      : t("Participants rate up to {{count}} terms with 👍 or 👎.", { count: mmRating.budget })
                  }
                  disabled={mmStageBusy}
                  onClick={() => void setMindmapStage("rate")}
                  className="border-brand-400 bg-brand-400 text-slate-900 hover:bg-brand-500"
                  nextStep
                />
              ) : null
            ) : activeKind === "matrix" && mxRating && phase !== "lobby" ? (
              mxRate ? (
                <FooterIconButton
                  help="mx.collect"
                  testId="mx-back-to-collecting"
                  label={t("Back to collecting")}
                  icon={Undo2}
                  detail={t("Back to collecting: participants add cards again; the ratings are kept.")}
                  disabled={mxStageBusy}
                  onClick={() => void setMatrixStage("collect")}
                />
              ) : phase === "results" || phase === "closed" ? (
                <FooterIconButton
                  help="mx.rate"
                  testId="mx-start-rating"
                  label={t("Start rating")}
                  icon={ThumbsUp}
                  detail={
                    mxRating.mode === "points"
                      ? t("Participants distribute {{count}} points among the cards.", { count: mxRating.budget })
                      : t("Participants rate up to {{count}} cards with 👍 or 👎.", { count: mxRating.budget })
                  }
                  disabled={mxStageBusy}
                  onClick={() => void setMatrixStage("rate")}
                  className="border-brand-400 bg-brand-400 text-slate-900 hover:bg-brand-500"
                  nextStep
                />
              ) : null
            ) : undefined
          }
          count={questions.length}
          onPrev={goPrev}
          onNext={advanceNext}
          questionTitles={jumpTitles}
          onJump={(i) => requestGoto(i)}
          onToggle={() =>
            phase === "open"
              ? // Word clouds jump straight to results on close so the cloud
                // stays on screen (and #30's deferred cloud appears); "Frage"
                // then hides it. Other kinds close first, reveal on demand.
                (activeKind === "word_cloud" || activeKind === "mindmap" || activeKind === "matrix") &&
                !stopCloses
                ? void showResults()
                : void live.control(runId!, { phase: "closed" })
              : phase === "lobby"
                ? startFromLobby()
                : void live.control(runId!, { phase: "open" })
          }
          views={viewSegments}
          activeView={activeSegment.id}
          disabledViews={disabledViews}
          disabledViewReason={disabledViewReason}
          onSelectView={(seg) => selectView(seg as ViewSegment<WcView>)}
          joinShown={showJoin}
          onToggleJoin={() => setShowJoin((v) => !v)}
          onLeave={() => void leave()}
          onHelp={() => setShowHelp(true)}
          helpShown={showHelp}
        />
      }
    >
      {/* quizbar (fork): game mode leaderboard (P) and sound switch (M). */}
      {boardOpen && game && runId && (
        <LeaderboardOverlay runId={runId} onClose={() => setBoardOpen(false)} />
      )}
      {game && <MuteBadge muted={sounds.muted} onToggle={sounds.toggleMute} />}
      {showHelp && (
        <HelpOverlay
          views={viewSegments}
          canCycle={canCycle}
          disabledReason={disabledViewReason}
          onClose={() => setShowHelp(false)}
        />
      )}
      {leaveWarn && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-6">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-xl">
            <h2 className="text-xl font-bold text-slate-900">
              {leaveWarn.mode === "not_started"
                ? t("Question not started")
                : t("Vote still running")}
            </h2>
            <p className="mt-2 text-slate-600">
              {leaveWarn.mode === "not_started"
                ? t("This question hasn't been opened for voting yet.")
                : t("The current question is still open. Really move on?")}
            </p>
            <label className="mt-4 flex items-center justify-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(event) => setDontAskAgain(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-brand-600"
              />
              {t("Don't ask again in this presentation")}
            </label>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <button
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                onClick={dismissWarn}
              >
                {t("Cancel")}
              </button>
              {leaveWarn.mode === "not_started" && (
                <button
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  onClick={proceedLeave}
                >
                  {t("Continue anyway")}
                </button>
              )}
              <button
                className="rounded-lg bg-brand-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-brand-500"
                onClick={leaveWarn.mode === "not_started" ? startCurrentVote : proceedLeave}
              >
                {leaveWarn.mode === "not_started" ? t("Start voting") : t("Continue")}
              </button>
            </div>
          </div>
        </div>
      )}
      {phase === "lobby" && (
        <div
          data-tour="present.join"
          className="ab-fade-in flex min-h-full flex-col items-center justify-center gap-6 text-center"
        >
          <h1 className="text-4xl font-bold">{localizedText(state.set_title)}</h1>
          <img
            src={live.qrUrl(state.room.code)}
            alt={t("QR code for {{url}}", { url: live.participantUrl(state.room.code) })}
            className="h-72 w-72 rounded-2xl border border-slate-200"
          />
          <p className="text-2xl text-slate-600">
            {live.participantHost(state.room.code)}
          </p>
          <p className="text-5xl font-extrabold tracking-widest text-brand-700">
            {state.room.code}
          </p>
          <p className="text-slate-400">
            {state.participants ?? 0}{" "}
            <Trans i18nKey="present_lobby_hint">
              connected · First question with <Kbd>S</Kbd> or <Kbd>→</Kbd>
            </Trans>
          </p>
          {/* quizbar (fork): game mode — who is in. */}
          {game && <GameLobby players={game.players} />}
          {/* Recording mode (#53): enabled on the set page; just confirm here. */}
          {state.recording_token && (
            <p className="text-sm font-semibold text-brand-700">
              ● {t("Recording on — viewers can vote later via the per-question QR code.")}
            </p>
          )}
        </div>
      )}

      {question && phase !== "lobby" && (
        <div
          key={question.id}
          className={
            wideShown
              ? "ab-fade-in flex h-full flex-col"
              : "ab-fade-in mx-auto flex min-h-full max-w-4xl flex-col justify-center"
          }
        >
          {phase === "open" && remaining !== null && (
            <div
              data-beamer-inset=""
              className={`fixed left-6 z-20 flex items-center gap-2 text-5xl font-extrabold tabular-nums ${
                cornerBoxes === 2 ? "top-[18.5rem]" : cornerBoxes === 1 ? "top-40" : "top-4"
              } ${countdownColor(remaining)}`}
            >
              <Timer aria-hidden className="h-9 w-9" /> {countdownLabel(remaining)}
            </div>
          )}
          {wideShown ? (
            // Centred on the full width, kept clear of top-left QR boxes.
            <div className="mx-auto w-full" style={mmClear(56)}>
              <RichText
                className="line-clamp-2 text-center text-lg font-semibold leading-snug md:text-xl [&_img]:hidden"
                html={mathHtml(localizedText(question.text))}
              />
            </div>
          ) : (
            <RichText
              className="text-xl font-semibold leading-snug sm:text-2xl md:text-3xl [&_img]:mx-auto [&_img]:my-4 [&_img]:max-h-64 [&_ul]:list-disc [&_ul]:pl-8"
              html={mathHtml(localizedText(question.text))}
            />
          )}

          {/* Mindmap: the shared tree, live while open and on "Ergebnis"
              (compact / detailed from the footer view picker). */}
          {/* One-time moderation hint as a slim banner in the flow (the map
              fits itself around it instead of being covered). */}
          {mmHintVisible && (
            <div
              style={mmClear(48)}
              className="mx-auto mt-2 flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-1.5 text-sm text-slate-700">
              <Info className="h-4 w-4 shrink-0 text-brand-600" aria-hidden />
              <p className="flex-1">
                {t("Tip: + adds a term. Drag a term onto another to merge them, or onto the “Attach here” tab beside it (shown while dragging) to attach it there as a sub-term; double-click renames, × hides (the pencil on the right shows hidden terms and your moderation steps for selective reset). Ctrl+Z undoes.")}
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.currentTarget.blur();
                  dismissMmHint();
                }}
                aria-label={t("Dismiss")}
                className="rounded p-0.5 text-slate-500 hover:bg-brand-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {/* Rating phase: what participants do now, the budget, and whether
              the scores stay hidden until "Ergebnis". */}
          {mmShown && mmRating && mmRate && phase === "open" && (
            <p
              style={mmClear(56)}
              className="mx-auto mt-1 text-center text-base leading-relaxed text-slate-600"
              data-testid="mm-rating-banner"
            >
              <span className="mr-2 inline-block rounded-full bg-brand-100 px-2.5 py-0.5 text-sm font-semibold text-brand-800">
                {t("Rating")}
              </span>
              {mmRating.mode === "points"
                ? t("Rate the terms on your device: {{count}} points per person", {
                    count: mmRating.budget,
                  })
                : t("Rate the terms on your device with 👍 / 👎: up to {{count}} ratings per person", {
                    count: mmRating.budget,
                  })}
              {!mmRating.scores && (
                <span className="text-slate-500"> · {t("results follow at the end")}</span>
              )}
            </p>
          )}
          {/* Rating stopped but not yet revealed. */}
          {mmShown && mmRating && mmRate && phase === "closed" && (
            <p
              style={mmClear(56)}
              className="mx-auto mt-1 text-center text-base leading-relaxed text-slate-600"
              data-testid="mm-rating-closed"
            >
              <span className="mr-2 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-semibold text-slate-700">
                {t("Rating closed")}
              </span>
              {mmRating.scores ? null : (
                <Trans i18nKey="mm_rating_reveal_hint">
                  Reveal the results with <Kbd>E</Kbd>
                </Trans>
              )}
            </p>
          )}
          {mmShown && mindmap && wcView === "ranking" && mmRating?.scores && (
            <div className="mx-auto mt-6 w-full max-w-4xl" data-testid="mm-ranking">
              <MindmapRanking entries={mmRanking} mode={mmRating.mode} limit={8} animate hues={mmHues} />
            </div>
          )}
          {mmShown && mmPreview && (
            <p
              style={{ ...mmClear(48), borderColor: AI_MARK, color: AI_MARK }}
              className="mx-auto mt-2 flex items-center justify-center gap-2 rounded-lg border-2 bg-white px-3 py-1.5 text-sm font-medium"
              data-testid="mm-ai-preview-banner"
            >
              <Sparkles className="h-4 w-4 shrink-0" aria-hidden />
              {t("Preview of the AI proposal — nothing has been changed yet.")}
            </p>
          )}
          {mmShown && mmPreview && (
            <div
              className="-mx-8 -mb-6 mt-3 min-h-0 flex-1"
              style={mmAi.open ? { marginRight: "22rem" } : undefined}
              data-testid="mm-ai-preview"
            >
              <MindMap
                rootLabel={localizedText(mmPreview.root.label)}
                nodes={mmPreview.nodes}
                detailed={mmDetailed}
                highlightDuplicates={mmPreview.highlight_duplicates}
                maxDepth={mmPreview.depth}
                withDescriptions={mmPreview.descriptions}
                zoomHandleTop={mmZoomTop}
                memoryKey={`${runId}:${question.id}`}
                previewMarks
              />
            </div>
          )}
          {mmShown && mindmap && !mmPreview && wcView !== "ranking" && (
            <div
              className="-mx-8 -mb-6 mt-3 min-h-0 flex-1"
              style={mmAi.open ? { marginRight: "22rem" } : undefined}
            >
              <MindMap
                rootLabel={localizedText(mindmap.root.label)}
                nodes={mindmap.nodes}
                detailed={mmDetailed}
                onDetailedChange={mindmap.descriptions ? setMmDetailed : undefined}
                highlightDuplicates={mindmap.highlight_duplicates}
                onHide={expert ? (n) => hideMindmapNode(n.id, true) : undefined}
                onAdd={expert && !mmRate ? mmMod.add : undefined}
                onMerge={expert && !mmRate ? mmMod.merge : undefined}
                onMove={expert && !mmRate ? mmMod.move : undefined}
                onRename={expert && !mmRate ? mmMod.rename : undefined}
                maxDepth={mindmap.depth}
                withDescriptions={mindmap.descriptions}
                zoomHandleTop={mmZoomTop}
                memoryKey={`${runId}:${question.id}`}
                rating={mmRating}
                lockedNote={
                  expert && mmRate
                    ? t("During the rating, terms can only be hidden — adding, merging, moving and renaming return with “Back to collecting”.")
                    : undefined
                }
              />
            </div>
          )}

          {/* Matrix: the live board (drag, stack, open, hide, teacher cards). */}
          {mxShown && runId != null && (
            <MatrixPanel
              key={question.id}
              runId={runId}
              questionId={question.id}
              board={matrixBoard!}
              settings={matrixSettings!}
              handleTop={handleColumnTop}
              handleStep={HANDLE_STEP}
              drawerAttr={WC_DRAWER_ATTR}
              // Esc belongs to these overlays first (the presenter closes them).
              overlayOpen={showJoin || showAiPanel || showModPanel || mmAi.open}
              rating={mxRating}
              phase={phase}
              view={wcView === "ranking" ? "ranking" : "raw"}
              aiAvailable={showMxAi}
            />
          )}

          {question.kind !== "word_cloud" && question.kind !== "open_text" &&
            question.kind !== "mindmap" && question.kind !== "matrix" &&
            question.kind !== "likert" && phase !== "results" && (
            <ol className="mt-8 space-y-3">
              {question.options.map((option, i) => (
                <li key={option.id} className="flex items-center gap-4 rounded-2xl border border-slate-200 px-5 py-3 text-lg sm:text-xl md:text-2xl">
                  <span className="font-bold text-brand-700">{LETTERS[i]}</span>
                  {option.image && (
                    <img
                      src={`${API_BASE_URL}${option.image}`}
                      alt=""
                      className="max-h-28 rounded-xl"
                    />
                  )}
                  <MathText text={localizedText(option.text)} />
                </li>
              ))}
            </ol>
          )}

          {/* Likert scale on the beamer (#86): the ordered steps as a segment
              row with the endpoint labels, matching the participant view. */}
          {question.kind === "likert" && phase !== "results" && (() => {
            const scale = question.options.filter((o) => !o.is_abstention);
            const perStep = scale.every((o) => localizedText(o.text).trim().length > 0);
            const abstain = question.options.find((o) => o.is_abstention);
            return (
              <div className="mt-8">
                <div className="flex w-full overflow-hidden rounded-2xl border border-slate-300 text-center dark:border-slate-700">
                  {scale.map((o) => (
                    <div
                      key={o.id}
                      className="flex flex-1 items-center justify-center border-l border-slate-200 py-6 text-2xl first:border-l-0 sm:text-3xl dark:border-slate-700"
                    >
                      {perStep ? (
                        <MathText text={localizedText(o.text)} />
                      ) : (
                        <span className="inline-block h-5 w-5 rounded-full border-2 border-slate-400" />
                      )}
                    </div>
                  ))}
                </div>
                {!perStep && (
                  <div className="mt-2 flex justify-between text-lg text-slate-500 dark:text-slate-400 sm:text-xl">
                    <span>{localizedText(scale[0].text)}</span>
                    <span>{localizedText(scale[scale.length - 1].text)}</span>
                  </div>
                )}
                {abstain && (
                  <div className="mt-4 inline-block rounded-xl border border-dashed border-slate-300 px-5 py-2 text-lg text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    {localizedText(abstain.text)}
                  </div>
                )}
              </div>
            );
          })()}

          {question.kind === "likert" && state.likert && phase === "results" && (
            state.before?.likert ? (
              // Before/after pair (#54): before over after, before dimmed.
              <div className="space-y-6">
                <div>
                  <span className="mb-1 block text-lg font-semibold uppercase tracking-wide text-slate-400">
                    {t("Before")}
                  </span>
                  <div className="opacity-70">
                    <LikertResult summary={state.before.likert} variant="present" animate />
                  </div>
                </div>
                <div>
                  <span className="mb-1 block text-lg font-semibold uppercase tracking-wide text-slate-400">
                    {t("After")}
                  </span>
                  <LikertResult summary={state.likert} variant="present" animate />
                </div>
              </div>
            ) : (
              <LikertResult summary={state.likert} variant="present" animate />
            )
          )}

          {question.kind === "priorities" && state.priorities && phase === "results" && (
            <div className="mt-8 space-y-4">
              {state.priorities.map((opt, i) => (
                <PriorityBar key={opt.id} index={i} label={<MathText text={localizedText(opt.text)} />} avg={opt.avg} min={opt.min} max={opt.max} animate />
              ))}
            </div>
          )}

          {question.kind === "ordering" && state.ordering && phase === "results" && (
            <OrderingResult ordering={state.ordering} animate />
          )}

          {question.kind !== "word_cloud" && question.kind !== "open_text" &&
            question.kind !== "priorities" && question.kind !== "ordering" &&
            question.kind !== "mindmap" && question.kind !== "matrix" &&
            !(question.kind === "likert" && state.likert) && phase === "results" && (
            <div className="mt-8 space-y-4">
              {(state.results ?? []).map((option, i) => {
                const count = option.count ?? 0;
                const percent = total ? Math.round((count / total) * 100) : 0;
                const hasCorrectAnswer = (state.results ?? []).some((o) => o.is_correct);
                const barState: BarState =
                  !showCorrect || !hasCorrectAnswer ? "neutral" : option.is_correct ? "correct" : "wrong";
                // Before/after pair (#54): before bar (lighter) over after bar.
                const before = state.before;
                const beforeTotal = before?.votes ?? 0;
                const beforeCount = before?.results?.[i]?.count ?? 0;
                const beforePercent = beforeTotal
                  ? Math.round((beforeCount / beforeTotal) * 100)
                  : 0;
                return (
                  <div key={option.id}>
                    <ResultBar
                      index={i}
                      label={<MathText text={localizedText(option.text)} />}
                      image={option.image}
                      count={count}
                      pct={percent}
                      state={barState}
                      animate
                      before={before ? { count: beforeCount, pct: beforePercent } : null}
                    />
                    {/* quizbar (fork): J — why this answer is right/wrong. */}
                    {justificationShown && option.justification && (
                      <p className="ab-fade-in mt-1.5 whitespace-pre-line pl-10 text-lg leading-snug text-slate-600">
                        <MathText text={option.justification} />
                      </p>
                    )}
                  </div>
                );
              })}
              {hasSolution && !revealed && (
                <p className="pt-2 text-sm text-slate-400">
                  <Trans i18nKey="present_reveal_hint_l">
                    Reveal correct answer with <Kbd>L</Kbd>
                  </Trans>
                </p>
              )}
              {hasJustification && !justificationShown && (
                <p className="pt-2 text-sm text-slate-400">
                  <Trans i18nKey="quizbar_justification_hint_j">
                    Explain the answers with <Kbd>J</Kbd>
                  </Trans>
                </p>
              )}
              {game && (
                <p className="pt-2 text-sm text-slate-400">
                  <Trans i18nKey="quizbar_leaderboard_hint_p">
                    Leaderboard with <Kbd>P</Kbd>
                  </Trans>
                </p>
              )}
            </div>
          )}

          {question.kind === "open_text" && phase === "results" && wcView === "results" && state.evaluation && (
            <div className="mt-8">
              {state.evaluation.pending > 0 && (
                <p className="mb-4 text-lg text-slate-500">
                  {state.evaluation.pending}{" "}
                  {t("answer being evaluated", { count: state.evaluation.pending })}
                </p>
              )}
              {/* Beamer shows only the scale distribution (counts/bars) for
                  AI-evaluated free text — never the individual answer texts;
                  those stay in the presenter's results overview. */}
              <div className="mx-auto mb-6 max-w-3xl space-y-3">
                {state.evaluation.groups.map((group, i) => {
                  const total = state.evaluation!.groups.reduce((s, g) => s + g.count, 0);
                  const pct = total ? Math.round((group.count / total) * 100) : 0;
                  return (
                    <ResultBar
                      key={group.verdict}
                      index={i}
                      letter={null}
                      label={evalLabel(group.verdict)}
                      count={group.count}
                      pct={pct}
                      color={evalColor(i)}
                      animate
                    />
                  );
                })}
              </div>
            </div>
          )}
          {/* Free-text "Original": the verbatim answers as chips (the only
              view that shows answer texts on the beamer); expert mode can
              merge (drag onto another) and hide (×) them. */}
          {question.kind === "open_text" && phase === "results" && wcView === "raw" && (
            <AnswerChips
              words={state.words ?? []}
              onModerate={expert ? onModerateWord : undefined}
            />
          )}
          {question.kind === "open_text" && phase === "results" && isAiView && (
            <FreeTextAiView
              view={wcView as "consolidated" | "grouped"}
              ai={state.wordcloud_ai}
              mod={mod}
              onModerate={expert ? onModerateWord : undefined}
            />
          )}

          {/* Word cloud kept off the beamer while open when the presenter
              chose to reveal it only after closing (#30). */}
          {question.kind === "word_cloud" &&
            phase === "open" &&
            question.wordcloud_live === false && (
              <div className="mt-10 text-center text-slate-500">
                <p className="text-2xl">{t("Collecting answers …")}</p>
                <p className="mt-2 text-slate-400">
                  {t("The word cloud appears once voting closes.")}
                </p>
              </div>
            )}
          {/* The cloud is the word-cloud "result": show it live while voting
              (unless the presenter deferred it to close, #30), and once the
              reveal pill is on "Ergebnis". On "Frage" it stays hidden so the
              presenter can display just the question. The view (raw / AI
              cleaned / AI grouped) is picked from the footer dropdown. */}
          {question.kind === "word_cloud" &&
            (phase === "results" ||
              (phase === "open" && question.wordcloud_live !== false)) &&
            (wcView === "raw" ? (
              (state.words ?? []).length === 0 ? (
                <p className="mt-8 text-center text-slate-400">
                  {t("No terms yet …")}
                </p>
              ) : (
                <WordCloud
                  words={rampWords(state.words ?? [])}
                  animate
                  onModerate={expert ? onModerateWord : undefined}
                />
              )
            ) : (
              <WordCloudAiView
                view={wcView as "consolidated" | "grouped"}
                ai={state.wordcloud_ai}
                mod={mod}
                onModerate={onModerateWord}
              />
            ))}

          {showModHandle && (
              <>
                {!modHintSeen && wcHasWords && (
                  <div style={{ bottom: "calc(38% + 3.5rem)" }} className="fixed right-4 z-30 flex max-w-[18rem] items-start gap-2 rounded-xl border border-brand-200 bg-brand-50/95 p-3 text-sm text-slate-700 shadow-sm">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
                    <p className="flex-1">
                      {isOpenText
                        ? t(
                            "Tip: drag one answer onto another to merge them, × hides an answer, the pencil on the right opens editing.",
                          )
                        : t(
                            "Tip: drag one term onto another to merge them, × hides a term, the pencil on the right opens editing.",
                          )}
                    </p>
                    <button
                      type="button"
                      onClick={dismissModHint}
                      aria-label={t("Dismiss")}
                      className="rounded p-0.5 text-slate-500 hover:bg-brand-100"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
                {/* Unobtrusive pencil handle at the right edge; opens the drawer. */}
                <button
                  type="button"
                  {...{ [WC_DRAWER_ATTR]: "" }}
                  onClick={(e) => {
                    e.currentTarget.blur();
                    setShowAiPanel(false);
                    setShowModPanel((s) => !s);
                  }}
                  aria-label={t("Moderate")}
                  title={t("Moderate")}
                  data-help="handle.moderate"
                  data-beamer-inset=""
                  style={{ top: handleColumnTop }}
                  className={`fixed right-0 z-30 rounded-l-xl border border-r-0 border-slate-200 bg-white/95 p-3 text-slate-500 shadow-md transition-opacity hover:text-slate-800 ${
                    showModPanel ? "pointer-events-none opacity-0" : "opacity-100"
                  }`}
                >
                  <Pencil className="h-5 w-5" />
                </button>
                {/* Slide-out moderation drawer. */}
                <div
                  {...{ [WC_DRAWER_ATTR]: "" }}
                  onClick={blurClickedButton}
                  className={`fixed right-0 top-0 z-40 flex h-full w-80 flex-col border-l border-slate-200 bg-white text-slate-800 transition-transform duration-300 ${
                    showModPanel ? "translate-x-0 shadow-2xl" : "translate-x-full"
                  }`}
                >
                  <div className="flex items-center justify-between border-b border-slate-100 p-3">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={undoMod}
                        title={t("Undo")}
                        aria-label={t("Undo")}
                        className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
                      >
                        <Undo2 className="h-5 w-5" />
                      </button>
                      <button
                        type="button"
                        onClick={redoMod}
                        title={t("Redo")}
                        aria-label={t("Redo")}
                        className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
                      >
                        <Redo2 className="h-5 w-5" />
                      </button>
                    </div>
                    <span className="text-sm font-semibold text-slate-600">{t("Moderate")}</span>
                    <button
                      type="button"
                      onClick={() => setShowModPanel(false)}
                      aria-label={t("Close")}
                      className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3">
                    {mod ? (
                      <ModerationPanel
                        mod={mod}
                        onRestore={(key) =>
                          moderate({ op: "unhide", keys: [key] }, { op: "hide", keys: [key] })
                        }
                        onSplit={(keys) =>
                          moderate(
                            { op: "unmerge", keys },
                            { op: "merge", keys, label: mergeLabel(keys) ?? "" },
                          )
                        }
                        onRename={(keys, label) =>
                          moderate(
                            { op: "rename", keys, label },
                            { op: "rename", keys, label: mergeLabel(keys) ?? "" },
                          )
                        }
                      />
                    ) : (
                      <p className="text-sm text-slate-400">{t("Nothing moderated yet.")}</p>
                    )}
                  </div>
                </div>
              </>
            )}

          {/* Mindmap moderation refusals (e.g. undo no longer possible). */}
          {mmToast && (mmShown || mxShown) && (
            <div
              key={mmToast.n}
              role="status"
              className="ab-fade-in fixed bottom-24 left-1/2 z-50 flex max-w-lg -translate-x-1/2 items-start gap-2 rounded-xl bg-slate-800 px-4 py-2.5 text-sm text-white shadow-lg"
            >
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p className="flex-1">{mmToast.text}</p>
              {mmToast.action && (
                <button
                  type="button"
                  onClick={() => {
                    mmToast.action?.run();
                    setMmToast(null);
                  }}
                  className="shrink-0 rounded font-semibold text-brand-200 underline-offset-2 hover:text-white hover:underline"
                >
                  {mmToast.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => setMmToast(null)}
                aria-label={t("Dismiss")}
                className="rounded p-0.5 text-slate-300 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {showMmHandle && (
            <>
              <button
                type="button"
                {...{ [WC_DRAWER_ATTR]: "" }}
                onClick={(e) => {
                  e.currentTarget.blur();
                  if (mmAi.open) mmAi.close();
                  setShowModPanel((s) => !s);
                }}
                aria-label={t("Moderate")}
                title={t("Moderate")}
                data-help="handle.mm-moderate"
                data-beamer-inset=""
                  style={{ top: handleColumnTop }}
                  className={`fixed right-0 z-30 rounded-l-xl border border-r-0 border-slate-200 bg-white/95 p-3 text-slate-500 shadow-md transition-opacity hover:text-slate-800 ${
                  showModPanel ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
              >
                <Pencil className="h-5 w-5" />
              </button>
              <div
                {...{ [WC_DRAWER_ATTR]: "" }}
                data-testid="mm-mod-drawer"
                onClick={blurClickedButton}
                className={`fixed right-0 top-0 z-40 flex h-full w-80 flex-col border-l border-slate-200 bg-white text-slate-800 transition-transform duration-300 ${
                  showModPanel ? "translate-x-0 shadow-2xl" : "translate-x-full"
                }`}
              >
                <div className="flex items-center justify-between border-b border-slate-100 p-3">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => mmMod.undo(mmRate)}
                      disabled={!mmMod.canUndo}
                      title={t("Undo")}
                      aria-label={t("Undo")}
                      className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-30"
                    >
                      <Undo2 className="h-5 w-5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => mmMod.redo(mmRate)}
                      disabled={!mmMod.canRedo}
                      title={t("Redo")}
                      aria-label={t("Redo")}
                      className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-30"
                    >
                      <Redo2 className="h-5 w-5" />
                    </button>
                  </div>
                  <span className="text-sm font-semibold text-slate-600">{t("Moderate")}</span>
                  <button
                    type="button"
                    id="mm-mod-close"
                    onClick={() => setShowModPanel(false)}
                    aria-label={t("Close")}
                    className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-3">
                  <MindmapModerationList
                    hidden={mmHidden}
                    log={mindmap?.moderation_log ?? []}
                    rating={!!mmRate}
                    onShow={(id) => hideMindmapNode(id, false)}
                    onReset={mmMod.resetLog}
                    fallbackFocusId="mm-mod-close"
                  />
                </div>
              </div>
            </>
          )}

          {showMmAi && (
            <>
              <button
                type="button"
                {...{ [WC_DRAWER_ATTR]: "" }}
                onClick={(e) => {
                  e.currentTarget.blur();
                  setShowModPanel(false);
                  if (mmAi.open) mmAi.close();
                  else mmAi.setOpen(true);
                }}
                aria-label={t("AI mind map")}
                title={t("AI mind map")}
                data-help="handle.mm-ai"
                style={{ top: mmAiTop }}
                data-beamer-inset=""
                className={`fixed right-0 z-30 rounded-l-xl border border-r-0 border-slate-200 bg-white/95 p-3 text-slate-500 shadow-md transition-opacity hover:text-slate-800 ${
                  mmAi.open ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
              >
                <Sparkles className="h-5 w-5" />
              </button>
              <MindmapAiDrawer ai={mmAi} drawerAttr={WC_DRAWER_ATTR} onClick={blurClickedButton} />
            </>
          )}

          {showAiButton && (
            <>
              {!aiHintSeen && modHintSeen && !showAiPanel && !showModPanel && (
                <div style={{ top: aiHandleTop }} className="fixed right-16 z-30 flex max-w-[18rem] items-start gap-2 rounded-xl border border-brand-200 bg-brand-50/95 p-3 text-sm text-slate-700 shadow-sm">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" aria-hidden />
                  <p className="flex-1">
                    {t("Tip: the star switches the AI views on and lets you adjust the grouping on the spot.")}
                  </p>
                  <button
                    type="button"
                    onClick={dismissAiHint}
                    aria-label={t("Dismiss")}
                    className="rounded p-0.5 text-slate-500 hover:bg-brand-100"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
              {/* AI handle directly below the moderation pencil. */}
              <button
                type="button"
                {...{ [WC_DRAWER_ATTR]: "" }}
                onClick={(e) => {
                  e.currentTarget.blur();
                  toggleAiPanel();
                }}
                aria-label={aiPanelTitle}
                title={aiPanelTitle}
                data-help="handle.ai"
                style={{ top: aiHandleTop }}
                data-beamer-inset=""
                className={`fixed right-0 z-30 rounded-l-xl border border-r-0 border-slate-200 bg-white/95 p-3 text-slate-500 shadow-md transition-opacity hover:text-slate-800 ${
                  showAiPanel ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
              >
                <Sparkles className="h-5 w-5" />
              </button>
              {/* Slide-out AI drawer (mutually exclusive with moderation). */}
              <div
                {...{ [WC_DRAWER_ATTR]: "" }}
                onClick={blurClickedButton}
                className={`fixed right-0 top-0 z-40 flex h-full w-80 flex-col border-l border-slate-200 bg-white text-slate-800 transition-transform duration-300 ${
                  showAiPanel ? "translate-x-0 shadow-2xl" : "translate-x-full"
                }`}
              >
                <div className="flex items-center justify-between border-b border-slate-100 p-3">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600">
                    <Sparkles className="h-4 w-4" aria-hidden />
                    {aiPanelTitle}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowAiPanel(false)}
                    aria-label={t("Close")}
                    className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <div className="flex-1 space-y-5 overflow-y-auto p-3">
                  {!whoAi.easy && (
                    <div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={aiCloud}
                        disabled={aiBusy !== null}
                        onClick={() => void setQuestionAi(!aiCloud)}
                        className="inline-flex items-center gap-2.5 rounded text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span
                          aria-hidden
                          className={`relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors ${
                            aiCloud ? "bg-brand-600" : "bg-slate-300"
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                              aiCloud ? "translate-x-[1.125rem]" : "translate-x-0.5"
                            }`}
                          />
                        </span>
                        <span className="text-left">
                          {isOpenText ? t("Use AI summary") : t("Use AI for this word cloud")}
                        </span>
                      </button>
                      <p className="mt-1 pl-[2.875rem] text-xs text-slate-400">{t("Saved on the question.")}</p>
                    </div>
                  )}
                  {/* Settings only — which view is on the beamer is chosen in the
                      footer's view switcher. Each block applies to its view
                      (and shows it). */}
                  {aiCloud && (
                    <>
                      {isOpenText && (
                        <div>
                          <p className="mb-1 text-sm font-medium text-slate-700">{t("Key statements")}</p>
                          <label className="flex items-start gap-2 text-sm text-slate-700">
                            <input
                              type="checkbox"
                              checked={mergeDraft.concepts}
                              disabled={aiBusy !== null}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setMergeDraft((d) => ({ ...d, concepts: checked }));
                              }}
                              className="mt-0.5 h-4 w-4 flex-none rounded border-slate-300 accent-brand-600"
                            />
                            {t("Also merge similar statements")}
                          </label>
                          <button
                            type="button"
                            onClick={() => void mergeAgain()}
                            disabled={aiBusy !== null}
                            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                          >
                            {aiBusy === "merge" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                            {t("Summarize again")}
                          </button>
                        </div>
                      )}
                      {!isOpenText && (
                        <fieldset>
                          <legend className="mb-1 block text-sm font-medium text-slate-700">
                            {t("“Cleaned up” merges:")}
                          </legend>
                          <div className="grid gap-1.5">
                            {(
                              [
                                ["variants", t("Spelling variants and typos (e.g. müde / muede / mühde)")],
                                ["synonyms", t("Synonyms and word forms (e.g. einsam / Einsamkeit)")],
                                ["concepts", t("Similar concepts (e.g. Gebäude / Haus / Wohnung)")],
                              ] as const
                            ).map(([key, label]) => (
                              <label key={key} className="flex items-start gap-2 text-sm text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={mergeDraft[key]}
                                  disabled={aiBusy !== null}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    setMergeDraft((d) => ({ ...d, [key]: checked }));
                                  }}
                                  className="mt-0.5 h-4 w-4 flex-none rounded border-slate-300 accent-brand-600"
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                          <button
                            type="button"
                            onClick={() => void mergeAgain()}
                            disabled={aiBusy !== null}
                            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                          >
                            {aiBusy === "merge" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                            {t("Merge again")}
                          </button>
                        </fieldset>
                      )}
                      <div>
                        <label htmlFor="wc-grouping" className="mb-1 block text-sm font-medium text-slate-700">
                          {t("Grouping instruction")}
                        </label>
                        <textarea
                          id="wc-grouping"
                          rows={4}
                          maxLength={1000}
                          value={groupingDraft}
                          onChange={(e) => setGroupingDraft(e.target.value)}
                          placeholder={t(
                            "Empty = AI finds themes itself. E.g. “positive / neutral / negative” or “by lecture topic”.",
                          )}
                          className="w-full rounded-lg border border-field bg-white p-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                        />
                        {isOpenText && modelSolution && (
                          <div className="mt-2">
                            <label className="flex items-start gap-2 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                checked={useSolutionDraft}
                                disabled={aiBusy !== null}
                                onChange={(e) => setUseSolutionDraft(e.target.checked)}
                                className="mt-0.5 h-4 w-4 flex-none rounded border-slate-300 accent-brand-600"
                              />
                              {t("Consider the model solution when grouping")}
                            </label>
                            <button
                              type="button"
                              aria-expanded={solutionOpen}
                              aria-controls="wc-model-solution"
                              onClick={() => setSolutionOpen((o) => !o)}
                              className="mt-1.5 inline-flex items-center gap-1 rounded text-xs font-medium text-slate-500 hover:text-slate-800"
                            >
                              {solutionOpen ? (
                                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                              )}
                              {t("Show model solution")}
                            </button>
                            {solutionOpen && (
                              <p
                                id="wc-model-solution"
                                className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-sm text-slate-700"
                              >
                                {modelSolution}
                              </p>
                            )}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => void regroup()}
                          disabled={aiBusy !== null}
                          className="mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                        >
                          {aiBusy === "regroup" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                          {t("Regroup")}
                        </button>
                      </div>
                    </>
                  )}
                  {aiError && <p className="text-sm text-red-600">{aiError}</p>}
                </div>
              </div>
            </>
          )}

          <div className="mt-10 text-center text-slate-500">
            {phase === "preview" && (
              <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-4 py-1.5 text-lg font-semibold text-amber-800">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                {t("Vote not started yet")}
              </span>
            )}
            {/* A closed rating has its own "Rating closed" line above the map. */}
            {phase === "closed" && !mmShown && !mxShown && (
              <p className="text-xl">{t("Voting closed")}</p>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}

/** Post-run results walkthrough (#75, Quiz-Block): the aggregated-result body
 * for one `RunResults` question, mirroring the live `phase === "results"`
 * rendering above kind-for-kind but fed from stored results instead of
 * `state`, and with correct answers always revealed (no reveal-level gate —
 * self-paced has no live audience to hide them from once the quiz is over). */
function WalkthroughResultBody({
  item,
  view = "raw",
  ai,
  onRetryAi,
}: {
  item: RunResults["questions"][number];
  /** Free-text view (the other kinds have only one). */
  view?: WcView;
  /** One-shot AI summary for the key-statement/grouped views (undefined =
   *  loading, "error" = failed). */
  ai?: WordCloudAI | "error";
  onRetryAi?: () => void;
}) {
  const { t } = useTranslation();
  const total = item.votes ?? 0;

  if (item.kind === "likert" && item.likert) {
    return <LikertResult summary={item.likert} variant="present" animate />;
  }

  if (item.kind === "priorities" && item.priorities) {
    return (
      <div className="mt-8 space-y-4">
        {item.priorities.map((opt, i) => (
          <PriorityBar key={opt.id} index={i} label={<MathText text={localizedText(opt.text)} />} avg={opt.avg} min={opt.min} max={opt.max} animate />
        ))}
      </div>
    );
  }

  if (item.kind === "ordering" && item.ordering) {
    return <OrderingResult ordering={item.ordering} animate />;
  }

  if (item.kind === "open_text" && (view === "consolidated" || view === "grouped")) {
    if (ai === "error") {
      return (
        <div className="mt-10 text-center text-slate-500">
          <p className="text-xl">{t("The AI summary is currently unavailable.")}</p>
          {onRetryAi && (
            <button
              type="button"
              onClick={onRetryAi}
              className="mt-4 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              {t("Try again")}
            </button>
          )}
        </div>
      );
    }
    return <FreeTextAiView view={view} ai={ai} />;
  }

  if (item.kind === "open_text" && item.evaluation && view === "results") {
    const evaluation = item.evaluation;
    const evalTotal = evaluation.groups.reduce((s, g) => s + g.count, 0);
    return (
      <div className="mt-8">
        {evaluation.pending > 0 && (
          <p className="mb-4 text-lg text-slate-500">
            {evaluation.pending} {t("answer being evaluated", { count: evaluation.pending })}
          </p>
        )}
        <div className="mx-auto mb-6 max-w-3xl space-y-3">
          {evaluation.groups.map((group, i) => {
            const pct = evalTotal ? Math.round((group.count / evalTotal) * 100) : 0;
            return (
              <ResultBar
                key={group.verdict}
                index={i}
                letter={null}
                label={evalLabel(group.verdict)}
                count={group.count}
                pct={pct}
                color={evalColor(i)}
                animate
              />
            );
          })}
        </div>
      </div>
    );
  }

  if (item.kind === "open_text") {
    return <AnswerChips words={item.words ?? []} />;
  }

  if (item.kind === "word_cloud") {
    return (item.words ?? []).length === 0 ? (
      <p className="mt-8 text-center text-slate-400">{t("No terms yet …")}</p>
    ) : (
      <WordCloud words={rampWords(item.words ?? [])} />
    );
  }

  // single_choice / multiple_choice (and any kind without its own aggregate
  // above, mirroring the live fallback): a bar per option, correct always
  // marked since the walkthrough has no audience left to hide it from.
  return (
    <div className="mt-8 space-y-4">
      {(item.options ?? []).map((option, i) => {
        const count = option.count ?? 0;
        const percent = total ? Math.round((count / total) * 100) : 0;
        const hasCorrect = (item.options ?? []).some((o) => o.is_correct);
        const barState: BarState = hasCorrect ? (option.is_correct ? "correct" : "wrong") : "neutral";
        return (
          <ResultBar
            key={option.id}
            index={i}
            label={<MathText text={localizedText(option.text)} />}
            image={option.image}
            count={count}
            pct={percent}
            state={barState}
            animate
          />
        );
      })}
    </div>
  );
}

/** Right-edge handle column (moderation pencil, AI sparkles, mindmap zoom):
 * slot geometry and where the column starts. It prefers 62 % of the height
 * but keeps clear of what sits at the right edge — the logo, a join QR box
 * configured top-right/bottom-right (both marked `data-edge-right`) — and of
 * the footer. Re-measured on resize and periodically (the boxes load
 * images). */
const HANDLE_SIZE = 46;
const HANDLE_STEP = 56;
function useHandleColumn(slots: number): number {
  const [top, setTop] = useState(() =>
    typeof window === "undefined" ? 400 : Math.round(window.innerHeight * 0.62),
  );
  useEffect(() => {
    const measure = () => {
      const vh = window.innerHeight;
      let lo = 16;
      let hi = vh - 16;
      const footer = document.querySelector("footer");
      if (footer) hi = Math.min(hi, footer.getBoundingClientRect().top - 12);
      document.querySelectorAll<HTMLElement>("[data-edge-right]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.top + r.height / 2 < vh / 2) lo = Math.max(lo, r.bottom + 12);
        else hi = Math.min(hi, r.top - 12);
      });
      const height = Math.max(1, slots) * HANDLE_STEP - (HANDLE_STEP - HANDLE_SIZE);
      // Not enough room: top-aligned below the upper obstacle.
      setTop(Math.round(Math.max(lo, Math.min(vh * 0.62, hi - height))));
    };
    measure();
    window.addEventListener("resize", measure);
    const id = window.setInterval(measure, 1000);
    return () => {
      window.removeEventListener("resize", measure);
      window.clearInterval(id);
    };
  }, [slots]);
  return top;
}

/** Right edge of the QR boxes stacked top-left (`data-top-left`), in px
 * from the viewport's left; 0 when there are none. The full-width mind map
 * keeps its title/hint clear of them symmetrically (so it stays centred). */
function useTopLeftExtent(active: boolean): number {
  const [right, setRight] = useState(0);
  useEffect(() => {
    if (!active) {
      setRight(0);
      return;
    }
    const measure = () => {
      let max = 0;
      document.querySelectorAll<HTMLElement>("[data-top-left]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0) max = Math.max(max, r.right);
      });
      setRight(Math.round(max));
    };
    measure();
    window.addEventListener("resize", measure);
    const id = window.setInterval(measure, 1000);
    return () => {
      window.removeEventListener("resize", measure);
      window.clearInterval(id);
    };
  }, [active]);
  return right;
}

/** Content of a section interstitial ("Zwischenfolie"), resolved to the
 *  content language: plain title + optional sanitized rich description. */
interface SectionSlide {
  title: string;
  description: string;
}

function sectionSlide(info: Map<number, SectionSlide>, id: number): SectionSlide {
  return info.get(id) ?? { title: "", description: "" };
}

/** The interstitial slide: section title, with the optional rich
 *  description below it. A long description is scaled down (never up) to
 *  fit the beamer instead of scrolling. */
function SectionInterstitial({ title, description }: SectionSlide) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const hasDescription = stripHtml(description).trim() !== "" || /<img/i.test(description);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = innerRef.current;
    if (!box || !inner) return;
    const measure = () => {
      const h = inner.offsetHeight; // unaffected by the transform
      const avail = box.clientHeight;
      const next = h > 0 && avail > 0 ? Math.max(0.35, Math.min(1, avail / h)) : 1;
      setScale((s) => (Math.abs(s - next) < 0.01 ? s : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    ro.observe(box);
    return () => ro.disconnect();
  }, [title, description]);
  return (
    <div
      ref={boxRef}
      data-testid="section-interstitial"
      className="ab-fade-in flex h-full min-h-0 items-center justify-center overflow-hidden pb-12 text-center"
    >
      <div
        ref={innerRef}
        className="max-w-5xl shrink-0"
        style={scale < 1 ? { transform: `scale(${scale})`, transformOrigin: "center" } : undefined}
      >
        <h1 className="mx-auto max-w-4xl text-6xl font-extrabold leading-tight">{title}</h1>
        {hasDescription && (
          <RichText
            className="section-description mx-auto mt-8 max-w-4xl text-2xl leading-relaxed text-slate-700 md:text-3xl [&_a]:text-brand-700 [&_a]:underline [&_img]:mx-auto [&_img]:my-4 [&_img]:max-h-80 [&_ol]:list-decimal [&_ol]:pl-8 [&_ol]:text-left [&_ul]:list-disc [&_ul]:pl-8 [&_ul]:text-left [&_p]:my-2"
            html={mathHtml(description)}
          />
        )}
      </div>
    </div>
  );
}

function Shell({
  children,
  footer,
  logo,
  overlay,
  stats,
  reserveTopLeft = 0,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
  logo?: string | null;
  overlay?: React.ReactNode;
  stats?: React.ReactNode;
  /** Number of QR boxes stacked in the top-left corner (join and/or
   *  recording, see `topLeftBoxes`). The content keeps clear of them: a left
   *  column from lg up, top padding below. */
  reserveTopLeft?: 0 | 1 | 2;
}) {
  return (
    <div className="relative flex h-screen flex-col bg-white font-sans text-slate-900">
      {logo && (
        <img
          src={logo}
          alt=""
          aria-hidden
          data-edge-right=""
          data-beamer-inset=""
          className="absolute right-6 top-5 z-10 h-10 w-auto max-w-[200px] object-contain"
        />
      )}
      <main
        className={`min-h-0 flex-1 overflow-auto px-8 py-6 ${
          reserveTopLeft === 2
            ? "pt-[19rem] lg:pl-[21rem] lg:pt-6"
            : reserveTopLeft === 1
              ? "pt-40 lg:pl-[21rem] lg:pt-6"
              : ""
        }`}
      >
        {children}
      </main>
      {overlay}
      {stats}
      {footer}
    </div>
  );
}

/** Permanent, phase-independent counter fixed to the lower-left corner of the
 * beamer view (#35): a progress pill with the connected clients, the
 * participants who have answered and — for item-based kinds — items against
 * the capacity (`state.counter`, absent without an active question). Sits
 * just above the footer action bar so the two never overlap. */
function LiveStats({ state, raters }: { state: LiveState; raters?: number }) {
  const { t } = useTranslation();
  const progress: LiveCounter =
    state.counter ?? { answered: state.votes ?? 0, items: null, per_person: null, unit: "answers" };
  const rating = progress.unit === "points" || progress.unit === "ratings" || raters != null;
  return (
    <ProgressPill
      className="fixed left-6 bottom-20 z-20"
      participants={state.participants ?? 0}
      progress={rating && raters != null ? { ...progress, answered: raters } : progress}
      answeredLabel={rating ? t("Participants who have rated") : undefined}
    />
  );
}

const CORNER_POSITION: Record<string, string> = {
  "top-left": "left-6 top-5",
  "top-right": "right-6 top-5",
  "bottom-left": "left-6 bottom-20",
  "bottom-right": "right-6 bottom-20",
};

/** Persistent join hint on the beamer so latecomers can still scan in (#6).
 * Corner is room-configurable; renders nothing unless a feature is enabled. */
/** Recording mode (#53): the per-question deep-link QR on the beamer, so the
 * code is captured in the recording and later viewers can vote on it. */
/** The join badge is configured for the top-left corner (where the recording
 *  QR and the countdown also live). */
function joinInTopLeft(room: LiveState["room"]): boolean {
  return !!(room.show_qr || room.show_code) && (room.corner ?? "bottom-right") === "top-left";
}

/** How many QR boxes stack in the top-left corner of the beamer (0–2). */
function topLeftBoxes(room: LiveState["room"], recording: boolean): 0 | 1 | 2 {
  return ((joinInTopLeft(room) ? 1 : 0) + (recording ? 1 : 0)) as 0 | 1 | 2;
}

function RecordingCorner({
  room,
  token,
  questionId,
}: {
  room: LiveState["room"];
  token: string;
  questionId: number;
}) {
  const { t } = useTranslation();
  // Top-left; drop below the join corner if that also sits top-left so the two
  // QR boxes never overlap. Logo is top-right, LiveStats bottom-left.
  const position = joinInTopLeft(room) ? "left-6 top-40" : "left-6 top-5";
  return (
    <div
      data-beamer-inset=""
      data-top-left=""
      className={`absolute z-20 flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm backdrop-blur ${position}`}
    >
      <img
        src={live.recordingQrUrl(token, questionId)}
        alt={t("QR code to vote on this question from the recording")}
        className="h-24 w-24 rounded-lg"
      />
      <p className="max-w-[10rem] text-left text-xs text-slate-500">
        {t("Watching the recording? Scan to vote on this question afterward.")}
      </p>
    </div>
  );
}

function JoinCorner({ room }: { room: LiveState["room"] }) {
  const { t } = useTranslation();
  if (!room.show_qr && !room.show_code) return null;
  const url = live.participantUrl(room.code);
  const rawCorner = room.corner ?? "bottom-right";
  // The live counter (LiveStats) is pinned bottom-left; when the join badge is
  // configured for that same corner they used the identical position and the
  // counter covered the QR (#79). Lift the badge above the counter there.
  const position =
    rawCorner === "bottom-left" ? "left-6 bottom-36" : CORNER_POSITION[rawCorner];
  return (
    // Hidden on small windows (the counter/footer leave no room and the QR is
    // still reachable via the footer QR button + room code); shown from md up.
    <div
      data-beamer-inset=""
      {...(rawCorner.endsWith("right") ? { "data-edge-right": "" } : {})}
      {...(rawCorner === "top-left" ? { "data-top-left": "" } : {})}
      className={`absolute z-20 hidden items-center gap-3 rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm backdrop-blur md:flex ${position}`}
    >
      {room.show_qr && (
        <img
          src={live.qrUrl(room.code)}
          alt={t("QR code for {{url}}", { url })}
          className="h-24 w-24 rounded-lg"
        />
      )}
      {room.show_code && (
        <div className="pr-1 text-left">
          <p className="text-xs text-slate-500">
            {url.replace(/^https?:\/\//, "")}
          </p>
          <p className="text-2xl font-extrabold tracking-widest text-brand-700">
            {room.code}
          </p>
        </div>
      )}
    </div>
  );
}

/** On-demand join panel (#): a large, scannable QR plus the room name, join
 *  URL and code. Docked to the right so the question/vote stay fully visible;
 *  it only displays, never changes the vote phase. Closed via its X, the
 *  footer icon, or Esc. */
function JoinPanel({
  room,
  onClose,
}: {
  room: LiveState["room"];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const url = live.participantUrl(room.code);
  return (
    <div className="fixed right-6 top-1/2 z-30 w-72 -translate-y-1/2 rounded-2xl border border-slate-200 bg-white/95 p-5 text-center shadow-xl backdrop-blur">
      <button
        type="button"
        aria-label={t("Close")}
        onClick={onClose}
        className="absolute right-2 top-2 rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
      <p className="mb-3 truncate pr-4 text-lg font-bold text-slate-900">
        {localizedText(room.title)}
      </p>
      <img
        src={live.qrUrl(room.code)}
        alt={t("QR code for {{url}}", { url })}
        className="mx-auto h-56 w-56 rounded-lg"
      />
      <p className="mt-3 break-all text-sm text-slate-600">
        {url.replace(/^https?:\/\//, "")}
      </p>
      <p className="text-3xl font-extrabold tracking-widest text-brand-700">
        {room.code}
      </p>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-md border border-slate-300 bg-slate-50 px-2 py-0.5 font-mono text-sm">
      {children}
    </kbd>
  );
}

// Within-category frequency ramp: t 0..1 (rare..frequent) → lighter/desaturated
// to darker/saturated, so a category's leader reads darkest on the light beamer.
function hueColor(hue: number, t: number): string {
  const warm = isWarm(hue);
  const L = warm ? 0.68 - 0.12 * t : 0.64 - 0.24 * t;
  const C = warm ? 0.12 + 0.06 * t : 0.07 + 0.09 * t;
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${hue})`;
}
// Apricot/sand turn brown when darkened, so warm hues stay lighter and get
// more chroma instead (still legible on the white beamer).
function isWarm(hue: number): boolean {
  return hue >= 40 && hue <= 100;
}
// Single cloud (Original / Cleaned up): a calm teal→green frequency ramp —
// rare terms light teal, frequent ones a deeper green. The grouped view uses
// palette hues instead, because there colour tells the groups apart.
function rampColor(t: number): string {
  const L = 0.62 - 0.22 * t;
  const C = 0.07 + 0.09 * t;
  const H = 195 - 45 * t; // teal (195) → brand green (150)
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(0)})`;
}

type CloudWord = { text: string; count: number; color: string; cluster?: number; keys?: string[] };
type PlacedWord = CloudWord & { x: number; y: number; size: number; rank: number };

/** Lay the most frequent word large in the centre and arrange the rest
 * concentrically outward along an Archimedean spiral, biggest first (#31).
 * Box sizes are estimated from text length so no DOM measuring is needed. */
// Lay out the top-40 words in the given order (callers pass stable first-seen
// order, #Wortwolke). Each word spirals out from its (cluster) centroid until
// it clears the words already placed, so growth mostly nudges later words that
// then glide via the CSS transition — no full re-pack, no teleporting.
function layoutWordCloud(
  words: CloudWord[],
  scale = 1,
  size: { w: number; h: number } = { w: 900, h: 520 },
): PlacedWord[] {
  if (words.length === 0) return [];
  const counts = words.map((w) => w.count);
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const sizeOf = (count: number) => {
    if (max === min) return 40 * scale;
    const t = (count - min) / (max - min);
    return (18 + t * t * 62) * scale; // 18–80px, quadratic so the leader pops
  };
  // One centroid per cluster index, spread on an ellipse; single cloud → centre.
  const clusterIds = Array.from(
    new Set(words.map((w) => w.cluster).filter((c): c is number => c != null)),
  ).sort((a, b) => a - b);
  const centroid = (cluster?: number): { cx: number; cy: number } => {
    if (cluster == null || clusterIds.length <= 1) return { cx: 0, cy: 0 };
    const k = clusterIds.indexOf(cluster);
    const theta = (2 * Math.PI * k) / clusterIds.length - Math.PI / 2;
    return { cx: Math.cos(theta) * size.w * 0.26, cy: Math.sin(theta) * size.h * 0.26 };
  };
  const placed: PlacedWord[] = [];
  // Bold glyphs run wider than 0.56 em on average; and the gap between two
  // terms grows with their size, so large words don't touch their neighbours.
  const estWidth = (p: PlacedWord) => p.text.length * p.size * 0.6;
  const overlaps = (x: number, y: number, w: number, h: number, size: number) =>
    placed.some(
      (p) =>
        Math.abs(x - p.x) * 2 < w + estWidth(p) + 14 + 0.3 * (size + p.size) &&
        Math.abs(y - p.y) * 2 < h + p.size * 1.15 + 6 + 0.12 * (size + p.size),
    );
  words.forEach((word, rank) => {
    const wsize = sizeOf(word.count);
    const w = word.text.length * wsize * 0.6;
    const h = wsize * 1.15;
    const { cx, cy } = centroid(word.cluster);
    let angle = 0;
    let x = cx;
    let y = cy;
    let guard = 0;
    // Spiral out from the (cluster) centroid until the box clears the ones
    // already placed.
    while (overlaps(x, y, w, h, wsize) && guard++ < 1500) {
      angle += 0.35;
      const r = 5 * angle;
      x = cx + r * Math.cos(angle);
      y = cy + r * Math.sin(angle) * 0.62; // squash vertically → a wider cloud
    }
    placed.push({ ...word, x, y, size: wsize, rank });
  });
  return placed;
}

function rampWords(words: { text: string; count: number; keys?: string[] }[]): CloudWord[] {
  if (words.length === 0) return [];
  const max = Math.max(...words.map((w) => w.count));
  const min = Math.min(...words.map((w) => w.count));
  const t = (c: number) => (max === min ? 1 : (c - min) / (max - min));
  return words.map((w) => ({
    text: w.text, count: w.count, color: rampColor(t(w.count)), keys: w.keys,
  }));
}

const wordId = (w: { text: string; keys?: string[] }) =>
  w.keys?.length ? w.keys.join("|") : w.text;

function WordCloud({
  words,
  scale = 1,
  heightClass = "h-[62vh]",
  animate: animateProp = false,
  onModerate,
}: {
  words: CloudWord[];
  scale?: number;
  heightClass?: string;
  animate?: boolean;
  // Presenter curation (#Wortwolke): hide a term, or merge one word onto another.
  onModerate?: (op: "hide" | "merge", keys: string[], label?: string) => void;
}) {
  // Stable first-seen order (new terms appended). Laying out in this order —
  // rather than re-sorting by count every update — keeps a word roughly where
  // it was as its votes change: a growing word mostly nudges the words placed
  // after it, which glide via the CSS transition instead of the whole cloud
  // re-packing and teleporting (#Wortwolke). New terms sort last → outer ring.
  const reduced = useReducedMotion();
  const animate = animateProp && !reduced;
  const orderRef = useRef<Map<string, number>>(new Map());
  const seqRef = useRef(0);

  const { t } = useTranslation();
  // While a merge drag is in progress the layout holds still (frozen snapshot)
  // so the drop target doesn't wander as votes keep arriving.
  const [dragging, setDragging] = useState(false);
  const frozen = useRef<PlacedWord[] | null>(null);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ keys: string[]; id: string; moved: boolean } | null>(null);
  // The word being dragged, rendered as a ghost that follows the cursor.
  const [ghost, setGhost] = useState<
    { id: string; text: string; color: string; size: number; x: number; y: number } | null
  >(null);

  const placed = useMemo(() => {
    if (dragging && frozen.current) return frozen.current;
    const top = [...words].sort((a, b) => b.count - a.count).slice(0, 40);
    for (const w of top) {
      if (!orderRef.current.has(wordId(w))) orderRef.current.set(wordId(w), seqRef.current++);
    }
    top.sort((a, b) => orderRef.current.get(wordId(a))! - orderRef.current.get(wordId(b))!);
    const laid = layoutWordCloud(top, scale);
    frozen.current = laid;
    return laid;
  }, [words, scale, dragging]);

  // Press-drag a word onto another to merge (pointer-based, no lib). Document
  // listeners keep the drag tracking off the small target; a drag that barely
  // moves is treated as a click (the × handles hide instead).
  function startDrag(e: React.PointerEvent, w: PlacedWord) {
    if (!onModerate) return;
    dragRef.current = { keys: w.keys ?? [], id: wordId(w), moved: false };
    const sx = e.clientX;
    const sy = e.clientY;
    setDragging(true);
    setGhost({ id: wordId(w), text: w.text, color: w.color, size: w.size, x: sx, y: sy });
    const move = (ev: PointerEvent) => {
      if (dragRef.current && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) {
        dragRef.current.moved = true;
      }
      setGhost((g) => (g ? { ...g, x: ev.clientX, y: ev.clientY } : g));
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      setGhost(null);
      const rect = centerRef.current?.getBoundingClientRect();
      if (!drag || !drag.moved || !rect || !onModerate) return;
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const target = (frozen.current ?? []).find((p) => {
        if (wordId(p) === drag.id || !p.keys?.length) return false;
        const halfW = (p.text.length * p.size * 0.6) / 2 + 6;
        const halfH = (p.size * 1.15) / 2 + 6;
        return Math.abs(px - p.x) < halfW && Math.abs(py - p.y) < halfH;
      });
      if (target) onModerate("merge", [...drag.keys, ...(target.keys ?? [])], target.text);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
  // Only the 40 most frequent terms fit the beamer legibly; flag the rest so a
  // long tail isn't silently dropped (#Wortwolke).
  const hidden = Math.max(0, words.length - placed.length);

  // Diff against the previous render (updated in an effect, so the render body
  // still sees the prior counts): brand-new terms fly in, terms that gained
  // votes grow + glow, everything else holds still.
  const prev = useRef<Map<string, number>>(new Map());
  const isNew = (text: string) => !prev.current.has(text);
  const isGrown = (text: string, count: number) => {
    const before = prev.current.get(text);
    return before !== undefined && count > before;
  };
  useEffect(() => {
    prev.current = new Map(placed.map((w) => [w.text, w.count]));
  });

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className={`relative ${heightClass}`}>
        <style>{`
        @keyframes wc-fly { from { opacity: 0; transform: translate(-50%,-50%) translateX(var(--wc-fly, 640px)); } 55% { opacity: 1; } to { opacity: 1; transform: translate(-50%,-50%) translateX(0); } }
        @keyframes wc-pulse { 0%, 100% { filter: none; } 30% { filter: drop-shadow(0 0 14px currentColor); } }
      `}</style>
      <div className="absolute left-1/2 top-1/2" ref={centerRef}>
        {placed.map((w) => {
          const fresh = animate && isNew(w.text);
          const grew = animate && isGrown(w.text, w.count);
          return (
            <span
              key={wordId(w)}
              title={`${w.count}×`}
              onPointerDown={onModerate && w.keys?.length ? (e) => startDrag(e, w) : undefined}
              className={`group absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-bold ${
                onModerate && w.keys?.length ? "cursor-grab hover:z-30" : ""
              }`}
              style={{
                left: `${w.x}px`,
                top: `${w.y}px`,
                fontSize: `${w.size}px`,
                color: w.color,
                opacity: ghost?.id === wordId(w) ? 0.2 : undefined,
                userSelect: "none",
                WebkitUserSelect: "none",
                touchAction: onModerate && w.keys?.length ? "none" : undefined,
                // Fly in from whichever side the word ends up on.
                ["--wc-fly" as string]: `${w.x < 0 ? -640 : 640}px`,
                transition: animate
                  ? "left 500ms ease-out, top 500ms ease-out, font-size 700ms ease-out"
                  : undefined,
                animation: fresh
                  ? "wc-fly 600ms cubic-bezier(.2,.85,.25,1), wc-pulse 1100ms ease-out"
                  : grew
                    ? "wc-pulse 1100ms ease-out"
                    : undefined,
              }}
            >
              {w.text}
              {onModerate && !!w.keys?.length && (
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onModerate("hide", w.keys ?? []);
                  }}
                  // Right-centre, over the word's own glyphs on the horizontal
                  // midline the mouse travels — reachable without crossing a gap
                  // or a neighbouring word (the hovered word is raised via z-30).
                  className="absolute right-0 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow-sm hover:bg-slate-100 hover:text-slate-800 group-hover:flex"
                  aria-label={t("Hide {{word}}", { word: w.text })}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              )}
            </span>
          );
        })}
        </div>
      </div>
      {ghost && (
        <span
          className="pointer-events-none fixed z-50 whitespace-nowrap font-bold"
          style={{
            left: ghost.x,
            top: ghost.y,
            transform: "translate(-50%, -50%) scale(1.05)",
            fontSize: `${ghost.size}px`,
            color: ghost.color,
            filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.28))",
          }}
        >
          {ghost.text}
        </span>
      )}
      {hidden > 0 && (
        <div className="mt-8 text-center text-sm text-slate-400">
          {t("+{{count}} more terms", { count: hidden })}
        </div>
      )}
    </div>
  );
}

function ModerationPanel({
  mod,
  onRestore,
  onSplit,
  onRename,
}: {
  mod: WordCloudModeration;
  onRestore: (key: string) => void;
  onSplit: (keys: string[]) => void;
  onRename: (keys: string[], label: string) => void;
}) {
  const { t } = useTranslation();
  const empty = mod.hidden.length === 0 && mod.merges.length === 0;
  return (
    <div className="text-left text-sm">
      {empty && <p className="text-slate-400">{t("Nothing moderated yet.")}</p>}
      {mod.hidden.length > 0 && (
        <>
          <h3 className="mb-1 font-semibold text-slate-600">{t("Hidden")}</h3>
          {mod.hidden.map((h) => (
            <div key={h.key} className="flex items-center justify-between py-0.5">
              <span className="truncate">{h.key}</span>
              <button
                type="button"
                className="ml-2 shrink-0 text-brand-700 hover:underline"
                onClick={() => onRestore(h.key)}
                title={t("Show this entry on the beamer again")}
                aria-label={t("Show again: {{word}}", { word: h.key })}
              >
                {t("Show again")}
              </button>
            </div>
          ))}
        </>
      )}
      {mod.merges.length > 0 && (
        <>
          <h3 className="mb-1 mt-2 font-semibold text-slate-600">{t("Merged")}</h3>
          {mod.merges.map((m) => (
            <div key={m.keys.join("+")} className="py-1">
              <div className="flex items-center gap-2">
                <input
                  key={m.label}
                  defaultValue={m.label}
                  title={t("Rename this merge (shown on the beamer)")}
                  aria-label={t("Rename this merge (shown on the beamer)")}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value !== m.label)
                      onRename(m.keys, e.target.value.trim());
                  }}
                  className="min-w-0 flex-1 rounded border border-field px-2 py-1"
                />
                <button
                  type="button"
                  className="shrink-0 rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
                  onClick={() => onSplit(m.keys)}
                  title={t("Undo this merge — show the terms separately again")}
                  aria-label={t("Undo this merge — show the terms separately again")}
                >
                  <Unlink className="h-5 w-5" aria-hidden />
                </button>
              </div>
              <p className="mt-0.5 truncate text-xs text-slate-400">{m.keys.join(", ")}</p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function AiWait() {
  const { t } = useTranslation();
  return (
    <div className="mt-10 text-center text-slate-500">
      <p className="text-2xl">{t("Evaluating answers …")}</p>
      <p className="mt-2 text-slate-400">{t("The AI is summarizing the entries.")}</p>
    </div>
  );
}

/** Optimistic client-side moderation of an AI result that is still being
 * recomputed: drop fully hidden words, fold words of a manual merge group into
 * one (label, summed count, union of keys). Idempotent once the fresh AI
 * result already reflects the moderation. */
function applyModToAi(words: AiWord[], mod?: WordCloudModeration): AiWord[] {
  if (!mod) return words;
  const hidden = new Set(mod.hidden.map((h) => h.key));
  let out = words.filter((w) => !w.keys?.length || !w.keys.every((k) => hidden.has(k)));
  for (const m of mod.merges) {
    const group = new Set(m.keys);
    const hit = out.filter((w) => w.keys?.some((k) => group.has(k)));
    if (hit.length === 0) continue;
    if (hit.length === 1 && hit[0].keys!.every((k) => group.has(k)) && hit[0].text === m.label)
      continue;
    const merged: AiWord = {
      text: m.label,
      count: hit.reduce((a, w) => a + w.count, 0),
      keys: [...new Set(hit.flatMap((w) => w.keys ?? []))],
    };
    const first = out.indexOf(hit[0]);
    out = out.filter((w) => !hit.includes(w));
    out.splice(Math.min(first, out.length), 0, merged);
  }
  return out;
}

/** The consolidated (single cloud) or grouped (many clouds) AI view, with a
 * wait state while the first LLM pass is still running (#Wortwolke-KI). */
function WordCloudAiView({
  view,
  ai: aiRaw,
  mod,
  onModerate,
}: {
  view: "consolidated" | "grouped";
  ai?: WordCloudAI;
  mod?: WordCloudModeration;
  onModerate?: (op: "hide" | "merge", keys: string[], label?: string) => void;
}) {
  const { t } = useTranslation();
  const ai = useMemo(
    () =>
      aiRaw && {
        ...aiRaw,
        merged: applyModToAi(aiRaw.merged, mod),
        clusters: aiRaw.clusters.map((c) => ({ ...c, words: applyModToAi(c.words, mod) })),
      },
    [aiRaw, mod],
  );
  if (!ai || ai.pending) return <AiWait />;
  if (view === "consolidated") {
    if (ai.merged.length === 0) {
      return <p className="mt-8 text-center text-slate-400">{t("No terms yet …")}</p>;
    }
    return <WordCloud words={rampWords(ai.merged)} animate onModerate={onModerate} />;
  }
  if (ai.clusters.length === 0) {
    return <p className="mt-8 text-center text-slate-400">{t("No terms yet …")}</p>;
  }
  return <GroupedWordClouds clusters={ai.clusters} onModerate={onModerate} />;
}

type ModerateFn = (op: "hide" | "merge", keys: string[], label?: string) => void;
type ChipItem = { text: string; count: number; keys?: string[] };
/** Marks a draggable free-text chip/statement with its `wordId` (drop lookup). */
const CHIP_ATTR = "data-chip-id";

/** Pointer-based drag-to-merge for free-text chips and statements (like
 * WordCloud's `startDrag`, no lib): press a chip, drop it onto another to
 * merge them under the target's text. While dragging, `shown` is a frozen
 * snapshot of `data` so the drop target doesn't move as votes arrive; a drag
 * that barely moves counts as a click (the × handles hide instead). */
function useChipDrag<D>(
  data: D,
  find: (d: D, id: string) => ChipItem | undefined,
  onModerate?: ModerateFn,
) {
  const [drag, setDrag] = useState<{ id: string; text: string; x: number; y: number } | null>(null);
  const frozen = useRef<D | null>(null);
  const shown = drag && frozen.current != null ? frozen.current : data;
  const startDrag = (e: React.PointerEvent, item: ChipItem) => {
    if (!onModerate || !item.keys?.length || e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    const id = wordId(item);
    const keys = item.keys;
    const snapshot = data;
    frozen.current = snapshot;
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    setDrag({ id, text: item.text, x: sx, y: sy });
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 6) moved = true;
      setDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY } : d));
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      setDrag(null);
      frozen.current = null;
      if (!moved) return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(`[${CHIP_ATTR}]`);
      const targetId = el?.getAttribute(CHIP_ATTR);
      if (!targetId || targetId === id) return;
      const target = find(snapshot, targetId);
      if (!target?.keys?.length) return;
      onModerate("merge", [...keys, ...target.keys], target.text);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };
  // Props for a chip element: drag source + drop target marker.
  const chipProps = (item: ChipItem) => {
    const can = !!onModerate && !!item.keys?.length;
    return {
      [CHIP_ATTR]: wordId(item),
      onPointerDown: can ? (e: React.PointerEvent) => startDrag(e, item) : undefined,
      style: {
        opacity: drag?.id === wordId(item) ? 0.3 : undefined,
        touchAction: can ? ("none" as const) : undefined,
        userSelect: "none" as const,
        WebkitUserSelect: "none" as const,
      },
      className: can ? "cursor-grab" : "",
    };
  };
  return { shown, drag, chipProps };
}

/** The chip being dragged, following the cursor. */
function ChipGhost({ drag }: { drag: { text: string; x: number; y: number } | null }) {
  if (!drag) return null;
  return (
    <span
      className="pointer-events-none fixed z-50 max-w-md truncate rounded-full bg-white px-4 py-2 text-xl font-semibold shadow-xl ring-1 ring-slate-200"
      style={{ left: drag.x, top: drag.y, transform: "translate(-50%, -50%) scale(1.05)", color: INK }}
    >
      {drag.text}
    </span>
  );
}

/** Small × in a chip's corner (hover), hiding the chip's keys. */
function HideButton({ label, onHide }: { label: string; onHide: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onHide();
      }}
      className="absolute -right-1.5 -top-1.5 hidden h-6 w-6 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow-sm hover:bg-slate-100 hover:text-slate-800 group-hover:flex"
      aria-label={t("Hide {{word}}", { word: label })}
    >
      <X className="h-3.5 w-3.5" strokeWidth={2.5} />
    </button>
  );
}

const findChip = (items: ChipItem[], id: string) => items.find((w) => wordId(w) === id);

/** Free-text "Original" view: the (moderated) answers as chips. With
 * `onModerate` (expert mode) a chip dropped onto another merges both under
 * the target's text, × hides it — same semantics as the word cloud. */
function AnswerChips({ words, onModerate }: { words: ChipItem[]; onModerate?: ModerateFn }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const { shown, drag, chipProps } = useChipDrag(words, findChip, onModerate);
  return (
    <>
      <ul className="mt-6 flex max-h-96 flex-wrap gap-3 overflow-auto p-2">
        {shown.map((entry, i) => {
          const can = !!onModerate && !!entry.keys?.length;
          const cp = chipProps(entry);
          return (
            <li
              key={wordId(entry)}
              {...cp}
              className={`ab-chip-in group relative rounded-full px-4 py-2 text-xl ${cp.className}`}
              style={{
                ...cp.style,
                background: termColor(entry.text),
                color: INK,
                animationDelay: reduced ? undefined : `${Math.min(i, 20) * 80}ms`,
              }}
            >
              {entry.text}
              {entry.count > 1 && <span className="ml-2 text-sm font-normal">×{entry.count}</span>}
              {can && (
                <HideButton label={entry.text} onHide={() => onModerate!("hide", entry.keys ?? [])} />
              )}
            </li>
          );
        })}
        {shown.length === 0 && <p className="text-slate-400">{t("No answers yet …")}</p>}
      </ul>
      <ChipGhost drag={drag} />
    </>
  );
}

/** Optimistic moderation of a free-text AI result (key statements) while it is
 * being recomputed. Unlike `applyModToAi` it never shows a merge's label: a
 * merge made in "Original" is labelled with a verbatim answer, which must not
 * reach the beamer in these views. Fully hidden statements drop out; several
 * statements hit by one merge (stale result) fold into the largest one's
 * label with summed count and the union of keys. */
function applyModToFreeText(words: AiWord[], mod?: WordCloudModeration): AiWord[] {
  if (!mod) return words;
  const hidden = new Set(mod.hidden.map((h) => h.key));
  let out = words.filter((w) => !w.keys?.length || !w.keys.every((k) => hidden.has(k)));
  for (const m of mod.merges) {
    const group = new Set(m.keys);
    const hit = out.filter((w) => w.keys?.some((k) => group.has(k)));
    if (hit.length < 2) continue;
    const largest = hit.reduce((a, w) => (w.count > a.count ? w : a), hit[0]);
    const merged: AiWord = {
      text: largest.text,
      count: hit.reduce((a, w) => a + w.count, 0),
      keys: [...new Set(hit.flatMap((w) => w.keys ?? []))],
    };
    const first = out.indexOf(hit[0]);
    out = out.filter((w) => !hit.includes(w));
    out.splice(Math.min(first, out.length), 0, merged);
  }
  return out;
}

/** Scale a block down (never up) so it fits above the bottom chrome of the
 * beamer (LiveStats pill, footer) instead of scrolling. `ref` goes on the
 * block, `outerStyle` on its wrapper (keeps the layout height in step). */
function useFitScale(deps: unknown[], clearance = 96) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState({ scale: 1, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.offsetHeight; // unaffected by the transform
      const wrapper = el.parentElement ?? el;
      const bottom = el.closest("main")?.getBoundingClientRect().bottom ?? window.innerHeight;
      const avail = bottom - wrapper.getBoundingClientRect().top - clearance;
      const scale = h > 0 ? Math.max(0.55, Math.min(1, avail / h)) : 1;
      setFit((f) => (Math.abs(f.scale - scale) < 0.01 && f.height === h ? f : { scale, height: h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const scaled = fit.scale < 1 && fit.height > 0;
  return {
    ref,
    outerStyle: scaled ? { height: fit.height * fit.scale } : undefined,
    innerStyle: {
      transform: `translateX(-50%)${scaled ? ` scale(${fit.scale})` : ""}`,
      transformOrigin: "top center",
    },
  };
}

/** Break out of the 4xl question column: statements need the beamer width
 *  (horizontal centring via `useFitScale`'s inline transform). */
const WIDE = "relative left-1/2 w-[min(80rem,calc(100vw-5rem))]";
/** Max key statements on the beamer (the rest is counted as "+N more"). */
const STATEMENTS_MAX = 12;
const CLUSTER_STATEMENTS_MAX = 4;

/** Free-text AI views (#Freitext-KI): "consolidated" = key statements (one row
 * per statement, count badge, most frequent first), "grouped" = statements
 * under their cluster headings. Only AI labels + counts — never the answers'
 * verbatim texts (`variants` stay unrendered). Moderation (hide / merge by
 * drag) acts on the statements' answer `keys`, like the AI word clouds. */
function FreeTextAiView({
  view,
  ai: aiRaw,
  mod,
  onModerate,
}: {
  view: "consolidated" | "grouped";
  ai?: WordCloudAI;
  mod?: WordCloudModeration;
  onModerate?: ModerateFn;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const ai = useMemo(
    () =>
      aiRaw && {
        ...aiRaw,
        merged: applyModToFreeText(aiRaw.merged, mod),
        clusters: aiRaw.clusters.map((c) => ({ ...c, words: applyModToFreeText(c.words, mod) })),
      },
    [aiRaw, mod],
  );
  const findInAi = (d: typeof ai, id: string) =>
    d && [...d.merged, ...d.clusters.flatMap((c) => c.words)].find((w) => wordId(w) === id);
  const { shown, drag, chipProps } = useChipDrag(ai, findInAi, onModerate);
  const fit = useFitScale([view, shown]);
  if (!shown || shown.pending) return <AiWait />;
  const empty = (
    <p className="mt-8 text-center text-slate-400">
      {shown.error ? t("The AI summary is currently unavailable.") : t("No answers yet …")}
    </p>
  );
  // A failed recompute that still has an older result keeps showing it.
  const errorNote = shown.error ? (
    <p className="mt-3 text-center text-sm text-slate-400">
      {t("The AI summary is currently unavailable.")}
    </p>
  ) : null;

  const row = (w: AiWord, color: string, i: number, big: boolean) => {
    const can = !!onModerate && !!w.keys?.length;
    const cp = chipProps(w);
    return (
      <li
        key={wordId(w)}
        {...cp}
        className={`ab-chip-in group relative flex items-center rounded-2xl border border-slate-200 bg-white shadow-sm ${big ? "gap-4 py-2.5 pl-5 pr-3" : "gap-2 py-1.5 pl-3 pr-2 shadow-none"} ${cp.className}`}
        style={{
          ...cp.style,
          borderLeft: `${big ? 10 : 5}px solid ${color}`,
          animationDelay: reduced ? undefined : `${Math.min(i, 12) * 60}ms`,
        }}
      >
        <span
          className={`flex-1 font-semibold leading-snug text-slate-800 ${big ? "text-2xl" : "text-base"}`}
        >
          {w.text}
        </span>
        <span
          className={`shrink-0 rounded-full px-3 py-0.5 text-center font-bold tabular-nums ${big ? "min-w-[3.5rem] text-xl" : "min-w-[2.25rem] text-sm"}`}
          style={{ background: color, color: INK }}
        >
          {w.count}
        </span>
        {can && <HideButton label={w.text} onHide={() => onModerate!("hide", w.keys ?? [])} />}
      </li>
    );
  };

  if (view === "consolidated") {
    const sorted = [...shown.merged].sort((a, b) => b.count - a.count);
    if (sorted.length === 0) return empty;
    const top = sorted.slice(0, STATEMENTS_MAX);
    return (
      <div className="mt-8" style={fit.outerStyle}>
      <div ref={fit.ref} className={WIDE} style={fit.innerStyle}>
        <ol className={`grid gap-3 ${top.length > 6 ? "lg:grid-cols-2" : ""}`}>
          {top.map((w, i) => row(w, termColor(w.text), i, true))}
        </ol>
        {sorted.length > top.length && (
          <p className="mt-4 text-center text-sm text-slate-400">
            {t("+{{count}} more statements", { count: sorted.length - top.length })}
          </p>
        )}
        {errorNote}
      </div>
      <ChipGhost drag={drag} />
      </div>
    );
  }

  const visible = shown.clusters.filter((c) => c.words.length > 0);
  if (visible.length === 0) return empty;
  return (
    <div className="mt-6" style={fit.outerStyle}>
      <div
        ref={fit.ref}
        className={`grid items-start gap-4 ${WIDE}`}
        // Auto-fit columns, at most four (min 15rem each).
        style={{
          ...fit.innerStyle,
          gridTemplateColumns:
            "repeat(auto-fit, minmax(max(15rem, calc((100% - 3rem) / 4)), 1fr))",
        }}
      >
        {visible.map((cluster, ci) => {
          const words = [...cluster.words].sort((a, b) => b.count - a.count);
          const top = words.slice(0, CLUSTER_STATEMENTS_MAX);
          // Header count from the (moderated) statements actually shown.
          const count = words.reduce((a, w) => a + w.count, 0);
          return (
            <section
              key={cluster.label}
              className="rounded-xl border border-slate-200 bg-slate-50/60 p-3"
              style={{ borderTop: `5px solid ${categoryColor(ci)}` }}
            >
              <h3
                className="mb-2 flex items-baseline gap-2 text-xl font-bold leading-tight"
                style={{ color: categoryDeep(ci) }}
              >
                <span className="min-w-0 break-words">{cluster.label}</span>
                <span className="shrink-0 text-base font-semibold text-slate-400">· {count}</span>
              </h3>
              <ul className="space-y-1.5">{top.map((w, i) => row(w, categoryColor(ci), i, false))}</ul>
              {words.length > top.length && (
                <p className="mt-1.5 text-sm text-slate-400">
                  {t("+{{count}} more statements", { count: words.length - top.length })}
                </p>
              )}
            </section>
          );
        })}
      </div>
      {errorNote}
      <ChipGhost drag={drag} />
    </div>
  );
}

/** One unified cloud (not side-by-side cards): words coloured by category hue
 * with a within-category frequency ramp, soft-clustered around per-category
 * centroids, plus a legend mapping colour → category label · count
 * (#Wortwolke-KI). */
function GroupedWordClouds({
  clusters,
  onModerate,
}: {
  clusters: WordCloudAI["clusters"];
  onModerate?: (op: "hide" | "merge", keys: string[], label?: string) => void;
}) {
  const visible = clusters.filter((c) => c.words.length > 0);
  if (visible.length === 0) {
    return <WordCloud words={[]} />;
  }
  // Flatten every cluster's words into one cloud: hue = category, colour
  // intensity ramps within the category, layout clusters around per-index
  // centroids (soft grouping, one cloud). Size is global (WordCloud handles it).
  const words: CloudWord[] = visible.flatMap((cluster, i) => {
    const hue = categoryHue(i);
    const max = Math.max(...cluster.words.map((w) => w.count));
    const min = Math.min(...cluster.words.map((w) => w.count));
    const t = (c: number) => (max === min ? 1 : (c - min) / (max - min));
    return cluster.words.map((w) => ({
      text: w.text,
      count: w.count,
      color: hueColor(hue, t(w.count)),
      keys: w.keys,
      cluster: i,
    }));
  });
  return (
    <div>
      <WordCloud words={words} heightClass="h-[56vh]" animate onModerate={onModerate} />
      {/* Legend down the left edge, lower area, one category per line. */}
      <div className="fixed bottom-32 left-6 z-10 flex flex-col gap-2">
        {visible.map((cluster, i) => (
          <span key={cluster.label} className="flex items-center gap-2 text-lg">
            <span
              className="inline-block h-4 w-4 shrink-0 rounded"
              style={{ background: hueColor(categoryHue(i), 0.8) }}
            />
            <span className="font-semibold text-slate-700 dark:text-slate-200">
              {cluster.label}
            </span>
            <span className="text-slate-400">· {cluster.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

