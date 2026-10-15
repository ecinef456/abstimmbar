// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Ranking of a rated matrix (rating phase): the rated visible top cards,
 *  best first, as the server sorted them (`backend/live/matrix_rating.ranking`:
 *  points or balance, then title). Each row: rank (in the card's category
 *  colour), title, category and field written out, the score as text and a
 *  bar — points in the category colour relative to the best card,
 *  plus/minus green from the left and rosé from the right relative to the
 *  most-rated card (like the mind map). Mirrors `MindmapRanking`; used by
 *  the beamer ("Rangliste" view, size "present") and the results page
 *  ("compact", dark-aware). */
import { useTranslation } from "react-i18next";
import type { MatrixRankingEntry, MatrixRating, MatrixSettingsPayload } from "../api";
import { categoryLabel, paletteEntry, readableOn } from "../matrixPalette";
import { MATRIX_DOWN_INK as DOWN_INK, MATRIX_UP_INK as UP_INK, matrixZoneName } from "./Matrix";
import { CORRECT as UP, MINUS as DOWN } from "./palette";

const NO_CATEGORY_GREY = "#94a3b8";

export default function MatrixRanking({
  entries,
  mode,
  settings,
  size = "present",
  limit,
}: {
  entries: MatrixRankingEntry[];
  mode: MatrixRating["mode"];
  settings: MatrixSettingsPayload;
  size?: "present" | "compact";
  /** Show only the best `limit` entries. */
  limit?: number;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("de") ? "de" : "en";
  const present = size === "present";
  // Dark theme only in the management UI; the beamer stays light.
  const dk = (classes: string) => (present ? "" : classes);
  const shown = limit ? entries.slice(0, limit) : entries;
  if (shown.length === 0)
    return (
      <p data-testid="matrix-ranking" className={`text-slate-500 ${dk("dark:text-slate-400")}`}>
        {t("No ratings yet.")}
      </p>
    );

  const withCategories = settings.category_mode !== "off" && settings.categories.length > 0;
  const catHex = (key: string) =>
    withCategories && settings.categories.some((c) => c.key === key) ? paletteEntry(key)?.hex : undefined;
  const catName = (key: string) => {
    if (!withCategories) return "";
    if (!settings.categories.some((c) => c.key === key)) return t("no category");
    const label = categoryLabel(settings.categories, key, settings.category_mode, lang, t);
    return label.name || label.a11y;
  };
  const points = (e: MatrixRankingEntry) => ("points" in e ? e.points : 0);
  const counts = (e: MatrixRankingEntry) => ("up" in e ? e : { up: 0, down: 0, balance: 0 });
  const max = Math.max(
    1,
    ...entries.map((e) => (mode === "points" ? points(e) : counts(e).up + counts(e).down)),
  );
  const more =
    limit && entries.length > limit ? (
      <p className={`text-slate-500 ${present ? "text-base" : "text-xs"} ${dk("dark:text-slate-400")}`}>
        {t("More rated cards: {{n}}", { n: entries.length - limit })}
      </p>
    ) : null;

  return (
    <div data-testid="matrix-ranking" className={present ? "space-y-5" : "space-y-3"}>
      <ol aria-label={t("Ranking")} className={present ? "space-y-5" : "space-y-3"}>
        {shown.map((e, i) => {
          const hex = catHex(e.category) ?? NO_CATEGORY_GREY;
          const meta = [catName(e.category), matrixZoneName(e.zone, settings.axes, t)].filter(Boolean).join(" · ");
          const c = counts(e);
          const sign = c.balance > 0 ? "+" : c.balance < 0 ? "−" : "±";
          return (
            <li key={e.id} data-ranking-row="">
              <div className={`mb-1.5 flex items-center ${present ? "gap-3" : "gap-2"}`}>
                <span
                  aria-hidden
                  className={`inline-flex shrink-0 items-center justify-center rounded-md font-bold tabular-nums ${
                    present ? "h-9 w-9 text-lg" : "h-6 w-6 text-xs"
                  }`}
                  style={{ background: hex, color: readableOn(hex) }}
                >
                  {i + 1}
                </span>
                <span className="sr-only">{t("Rank {{n}}", { n: i + 1 })}: </span>
                <div className="min-w-0 flex-1">
                  <span
                    data-ranking-title=""
                    className={`block font-semibold leading-tight text-slate-900 [overflow-wrap:anywhere] ${
                      present ? "text-2xl" : "text-sm"
                    } ${dk("dark:text-slate-100")}`}
                  >
                    {e.title}
                  </span>
                  {meta && (
                    <span className={`block text-slate-600 ${present ? "text-lg" : "text-xs"} ${dk("dark:text-slate-300")}`}>
                      {meta}
                    </span>
                  )}
                </div>
                {mode === "points" ? (
                  <span
                    className={`shrink-0 whitespace-nowrap font-bold tabular-nums text-slate-900 ${
                      present ? "text-2xl" : "text-sm"
                    } ${dk("dark:text-slate-100")}`}
                  >
                    {t("{{count}} points", { count: points(e) })}
                  </span>
                ) : (
                  <span className="sr-only">{t("{{up}} plus, {{down}} minus, balance {{balance}}", c)}</span>
                )}
                {mode !== "points" && (
                  <span
                    aria-hidden
                    className={`shrink-0 whitespace-nowrap font-bold tabular-nums ${present ? "text-2xl" : "text-sm"}`}
                  >
                    <span style={{ color: UP_INK }}>+{c.up}</span>
                    <span className="text-slate-500"> / </span>
                    <span style={{ color: DOWN_INK }}>−{c.down}</span>
                    <span
                      className={`ml-2 inline-block rounded-full px-2 text-slate-900 ${present ? "" : "text-xs"}`}
                      style={{ background: c.balance > 0 ? UP : c.balance < 0 ? DOWN : "#e2e8f0" }}
                    >
                      {sign}
                      {Math.abs(c.balance)}
                    </span>
                  </span>
                )}
              </div>
              <div
                aria-hidden
                className={`relative overflow-hidden bg-slate-100 ${dk("dark:bg-slate-800")}`}
                style={{ height: present ? 18 : 10, borderRadius: present ? 9 : 5 }}
              >
                {mode === "points" ? (
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{ width: `${((points(e) / max) * 100).toFixed(1)}%`, background: hex }}
                  />
                ) : (
                  <>
                    <div
                      className="absolute inset-y-0 left-0"
                      style={{ width: `${((c.up / max) * 100).toFixed(1)}%`, background: UP }}
                    />
                    <div
                      className="absolute inset-y-0 right-0"
                      style={{ width: `${((c.down / max) * 100).toFixed(1)}%`, background: DOWN }}
                    />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {more}
    </div>
  );
}
