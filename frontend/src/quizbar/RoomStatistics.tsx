// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): statistics of a room or folder (master–detail).
 *
 *  Left: the sets of the current folder (or all), compact, each with its
 *  questions underneath. Right: the overview (PRE → POST of the activators,
 *  every set's share of correct answers) or, after a click on a set, that
 *  set question by question with a run selector. CSV and a PDF report. */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { ArrowLeft, ArrowRight, ChartColumnDecreasing, FileDown, FileSpreadsheet, Loader2 } from "lucide-react";
import { localizedText, stripHtml } from "@basicbar/ui";
import { quizbar, requestDetail, type PrePostPair, type QuestionStat, type RoomStats, type SetStat } from "../api";
import { Button } from "../components/ui";
import { MathText } from "../math";
import ResultBar from "../results/ResultBar";
import { SET_TYPES } from "../setTypes";
import { download } from "./ExportDialog";
import type { FolderSelection } from "./Folders";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function pct(share: number | null | undefined) {
  return share === null || share === undefined ? "–" : `${Math.round(share * 100)} %`;
}

function tone(share: number | null | undefined) {
  if (share === null || share === undefined) return "text-slate-400";
  if (share >= 0.7) return "text-brand-700 dark:text-brand-300";
  if (share >= 0.4) return "text-amber-700 dark:text-amber-300";
  return "text-red-700 dark:text-red-400";
}

function barColor(share: number | null | undefined) {
  if (share === null || share === undefined) return "bg-slate-300";
  if (share >= 0.7) return "bg-brand-600";
  if (share >= 0.4) return "bg-amber-500";
  return "bg-red-500";
}

function Meter({ share, className = "" }: { share: number | null; className?: string }) {
  return (
    <div className={`h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800 ${className}`}>
      <div className={`h-full rounded-full ${barColor(share)}`} style={{ width: `${Math.round((share ?? 0) * 100)}%` }} />
    </div>
  );
}

function questionLine(question: QuestionStat) {
  return stripHtml(localizedText(question.text)).replace(/\s+/g, " ").trim();
}

function setTitle(set: SetStat) {
  return set.title_map ? localizedText(set.title_map) : typeof set.title === "string" ? set.title : localizedText(set.title);
}

function runLabel(set: SetStat, t: (key: string, options?: Record<string, unknown>) => string) {
  if (!set.runs.length) return t("not run yet");
  const run = set.runs.find((r) => r.id === set.run) ?? set.runs[0];
  return new Date(run.date).toLocaleDateString();
}

/** Left column: one compact card per set, its questions underneath. */
function SetList({
  data,
  selected,
  onSelect,
  showGroups,
}: {
  data: RoomStats;
  selected: number | null;
  onSelect: (id: number | null) => void;
  showGroups: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {data.groups.map((group) => (
        <div key={group.folder ?? "none"} className="flex min-w-0 flex-col gap-2">
          {showGroups && (
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {group.title ?? t("Not in a folder")}
            </h3>
          )}
          {group.sets.map((set) => {
            const Icon = SET_TYPES[set.type]?.icon;
            const active = selected === set.id;
            return (
              <div key={set.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onSelect(active ? null : set.id)}
                  aria-pressed={active}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                    active
                      ? "border-brand-600 bg-brand-50/60 dark:bg-brand-950/30"
                      : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {Icon && <Icon aria-hidden className="h-4 w-4 shrink-0 text-slate-500" />}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                      {setTitle(set)}
                    </span>
                    <span className={`shrink-0 text-sm font-semibold tabular-nums ${tone(set.correct)}`}>
                      {set.answers ? pct(set.correct) : "–"}
                    </span>
                  </span>
                  <Meter share={set.answers ? set.correct : null} className="mt-1.5" />
                </button>
                {set.questions.length > 0 && (
                  <ol className="ml-4 mt-1 flex min-w-0 flex-col gap-0.5 border-l border-slate-200 pl-3 dark:border-slate-800">
                    {set.questions.map((question, index) => (
                      <li key={question.id} className="flex min-w-0 items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span className="w-4 shrink-0 tabular-nums">{index + 1}.</span>
                        <span className="min-w-0 flex-1 truncate">
                          <MathText text={questionLine(question)} />
                        </span>
                        <span className={`shrink-0 tabular-nums ${tone(question.correct)}`}>
                          {question.answers ? pct(question.correct) : ""}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PairCard({ pair, sets, onSelect }: { pair: PrePostPair; sets: SetStat[]; onSelect: (id: number) => void }) {
  const { t } = useTranslation();
  const pre = sets.find((s) => s.id === pair.pre);
  const post = sets.find((s) => s.id === pair.post);
  const delta =
    pair.pre_correct !== null && pair.post_correct !== null ? Math.round((pair.post_correct - pair.pre_correct) * 100) : null;
  return (
    <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
      <h4 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
        {t("Before and after")}:{" "}
        <button type="button" className="hover:underline" onClick={() => onSelect(pair.pre)}>
          {pre ? setTitle(pre) : "PRE"}
        </button>{" "}
        →{" "}
        <button type="button" className="hover:underline" onClick={() => onSelect(pair.post)}>
          {post ? setTitle(post) : "POST"}
        </button>
      </h4>
      <p className="mb-3 flex items-baseline gap-3 text-2xl font-bold tabular-nums">
        <span className={tone(pair.pre_correct)}>{pct(pair.pre_correct)}</span>
        <ArrowRight aria-hidden className="h-5 w-5 self-center text-slate-400" />
        <span className={tone(pair.post_correct)}>{pct(pair.post_correct)}</span>
        {delta !== null && (
          <span className={`text-base ${delta >= 0 ? "text-brand-700 dark:text-brand-300" : "text-red-700"}`}>
            {delta >= 0 ? "+" : ""}
            {delta}
          </span>
        )}
      </p>
      <ol className="flex min-w-0 flex-col gap-1.5">
        {pair.questions.map((row, index) => (
          <li key={row.pre_id} className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_5rem_5rem] items-center gap-2 text-xs">
            <span className="tabular-nums text-slate-400">{index + 1}.</span>
            <span className="truncate text-slate-600 dark:text-slate-300">
              <MathText text={stripHtml(localizedText(row.text))} />
            </span>
            <span className="flex items-center gap-1">
              <Meter share={row.pre} className="flex-1 opacity-60" />
              <span className={`w-9 text-right tabular-nums ${tone(row.pre)}`}>{pct(row.pre)}</span>
            </span>
            <span className="flex items-center gap-1">
              <Meter share={row.post} className="flex-1" />
              <span className={`w-9 text-right tabular-nums ${tone(row.post)}`}>{pct(row.post)}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Overview({
  data,
  onSelect,
  showGroups,
}: {
  data: RoomStats;
  onSelect: (id: number) => void;
  showGroups: boolean;
}) {
  const { t } = useTranslation();
  const groups = data.groups.filter((g) => g.sets.length);
  if (!groups.length) return <p className="text-sm text-slate-500">{t("No question sets here.")}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {groups.map((group) => (
        <div key={group.folder ?? "none"} className="flex min-w-0 flex-col gap-3">
          {showGroups && (
            <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              {group.title ?? t("Not in a folder")}
            </h3>
          )}
          {group.pairs
            .filter((pair) => pair.pre_correct !== null || pair.post_correct !== null)
            .map((pair) => (
              <PairCard key={`${pair.pre}-${pair.post}`} pair={pair} sets={group.sets} onSelect={onSelect} />
            ))}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-1 font-medium">{t("Question set")}</th>
                <th className="py-1 font-medium">{t("Date")}</th>
                <th className="py-1 text-right font-medium">{t("Participants")}</th>
                <th className="w-40 py-1 pl-4 font-medium">{t("Correct")}</th>
              </tr>
            </thead>
            <tbody>
              {group.sets.map((set) => (
                <tr
                  key={set.id}
                  onClick={() => onSelect(set.id)}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
                >
                  <td className="py-1.5 pr-2">{setTitle(set)}</td>
                  <td className="py-1.5 text-slate-500">{set.answers ? runLabel(set, t) : "–"}</td>
                  <td className="py-1.5 text-right tabular-nums text-slate-500">{set.answers ? set.participants : "–"}</td>
                  <td className="py-1.5 pl-4">
                    <span className="flex items-center gap-2">
                      <Meter share={set.answers ? set.correct : null} className="flex-1" />
                      <span className={`w-10 text-right text-xs font-semibold tabular-nums ${tone(set.correct)}`}>
                        {set.answers ? pct(set.correct) : "–"}
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function QuestionCard({ question, index }: { question: QuestionStat; index: number }) {
  const { t } = useTranslation();
  const peer = question.peer;
  return (
    <article className="min-w-0 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <header className="mb-2 flex items-start gap-2">
        <span className="font-semibold tabular-nums text-slate-500">{index + 1}.</span>
        <span className="min-w-0 flex-1 text-sm font-medium text-slate-800 dark:text-slate-100">
          <MathText text={questionLine(question)} />
        </span>
        <span className="shrink-0 text-right text-sm">
          {peer && peer.correct !== null && (
            <span className="text-xs text-slate-500">
              {t("Vote 1")} <span className={tone(peer.correct)}>{pct(peer.correct)}</span> →{" "}
            </span>
          )}
          <span className={`font-semibold tabular-nums ${tone(question.correct)}`}>{pct(question.correct)}</span>
          <span className="block text-xs text-slate-400">{t("{{count}} answers", { count: question.answers })}</span>
        </span>
      </header>
      {question.options.length > 0 && (
        <div className="space-y-1.5">
          {question.options.map((option, i) => {
            const share = question.answers ? Math.round((option.count / question.answers) * 100) : 0;
            const first = peer ? peer.counts[i] ?? 0 : 0;
            const hasCorrect = question.options.some((o) => o.is_correct);
            return (
              <ResultBar
                key={option.id}
                index={i}
                letter={LETTERS[i]}
                label={<MathText text={localizedText(option.text)} />}
                count={option.count}
                pct={share}
                size="compact"
                state={hasCorrect ? (option.is_correct ? "correct" : "wrong") : "neutral"}
                before={peer ? { count: first, pct: peer.votes ? Math.round((first / peer.votes) * 100) : 0 } : null}
                beforeLabels={peer ? [t("Vote 1"), t("Vote 2")] : undefined}
              />
            );
          })}
        </div>
      )}
      {question.confidence && question.confidence.average !== null && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {t("How sure (0–10): average {{avg}}", { avg: question.confidence.average })}
          {question.confidence.right !== null && ` · ${t("right answers {{avg}}", { avg: question.confidence.right })}`}
          {question.confidence.wrong !== null && ` · ${t("wrong answers {{avg}}", { avg: question.confidence.wrong })}`}
        </p>
      )}
    </article>
  );
}

function SetDetail({ initial, onBack }: { initial: SetStat; onBack: () => void }) {
  const { t } = useTranslation();
  const [run, setRun] = useState<string>(initial.run === null ? "latest" : String(initial.run));
  const [data, setData] = useState<SetStat>(initial);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setData(initial);
    setRun(initial.run === null ? "latest" : String(initial.run));
  }, [initial]);
  function pick(value: string) {
    setRun(value);
    setLoading(true);
    void quizbar
      .setStats(initial.id, value)
      .then((next) => setData({ ...next, title_map: initial.title_map }))
      .finally(() => setLoading(false));
  }
  const selfCheck = data.type === "self_check";
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" /> {t("Overview")}
      </button>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="min-w-0 flex-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{setTitle(initial)}</h3>
        {loading && <Loader2 aria-hidden className="h-4 w-4 animate-spin text-slate-400" />}
        {!selfCheck && data.runs.length > 1 && (
          <select
            value={run}
            onChange={(event) => pick(event.target.value)}
            aria-label={t("Run")}
            className="rounded-md border border-field bg-white px-2 py-1 text-sm dark:bg-slate-900"
          >
            {data.runs.map((r) => (
              <option key={r.id} value={String(r.id)}>
                {new Date(r.date).toLocaleString()} · {t("{{count}} answers", { count: r.votes })}
              </option>
            ))}
            <option value="all">{t("All runs combined")}</option>
          </select>
        )}
        <Link
          to={`/sets/${initial.id}/results`}
          className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-300"
        >
          <ChartColumnDecreasing aria-hidden className="h-4 w-4" />
          {t("Full results")}
        </Link>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {selfCheck
          ? t("{{count}} completed attempts", { count: data.participants })
          : data.runs.length
            ? `${run === "all" ? t("All runs combined") : runLabel(data, t)} · ${t("{{count}} participants", { count: data.participants })}`
            : t("not run yet")}
        {data.answers > 0 && (
          <>
            {" · "}
            <span className={`font-semibold ${tone(data.correct)}`}>{t("{{pct}} correct", { pct: pct(data.correct) })}</span>
          </>
        )}
      </p>
      {data.questions.length === 0 ? (
        <p className="text-sm text-slate-500">{t("No single- or multiple-choice questions in this set.")}</p>
      ) : (
        data.questions.map((question, index) => <QuestionCard key={question.id} question={question} index={index} />)
      )}
    </div>
  );
}

export default function RoomStatistics({
  roomId,
  folder,
  folderTitle,
  defaultLang,
}: {
  roomId: number;
  folder: FolderSelection;
  folderTitle: string;
  defaultLang: string;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const scope = folder === "all" ? "all" : folder === "none" ? "none" : String(folder);
  const [data, setData] = useState<RoomStats | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "csv" | "pdf">("");
  const selected = Number(params.get("statset")) || null;

  useEffect(() => {
    setData(null);
    void quizbar.roomStats(roomId, scope).then(setData, () => setError(t("The statistics could not be loaded.")));
  }, [roomId, scope, t]);

  function select(id: number | null) {
    const next = new URLSearchParams(params);
    if (id === null) next.delete("statset");
    else next.set("statset", String(id));
    setParams(next, { replace: true });
  }
  const selectedSet = useMemo(
    () => data?.groups.flatMap((g) => g.sets).find((s) => s.id === selected) ?? null,
    [data, selected],
  );
  async function save(kind: "csv" | "pdf") {
    setBusy(kind);
    setError("");
    try {
      const file = kind === "csv" ? await quizbar.statsCsv(roomId, scope, defaultLang) : await quizbar.statsPdf(roomId, scope, defaultLang);
      download(file.blob, file.filename);
    } catch (err) {
      const detail = requestDetail(err);
      setError(detail ? t(detail) : t("The export failed."));
    } finally {
      setBusy("");
    }
  }

  if (!data) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-slate-500">
        {error || (
          <>
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> {t("Loading statistics …")}
          </>
        )}
      </p>
    );
  }
  const showGroups = folder === "all";
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <aside className="min-w-0" aria-label={t("Question sets")}>
        <SetList data={data} selected={selected} onSelect={select} showGroups={showGroups} />
      </aside>
      <section className="flex min-w-0 flex-col gap-4" aria-label={t("Statistics")}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t("Statistics")} · {folderTitle}
          </h2>
          <Button variant="ghost" className="inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => void save("csv")}>
            {busy === "csv" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <FileSpreadsheet aria-hidden className="h-4 w-4" />}
            CSV
          </Button>
          <Button variant="ghost" className="inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => void save("pdf")}>
            {busy === "pdf" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <FileDown aria-hidden className="h-4 w-4" />}
            {t("PDF report")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        {selectedSet ? (
          <SetDetail initial={selectedSet} onBack={() => select(null)} />
        ) : (
          <Overview data={data} onSelect={select} showGroups={showGroups} />
        )}
      </section>
    </div>
  );
}
