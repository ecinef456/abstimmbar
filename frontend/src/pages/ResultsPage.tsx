// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Stored results per run (concept §7): the same bar charts as in the
 * presentation, viewable after the lecture; runs are deletable. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { ChartColumnDecreasing, Download, Trash2 } from "lucide-react";
import {
  aiErrorText,
  api,
  results,
  type FreeTextEvaluation,
  type LiveMindmapNode,
  type MindmapRating,
  type Question,
  type QuestionSet,
  type RunResults,
  type WordCloudOptimization,
} from "../api";
import { useApp, useEasyMode } from "../App";
import { localizedText, RichText, stripHtml } from "@basicbar/ui";
import AiAssistPanel from "../components/AiAssistPanel";
import HomeCrumb from "../components/HomeCrumb";
import { Button, ConfirmInline, EmptyState, TextInput } from "../components/ui";
import LikertResult from "../components/LikertResult";
import { mindmapBranchHues, mindmapNodeDescriptions, mindmapNodeText } from "../results/MindMap";
import MindmapRanking, { rankMindmap } from "../results/MindmapRanking";
import MatrixResult from "../results/MatrixResult";
import PriorityBar from "../results/PriorityBar";
import ResultBar from "../results/ResultBar";
import {
  CORRECT,
  CORRECT_STRONG,
  INK,
  MINUS,
  MINUS_INK,
  NEUTRAL_TILE,
  evalColor,
  termColor,
} from "../results/palette";

/** Word-cloud result with an optional AI cleanup (merge spelling variants and
 * synonyms, group into thematic clusters). Non-destructive: the raw votes are
 * untouched, and the teacher can flip back to the original at any time. */
function WordCloudResult({
  runId,
  questionId,
  words,
  aiEnabled,
  aiOff = false,
}: {
  runId: number;
  questionId: number;
  words: { text: string; count: number }[];
  aiEnabled: boolean;
  /** AI is on globally but switched off for this question: show a hint. */
  aiOff?: boolean;
}) {
  const { t } = useTranslation();
  const [optimized, setOptimized] = useState<WordCloudOptimization | null>(null);
  const [showOptimized, setShowOptimized] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function optimize() {
    setBusy(true);
    setError("");
    try {
      const data = await results.optimizeWordCloud(runId, questionId);
      setOptimized(data);
      setShowOptimized(true);
    } catch (err) {
      setError(aiErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  const showClusters = optimized && showOptimized;

  return (
    <>
      {!showClusters && (
        <p className="text-sm leading-7">
          {words.map((word) => (
            <span
              key={word.text}
              className="mr-3 inline-block max-w-full rounded-lg px-2 py-0.5 [overflow-wrap:anywhere]"
              style={{ background: termColor(word.text), color: INK }}
            >
              {word.text} <span className="font-medium">×{word.count}</span>
            </span>
          ))}
          {words.length === 0 && <span className="text-slate-400">{t("No terms.")}</span>}
        </p>
      )}
      {showClusters && (
        <div className="space-y-3">
          {optimized.clusters.map((cluster) => (
            <div key={cluster.label}>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                {cluster.label}{" "}
                <span className="text-slate-400">· {cluster.count}</span>
              </div>
              <p className="text-sm leading-7">
                {cluster.words.map((word) => (
                  <span
                    key={word.text}
                    title={
                      word.variants.length > 1
                        ? t("Merged: {{variants}}", { variants: word.variants.join(", ") })
                        : undefined
                    }
                    className="mr-3 inline-block max-w-full rounded-lg px-2 py-0.5 [overflow-wrap:anywhere]"
                    style={{ background: termColor(word.text), color: INK }}
                  >
                    {word.text} <span className="font-medium">×{word.count}</span>
                  </span>
                ))}
              </p>
            </div>
          ))}
        </div>
      )}
      {aiOff && words.length > 0 && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {t("AI is turned off for this question.")}
        </p>
      )}
      {aiEnabled && words.length > 0 && (
        <div className="mt-3">
          <AiAssistPanel title={t("Optimize word cloud")}>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void optimize()} disabled={busy}>
                {busy
                  ? t("Optimizing …")
                  : optimized
                    ? t("Optimize again")
                    : t("Optimize with AI")}
              </Button>
              {optimized && (
                <Button variant="ghost" onClick={() => setShowOptimized((v) => !v)}>
                  {showOptimized ? t("Show original") : t("Show optimized")}
                </Button>
              )}
            </div>
            {error && <p className="mt-1 text-sm text-danger">{error}</p>}
          </AiAssistPanel>
        </div>
      )}
    </>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function evalLabel(verdict: string) {
  return verdict ? verdict[0].toUpperCase() + verdict.slice(1) : verdict;
}

/** Free-text result with an optional AI evaluation: each distinct answer is
 * sorted into korrekt / unklar / falsch. An optional reference (expected
 * answer or criterion) sharpens the judgement. Non-destructive. */
function FreeTextResult({
  runId,
  questionId,
  words,
  aiEnabled,
  aiOff = false,
  modelSolution,
}: {
  runId: number;
  questionId: number;
  words: { text: string; count: number }[];
  aiEnabled: boolean;
  /** AI is on globally but switched off for this question: show a hint. */
  aiOff?: boolean;
  /** The question's stored Musterlösung (model_solution), used to prefill
   *  the reference input below — never overwrites a teacher's own edit. */
  modelSolution: string;
}) {
  const { t } = useTranslation();
  const [reference, setReference] = useState("");
  const [evaluation, setEvaluation] = useState<FreeTextEvaluation | null>(null);
  const [showEvaluation, setShowEvaluation] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Guards the prefill below against clobbering text the teacher already
  // typed (e.g. once the question data arrives after a user edit).
  const referenceEditedRef = useRef(false);

  useEffect(() => {
    if (!referenceEditedRef.current && modelSolution) {
      setReference(modelSolution);
    }
  }, [modelSolution]);

  async function evaluate() {
    setBusy(true);
    setError("");
    try {
      const data = await results.evaluateFreeText(runId, questionId, reference);
      setEvaluation(data);
      setShowEvaluation(true);
    } catch (err) {
      setError(aiErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  const showGroups = evaluation && showEvaluation;

  return (
    <>
      {!showGroups && (
        <p className="text-sm leading-7">
          {words.map((word) => (
            <span
              key={word.text}
              className="mr-3 inline-block max-w-full rounded-lg px-2 py-0.5 [overflow-wrap:anywhere]"
              style={{ background: termColor(word.text), color: INK }}
            >
              {word.text} <span className="font-medium">×{word.count}</span>
            </span>
          ))}
          {words.length === 0 && <span className="text-slate-400">{t("No terms.")}</span>}
        </p>
      )}
      {showGroups && (
        <div className="space-y-3">
          {/* Optional bar chart of the category distribution. */}
          {evaluation.chart && (
            <div className="mb-4 space-y-2">
              {evaluation.groups.map((group, i) => {
                const total = evaluation.groups.reduce((s, g) => s + g.count, 0);
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
                    size="compact"
                  />
                );
              })}
            </div>
          )}
          {evaluation.groups.map((group, i) =>
            group.items.length === 0 ? null : (
              <div key={group.verdict}>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                  {evalLabel(group.verdict)}{" "}
                  <span className="text-slate-300 dark:text-slate-600">
                    · {group.count}
                  </span>
                </div>
                <p className="text-sm leading-7">
                  {group.items.map((item) => (
                    <span
                      key={item.text}
                      title={item.note || undefined}
                      className="mr-3 inline-block max-w-full rounded-lg px-2 py-0.5 [overflow-wrap:anywhere]"
                      style={{ background: evalColor(i), color: INK }}
                    >
                      {item.text} <span className="font-medium">×{item.count}</span>
                    </span>
                  ))}
                </p>
              </div>
            ),
          )}
        </div>
      )}
      {aiOff && words.length > 0 && (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {t("AI is turned off for this question.")}
        </p>
      )}
      {aiEnabled && words.length > 0 && (
        <div className="mt-3">
          <AiAssistPanel title={t("Evaluate free text")}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <TextInput
                value={reference}
                onChange={(event) => {
                  referenceEditedRef.current = true;
                  setReference(event.target.value);
                }}
                placeholder={t("Expected answer / criterion (optional)")}
                className="sm:max-w-xs"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void evaluate()} disabled={busy}>
                  {busy
                    ? t("Evaluating …")
                    : evaluation
                      ? t("Evaluate again")
                      : t("Evaluate answers")}
                </Button>
                {evaluation && (
                  <Button variant="ghost" onClick={() => setShowEvaluation((v) => !v)}>
                    {showEvaluation ? t("Show original") : t("Show evaluation")}
                  </Button>
                )}
              </div>
            </div>
            {error && <p className="mt-1 text-sm text-danger">{error}</p>}
          </AiAssistPanel>
        </div>
      )}
    </>
  );
}

/** Optional AI short report of one run's results, rendered as sanitized
 * HTML via `RichText`. Display-only; the teacher triggers it and can
 * regenerate. */
function RunReport({ runId, aiEnabled }: { runId: number; aiEnabled: boolean }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function make() {
    setBusy(true);
    setError("");
    try {
      const data = await results.summarize(runId);
      setReport(data.report);
    } catch (err) {
      setError(aiErrorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  if (!aiEnabled) return null;
  return (
    <div className="mb-4">
      <AiAssistPanel title={t("Short report")}>
        <Button onClick={() => void make()} disabled={busy}>
          {busy
            ? t("Generating …")
            : report
              ? t("Create again")
              : t("Create short report")}
        </Button>
        {report && (
          <div className="mt-2 text-sm">
            <RichText html={report} />
          </div>
        )}
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
      </AiAssistPanel>
    </div>
  );
}

export default function ResultsPage() {
  const { t } = useTranslation();
  const { setId } = useParams();
  const id = Number(setId);
  const { whoami } = useApp();
  const easyMode = useEasyMode();
  const aiEnabled = !!whoami?.ai_enabled && !easyMode;
  const [set, setSet] = useState<QuestionSet | null>(null);
  const [runs, setRuns] = useState<RunResults[] | null>(null);
  // Full question objects (#Musterlösung): only fetched to read
  // model_solution for the free-text re-evaluation prefill below; the
  // results view itself keeps using the aggregated RunResults data.
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | "all" | null>(null);
  // Which Durchführung (archive) is shown, and whether export covers all (#17).
  const [selected, setSelected] = useState<number | null>(null);
  const [exportAll, setExportAll] = useState(false);

  const reload = () =>
    Promise.all([
      api.getQuestionSet(id),
      results.list(id),
      api.listQuestions(id),
    ]).then(([setData, payload, questionPage]) => {
      setSet(setData);
      setRuns(payload.results);
      setQuestions(questionPage.results);
    });
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!set || !runs || !questions) return null;

  const modelSolutionByQuestion = new Map(
    questions.map((q) => [q.id, q.model_solution]),
  );
  // The question's own AI switch (the backend rejects AI actions without it).
  const aiSwitchByQuestion = new Map(
    questions.map((q) => [q.id, q.wordcloud_ai_enabled]),
  );

  // Runs come newest-first; the newest is the default selection.
  const current = runs.find((r) => r.run === selected) ?? runs[0] ?? null;
  const runLabel = (run: RunResults) =>
    t("Run on {{date}}", { date: formatDate(run.first_opened_at ?? run.created_at) });

  return (
    <div>
      <nav className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        <HomeCrumb /> /{" "}
        <Link to={`/rooms/${set.room}`} className="hover:text-brand-700 dark:hover:text-brand-300">{set.room_title}</Link> /{" "}
        <Link to={`/sets/${set.id}`} className="hover:text-brand-700 dark:hover:text-brand-300">{localizedText(set.title)}</Link> /{" "}
        {t("Results")}
      </nav>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 data-tour="results.view" className="text-2xl font-bold">{t("Results — {{title}}", { title: localizedText(set.title) })}</h1>
        {runs.length > 0 && current && (
          <div data-tour="results.export" className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
            {/* Export as one visibly grouped unit: scope + download. */}
            <div className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900/40">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {t("Export")}
              </span>
              <select
                aria-label={t("Export scope")}
                value={exportAll ? "all" : "one"}
                onChange={(event) => setExportAll(event.target.value === "all")}
                className="min-w-0 max-w-full rounded-lg border border-field bg-white px-2 py-1 text-sm dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:ring-1 focus:ring-brand-600 focus:outline-none"
              >
                <option value="one">{t("only this session")}</option>
                <option value="all">{t("all sessions (incl. archive)")}</option>
              </select>
              <a
                href={results.csvUrl(id, exportAll ? undefined : current.run)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <Download aria-hidden className="h-4 w-4" /> CSV
              </a>
            </div>
            {confirmDelete === "all" ? (
              <ConfirmInline
                message={t("Delete all results?")}
                onConfirm={() =>
                  void results.deleteAll(id).then(() => {
                    setConfirmDelete(null);
                    return reload();
                  })
                }
                onCancel={() => setConfirmDelete(null)}
              />
            ) : (
              <Button variant="danger" onClick={() => setConfirmDelete("all")}>
                {t("Delete all")}
              </Button>
            )}
          </div>
        )}
      </div>

      {runs.length === 0 ? (
        <EmptyState icon={ChartColumnDecreasing} title={t("No results yet")}>
          {t(
            "Results appear here once the question set has been presented and answered at least once.",
          )}
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {(current ? [current] : []).map((run) => (
            <section
              key={run.run}
              className="rounded-2xl border border-slate-200 dark:border-slate-800 p-3 sm:p-5"
            >
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                {/* The Termin picker doubles as the block heading (#17-Feedback). */}
                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                  <select
                    data-tour="results.runs"
                    aria-label={t("Select session")}
                    value={run.run}
                    onChange={(event) => setSelected(Number(event.target.value))}
                    className="min-w-0 max-w-full rounded-lg border border-field bg-white px-3 py-1.5 text-base font-semibold text-slate-900 dark:bg-slate-900 dark:text-slate-100 focus:border-brand-600 focus:ring-1 focus:ring-brand-600 focus:outline-none"
                  >
                    {runs.map((r) => (
                      <option key={r.run} value={r.run}>
                        {runLabel(r)}
                      </option>
                    ))}
                  </select>
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {run.votes_total} {t("vote", { count: run.votes_total })}
                    {run.phase !== "finished" && t(" · still running")}
                  </span>
                </div>
                {confirmDelete === run.run ? (
                  <ConfirmInline
                    message={t("Delete run?")}
                    onConfirm={() =>
                      void results.deleteRun(run.run).then(() => {
                        setConfirmDelete(null);
                        return reload();
                      })
                    }
                    onCancel={() => setConfirmDelete(null)}
                  />
                ) : (
                  <Button
                    variant="ghost"
                    aria-label={t("Delete run")}
                    onClick={() => setConfirmDelete(run.run)}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </Button>
                )}
              </div>

              {run.votes_total > 0 && (
                <RunReport runId={run.run} aiEnabled={aiEnabled} />
              )}

              <div className="space-y-5">
                {run.questions.map((question) => {
                  const total = question.votes;
                  const hasCorrect = question.options?.some((o) => o.is_correct) ?? false;
                  // Before/after pair (#54): at the after-question's slot, show
                  // the before-question (from the same run) stacked above it.
                  const before =
                    question.before_question != null
                      ? run.questions.find((q) => q.id === question.before_question)
                      : undefined;
                  const isBefore = run.questions.some(
                    (q) => q.before_question === question.id,
                  );
                  return (
                    <div key={question.id}>
                      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-900 max-sm:flex-wrap max-sm:gap-y-0.5 dark:text-slate-100">
                        {(before || isBefore) && (
                          <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                            {before ? t("After") : t("Before")}
                          </span>
                        )}
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {question.position + 1}. {stripHtml(localizedText(question.text)) || t("No question text")}
                        </span>
                        <span className="whitespace-nowrap font-normal text-slate-400">
                          {total} {t("answer", { count: total })}
                        </span>
                        {question.votes_recording > 0 && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            {t("{{n}} from recording", { n: question.votes_recording })}
                          </span>
                        )}
                      </h3>
                      {before ? (
                        question.kind === "likert" ? (
                          <BeforeAfterLikert before={before} after={question} />
                        ) : (
                          <BeforeAfterChoice before={before} after={question} />
                        )
                      ) : (
                        <>
                          {question.kind === "likert" && question.likert && (
                            <LikertResult summary={question.likert} variant="compact" />
                          )}
                          {question.options && !(question.kind === "likert" && question.likert) && (
                            <div className="space-y-2">
                              {question.options.map((option, i) => {
                                const count = option.count ?? 0;
                                const percent = total ? Math.round((count / total) * 100) : 0;
                                return (
                                  <div key={option.id}>
                                    <ResultBar
                                      index={i}
                                      label={localizedText(option.text)}
                                      count={count}
                                      pct={percent}
                                      state={hasCorrect ? (option.is_correct ? "correct" : "wrong") : "neutral"}
                                      size="compact"
                                    />
                                    {/* Recording split (#53): on-site vs async. */}
                                    {run.recording_votes > 0 && (
                                      <div className="mt-0.5 text-[11px] text-slate-400">
                                        {t("On-site")}: {option.onsite ?? 0} · {t("Recording")}: {option.recording ?? 0}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {question.priorities && question.kind === "priorities" && (
                            <div className="space-y-2">
                              {question.priorities.map((opt, i) => (
                                <PriorityBar
                                  key={opt.id}
                                  index={i}
                                  label={localizedText(opt.text)}
                                  avg={opt.avg}
                                  min={opt.min}
                                  max={opt.max}
                                  size="compact"
                                />
                              ))}
                              {question.priorities.length === 0 && (
                                <span className="text-slate-400">{t("No answers yet.")}</span>
                              )}
                            </div>
                          )}
                          {question.ordering && question.kind === "ordering" && (
                            <div className="space-y-1.5">
                              {question.ordering.n === 0 ? (
                                <span className="text-slate-400">{t("No answers yet.")}</span>
                              ) : (
                                <>
                                  <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                                    {t("{{pct}}% got the full order correct", {
                                      pct: question.ordering.full_correct_rate,
                                    })}
                                  </div>
                                  <div className="inline-grid max-w-full gap-x-2" style={{ gridTemplateColumns: "minmax(0, max-content) auto" }}>
                                    {question.ordering.items.flatMap((it, i) => {
                                      const link = question.ordering!.links?.[i];
                                      const rows = [
                                        <div
                                          key={`item-${it.id}`}
                                          className="col-start-1 flex min-w-0 items-center gap-2 py-0.5 text-sm text-slate-700 dark:text-slate-300"
                                          style={{ gridRow: 2 * i + 1 }}
                                        >
                                          <span className="tabular-nums text-slate-400">{it.correct_position}.</span>
                                          <span className="truncate">{localizedText(it.text)}</span>
                                        </div>,
                                      ];
                                      if (link) {
                                        rows.push(
                                          <div
                                            key={`link-${it.id}`}
                                            className="col-start-1 flex items-center justify-center"
                                            style={{ gridRow: 2 * i + 2 }}
                                          >
                                            {/* Rate → border strength, never text opacity (#178). */}
                                            <span
                                              className="rounded-full border border-brand-600/[var(--rate)] bg-slate-100 px-1.5 text-xs tabular-nums text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                                              style={{ "--rate": 0.15 + 0.85 * (link.rate / 100) } as CSSProperties}
                                            >
                                              {t("{{pct}}% in a row", { pct: link.rate })}
                                            </span>
                                          </div>,
                                        );
                                      }
                                      return rows;
                                    })}
                                    {question.ordering.chains.map((c, idx) => (
                                      <div
                                        key={`chain-${idx}`}
                                        className="col-start-2 flex items-center gap-1.5 pl-1"
                                        style={{ gridRow: `${2 * c.start + 1} / ${2 * c.end + 2}` }}
                                      >
                                        <div className="h-full w-1.5 rounded-r-md border-y-2 border-r-2 border-brand-400" />
                                        <span className="text-xs font-medium tabular-nums text-brand-700 dark:text-brand-300">
                                          {c.rate}%
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                          {question.kind === "mindmap" && (
                            <MindmapOutline
                              nodes={question.mindmap?.nodes ?? []}
                              root={localizedText(question.mindmap?.root.label) || stripHtml(localizedText(question.text))}
                              rating={question.mindmap?.rating}
                            />
                          )}
                          {question.kind === "matrix" && question.matrix && question.matrix_settings && (
                            <MatrixResult board={question.matrix} settings={question.matrix_settings} />
                          )}
                          {question.words && question.kind === "word_cloud" && (
                            <WordCloudResult
                              runId={run.run}
                              questionId={question.id}
                              words={question.words}
                              aiEnabled={aiEnabled && !!aiSwitchByQuestion.get(question.id)}
                              aiOff={aiEnabled && !aiSwitchByQuestion.get(question.id)}
                            />
                          )}
                          {question.words && question.kind === "open_text" && (
                            <FreeTextResult
                              runId={run.run}
                              questionId={question.id}
                              words={question.words}
                              aiEnabled={aiEnabled && !!aiSwitchByQuestion.get(question.id)}
                              aiOff={aiEnabled && !aiSwitchByQuestion.get(question.id)}
                              modelSolution={modelSolutionByQuestion.get(question.id) ?? ""}
                            />
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

type ResultQuestion = RunResults["questions"][number];

/** Mindmap result (visible nodes only): root, then the terms as an indented
 * outline with count pills (> 1) and muted descriptions. With a rating
 * phase: each rated term's score in the outline, and the ranking below. */
function MindmapOutline({
  nodes,
  root,
  rating,
}: {
  nodes: LiveMindmapNode[];
  root: string;
  rating?: MindmapRating;
}) {
  const { t } = useTranslation();
  if (nodes.length === 0) return <span className="text-slate-400">{t("No answers yet.")}</span>;
  const scoreEl = (id: number) => {
    const score = rating?.scores?.[String(id)];
    if (!score) return null;
    if ("points" in score)
      return (
        <span
          className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums text-white dark:ring-1 dark:ring-slate-500"
          style={{ background: INK }}
          title={t("{{count}} points", { count: score.points })}
        >
          ● {score.points}
        </span>
      );
    const sign = score.balance > 0 ? "+" : score.balance < 0 ? "−" : "±";
    return (
      <span
        className="ml-2 text-[11px] font-semibold tabular-nums"
        title={t("{{up}} plus, {{down}} minus, balance {{balance}}", {
          up: score.up,
          down: score.down,
          balance: score.balance,
        })}
      >
        <span style={{ color: CORRECT_STRONG }}>+{score.up}</span>{" "}
        <span style={{ color: MINUS_INK }}>−{score.down}</span>{" "}
        <span
          className="rounded-full px-1.5 py-0.5 text-[10px]"
          style={{
            color: INK,
            background: score.balance > 0 ? CORRECT : score.balance < 0 ? MINUS : NEUTRAL_TILE,
          }}
        >
          {sign}
          {Math.abs(score.balance)}
        </span>
      </span>
    );
  };
  const render = (list: LiveMindmapNode[], level: number) => (
    <ul className={level ? "ml-4 border-l border-slate-200 pl-3 dark:border-slate-700" : "space-y-1"}>
      {list.map((n) => (
        <li key={n.id} className="py-0.5">
          <span className="text-sm text-slate-800 [overflow-wrap:anywhere] dark:text-slate-100">{mindmapNodeText(n)}</span>
          {n.count > 1 && (
            <span className="ml-2 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-brand-700 dark:bg-brand-950 dark:text-brand-300">
              {n.count}
            </span>
          )}
          {scoreEl(n.id)}
          {n.descriptions.length > 0 && (
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {mindmapNodeDescriptions(n).join(" · ")}
            </div>
          )}
          {n.children.length > 0 && render(n.children, level + 1)}
        </li>
      ))}
    </ul>
  );
  const ranking = rating ? rankMindmap(nodes, rating.scores) : [];
  return (
    <div>
      <div className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-50">{root}</div>
      {render(nodes, 0)}
      {rating && (
        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {t("Ranking")}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {rating.mode === "points"
                ? t("Points · rated by {{n}}", { n: rating.raters })
                : t("Plus/minus · rated by {{n}}", { n: rating.raters })}
            </span>
          </div>
          {rating.rating_in_progress ? (
            <p className="text-sm text-slate-500 dark:text-slate-400" data-testid="mm-rating-in-progress">
              {t("Rating still in progress — results appear once they are revealed.")}
            </p>
          ) : (
            <MindmapRanking
              entries={ranking}
              mode={rating.mode}
              size="compact"
              hues={mindmapBranchHues(nodes)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Before/after choice comparison (#54): per option the before bar (lighter)
 * sits above the after bar, each labelled. Options are paired by position;
 * percentages use each side's own vote total. */
function BeforeAfterChoice({ before, after }: { before: ResultQuestion; after: ResultQuestion }) {
  const options = after.options ?? [];
  const hasCorrect = options.some((o) => o.is_correct);
  const pctOf = (count: number, total: number) => (total ? Math.round((count / total) * 100) : 0);
  return (
    <div className="space-y-3">
      {options.map((option, index) => {
        const beforeCount = before.options?.[index]?.count ?? 0;
        const count = option.count ?? 0;
        return (
          <ResultBar
            key={option.id}
            index={index}
            label={localizedText(option.text)}
            count={count}
            pct={pctOf(count, after.votes)}
            before={{ count: beforeCount, pct: pctOf(beforeCount, before.votes) }}
            state={hasCorrect ? (option.is_correct ? "correct" : "wrong") : "neutral"}
            size="compact"
          />
        );
      })}
    </div>
  );
}

/** Before/after likert comparison (#54): before above after, before's bars
 *  muted (not its text — #178). */
function BeforeAfterLikert({ before, after }: { before: ResultQuestion; after: ResultQuestion }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {before.likert && (
        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {t("Before")}
          </span>
          <LikertResult summary={before.likert} variant="compact" muted />
        </div>
      )}
      {after.likert && (
        <div>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            {t("After")}
          </span>
          <LikertResult summary={after.likert} variant="compact" />
        </div>
      )}
    </div>
  );
}
