// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Ranking of a rated mind map (rating phase): the rated entries, best
 * first — points as ResultBar bars (share of all points), plus/minus as a
 * diverging bar (green up, rosé down) with the balance. Shared by the beamer
 * ("Ranking" view) and the results page. The order mirrors the server's
 * (`backend/live/mindmap_rating.ranking`): score, then the number of
 * contributions, then the path. */
import { useTranslation } from "react-i18next";
import type { LiveMindmapNode, MindmapRating, MindmapScore } from "../api";
import ResultBar from "./ResultBar";
import { mindmapBranchFill, mindmapNodeText, visibleMindmap } from "./MindMap";
import {
  CORRECT as UP,
  CORRECT_STRONG as UP_INK,
  INK,
  MINUS as DOWN,
  MINUS_INK as DOWN_INK,
  NEUTRAL_TILE,
  WRONG,
  categoryColor,
} from "./palette";

export interface RankedEntry {
  id: number;
  text: string;
  /** Display path from the main branch down to the parent ([] = main branch). */
  path: string[];
  count: number;
  score: MindmapScore;
  /** Id of the main branch the entry belongs to (itself for a main branch). */
  branch: number;
}

/** Points, or the balance of a plus/minus score. */
export function scoreValue(score: MindmapScore): number {
  return "points" in score ? score.points : score.balance;
}

/** Rated visible entries of `nodes` (presenter or results tree), best first. */
export function rankMindmap(
  nodes: LiveMindmapNode[],
  scores: MindmapRating["scores"],
): RankedEntry[] {
  if (!scores) return [];
  const out: RankedEntry[] = [];
  const walk = (list: LiveMindmapNode[], path: string[], branch: number | null) =>
    list.forEach((n) => {
      const text = mindmapNodeText(n);
      const b = branch ?? n.id;
      const score = scores[String(n.id)];
      if (score) out.push({ id: n.id, text, path, count: n.count, score, branch: b });
      walk(n.children, [...path, text], b);
    });
  walk(visibleMindmap(nodes), [], null);
  const key = (e: RankedEntry) => [...e.path, e.text].join(" > ");
  return out.sort(
    (a, b) =>
      scoreValue(b.score) - scoreValue(a.score) ||
      b.count - a.count ||
      key(a).localeCompare(key(b)),
  );
}

export default function MindmapRanking({
  entries,
  mode,
  size = "present",
  limit,
  animate = false,
  hues,
}: {
  entries: RankedEntry[];
  mode: MindmapRating["mode"];
  size?: "present" | "compact";
  /** Show only the best `limit` entries. */
  limit?: number;
  animate?: boolean;
  /** Hue per main branch (`mindmapBranchHues`): each bar takes its term's
   *  branch colour from the map; without it, palette colours by rank. */
  hues?: Map<number, number>;
}) {
  const colorOf = (e: RankedEntry, i: number) => {
    const hue = hues?.get(e.branch);
    return hue !== undefined ? mindmapBranchFill(hue) : categoryColor(i);
  };
  const { t } = useTranslation();
  const present = size === "present";
  // Dark theme only in the management UI; the beamer stays light.
  const muted = `text-slate-500 ${present ? "" : "dark:text-slate-400"}`;
  const shown = limit ? entries.slice(0, limit) : entries;
  if (shown.length === 0)
    return (
      <p data-testid="mindmap-ranking" className={muted}>
        {t("No ratings yet.")}
      </p>
    );
  const rank = (i: number) => <span className="sr-only">{t("Rank {{n}}", { n: i + 1 })}: </span>;
  const label = (e: RankedEntry) => (
    <>
      {e.text}
      {e.path.length > 0 && (
        <span className={`ml-2 font-normal ${muted} ${present ? "text-base" : "text-xs"}`}>
          {e.path.join(" › ")}
        </span>
      )}
    </>
  );
  const more =
    limit && entries.length > limit ? (
      <p className={`${muted} ${present ? "text-base" : "text-xs"}`}>
        {t("More rated terms: {{n}}", { n: entries.length - limit })}
      </p>
    ) : null;

  if (mode === "points") {
    const total = entries.reduce((sum, e) => sum + scoreValue(e.score), 0);
    return (
      <div data-testid="mindmap-ranking" className={present ? "space-y-4" : "space-y-3"}>
        <ol aria-label={t("Ranking")} className={present ? "space-y-4" : "space-y-3"}>
          {shown.map((e, i) => (
            <li key={e.id}>
              <ResultBar
                index={i}
                letter={String(i + 1)}
                label={
                  <>
                    {rank(i)}
                    {label(e)}
                  </>
                }
                count={scoreValue(e.score)}
                pct={total ? Math.round((scoreValue(e.score) / total) * 100) : 0}
                color={colorOf(e, i)}
                size={size}
                animate={animate}
              />
            </li>
          ))}
        </ol>
        {more}
      </div>
    );
  }

  // Plus/minus: one bar per entry, up share green on the left, down share
  // rosé on the right of a common scale (the most-rated entry fills it).
  const max = Math.max(
    1,
    ...entries.map((e) => ("up" in e.score ? e.score.up + e.score.down : 0)),
  );
  const trackH = present ? 30 : 18;
  const radius = present ? 10 : 6;
  return (
    <div data-testid="mindmap-ranking" className={present ? "space-y-4" : "space-y-3"}>
      <ol aria-label={t("Ranking")} className={present ? "space-y-4" : "space-y-3"}>
        {shown.map((e, i) => {
          const s = e.score as { up: number; down: number; balance: number };
          const sign = s.balance > 0 ? "+" : s.balance < 0 ? "−" : "±";
          return (
            <li key={e.id}>
              <div className={`mb-1 flex items-center gap-2.5 ${present ? "text-xl" : "text-sm"}`}>
                <span
                  aria-hidden
                  className={`inline-flex shrink-0 items-center justify-center rounded-md font-bold ${present ? "h-7 w-7 text-sm" : "h-5 w-5 text-[11px]"}`}
                  style={{ background: colorOf(e, i), color: INK }}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {rank(i)}
                  {label(e)}
                </span>
                <span
                  className={`ml-auto shrink-0 whitespace-nowrap tabular-nums ${present ? "" : "dark:text-slate-300"}`}
                  aria-label={t("{{up}} plus, {{down}} minus, balance {{balance}}", {
                    up: s.up,
                    down: s.down,
                    balance: s.balance,
                  })}
                >
                  <span style={{ color: UP_INK }} className="font-semibold">+{s.up}</span>
                  <span className={muted}> / </span>
                  <span style={{ color: DOWN_INK }} className="font-semibold">−{s.down}</span>
                  <span
                    className={`ml-2 inline-block rounded-full px-2 font-bold ${present ? "" : "text-xs"}`}
                    style={{
                      background: s.balance > 0 ? UP : s.balance < 0 ? WRONG : NEUTRAL_TILE,
                      color: INK,
                    }}
                  >
                    {sign}
                    {Math.abs(s.balance)}
                  </span>
                </span>
              </div>
              <div
                className={`flex overflow-hidden bg-slate-100 ${present ? "" : "dark:bg-slate-800"}`}
                style={{ height: trackH, borderRadius: radius }}
              >
                <div style={{ width: `${(s.up / max) * 100}%`, background: UP }} />
                <div style={{ width: `${(s.down / max) * 100}%`, background: DOWN }} />
              </div>
            </li>
          );
        })}
      </ol>
      {more}
    </div>
  );
}
