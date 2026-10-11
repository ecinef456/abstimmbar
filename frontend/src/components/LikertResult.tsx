// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Diverging Likert result bar (#86): the ordered scale as a single stacked
 * bar — the low (negative) pole in pastel rosé to the left, the high (positive)
 * pole in pastel green to the right (L1 palette), an optional neutral step in grey. The two
 * endpoint labels caption the ends. A centre line marks the intensity-weighted
 * mean (mean_pct) — it weights each vote by how extreme its step is, so it
 * leans toward the heavier / more extreme side rather than the plain count
 * split. Percentages are over the scale responses; abstentions sit apart.
 * Shared by the presentation (beamer) and the results page. */
import { useTranslation } from "react-i18next";
import type { LikertStep, LikertSummary } from "../api";
import { localizedText } from "@basicbar/ui";
import CountUp from "../results/CountUp";
import { EASE, useGrown, useReducedMotion, useSettled } from "../results/motion";
import { INK, likertFill } from "../results/palette";

interface Colored extends LikertStep {
  fill: string;
}

function colorize(steps: LikertStep[]): Colored[] {
  const low = steps.filter((s) => s.polarity === "low").length;
  const high = steps.filter((s) => s.polarity === "high").length;
  let lSeen = 0;
  let hSeen = 0;
  return steps.map((step) => {
    let group = 1;
    let rank = 0;
    if (step.polarity === "low") {
      group = low;
      rank = low - 1 - lSeen; // innermost low step ranks 0
      lSeen += 1;
    } else if (step.polarity === "high") {
      group = high;
      rank = hSeen; // innermost high step ranks 0
      hSeen += 1;
    }
    return { ...step, fill: likertFill(step.polarity, group, rank) };
  });
}

export default function LikertResult({
  summary,
  variant = "present",
  animate = false,
  muted = false,
}: {
  summary: LikertSummary;
  variant?: "present" | "compact";
  animate?: boolean;
  /** Fade the bar colours (e.g. a "before" comparison) — the text and the
   *  mean marker keep their full contrast (#178). */
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const present = variant === "present";
  const reduced = useReducedMotion();
  const anim = animate && !reduced;
  const grown = useGrown(anim);
  // Stagger only the entrance; afterwards live updates move immediately.
  const settled = useSettled(anim, 1500);
  const entrance = anim && !settled;
  const steps = colorize(summary.steps);
  const labelThreshold = present ? 7 : Infinity; // %-width needed to show a % inside

  if (summary.scale_total === 0) {
    return (
      <p className={present ? "mt-8 text-slate-400" : "text-sm text-slate-400"}>
        {t("No answers yet …")}
      </p>
    );
  }

  return (
    // Compact: reserve the height of the "⌀" mean marker (-top-4 above the
    // bar) so it never paints over the question heading above (#179).
    <div className={present ? "mt-8" : "pt-3"}>
      <div className="relative">
        <div
          className={`relative flex overflow-hidden ${present ? "h-11 rounded-xl text-base" : "h-6 rounded-md text-[11px]"}`}
        >
          {steps.map((step, i) => (
            <div
              key={step.id}
              className="flex min-w-0 items-center justify-center overflow-hidden whitespace-nowrap tabular-nums"
              style={{
                flex: `0 0 ${grown ? step.pct : 0}%`,
                background: muted ? `color-mix(in oklch, ${step.fill} 55%, transparent)` : step.fill,
                color: INK,
                transition: `flex-basis 900ms ${EASE} ${entrance ? i * 90 : 0}ms`,
              }}
              title={`${localizedText(step.text)}: ${step.count} · ${step.pct} %`}
            >
              {step.pct >= labelThreshold && (
                <CountUp value={Math.round(step.pct)} animate={anim} delay={entrance ? i * 90 : 0} />
              )}
            </div>
          ))}
        </div>
        {/* Mean marker: the intensity-weighted central tendency (mean_pct), not
            the plain 50:50 count split — so it leans toward the heavier / more
            extreme side. Lives in this un-clipped wrapper (the bar itself is
            overflow-hidden to clip its rounded segments) so it can stick out a
            little above and below the bar. */}
        <div
          className={`pointer-events-none absolute w-0.5 -translate-x-1/2 rounded-full bg-slate-900 dark:bg-slate-100 ${present ? "-top-2 -bottom-2" : "-top-1.5 -bottom-1.5"}`}
          style={{
            left: `${summary.mean_pct}%`,
            opacity: grown ? 0.8 : 0,
            transition: `opacity 400ms ${entrance ? 900 : 0}ms`,
          }}
        >
          <span
            className={`absolute left-1/2 -translate-x-1/2 font-semibold text-slate-700 dark:text-slate-200 ${present ? "-top-6 text-sm" : "-top-4 text-[10px]"}`}
          >
            ⌀
          </span>
        </div>
      </div>

      {present && (
        // Legend: the endpoint labels caption the far ends, the per-step colour
        // dots with their counts sit between them (intermediate steps carry no
        // text of their own, only the colour).
        <div className="mt-3 flex items-center gap-4 text-sm text-slate-600 dark:text-slate-300">
          <span className="shrink-0">
            {localizedText(summary.low_label) ? `← ${localizedText(summary.low_label)}` : "←"}
          </span>
          <div className="flex flex-1 flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
            {steps.map((step) => (
              <span key={step.id} className="flex items-center gap-1.5 tabular-nums" title={localizedText(step.text)}>
                <span className="inline-block h-3 w-3 rounded" style={{ background: step.fill }} />
                {step.count}
              </span>
            ))}
          </div>
          <span className="shrink-0">
            {localizedText(summary.high_label) ? `${localizedText(summary.high_label)} →` : "→"}
          </span>
        </div>
      )}

      <div
        className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${present ? "mt-4 border-t border-slate-200 pt-3 text-lg dark:border-slate-700" : "mt-2 text-xs"}`}
      >
        {/* Left→right to match the bar: low (red) first, then neutral, then
            high (green) — so "Stimme nicht zu" reads on the left. */}
        <span className="text-rose-700 dark:text-rose-300">
          <span className="font-semibold">{summary.low_pct} %</span>{" "}
          {localizedText(summary.low_label) || t("low")}
        </span>
        {summary.neutral > 0 && (
          <span className="text-slate-500 dark:text-slate-400">
            <span className="font-semibold">{summary.neutral_pct} %</span> {t("neutral")}
          </span>
        )}
        <span className="text-brand-700 dark:text-brand-300">
          <span className="font-semibold">{summary.high_pct} %</span>{" "}
          {localizedText(summary.high_label) || t("high")}
        </span>
        {summary.abstentions > 0 && (
          <span className="ml-auto text-slate-400">
            {summary.abstentions}{" "}
            {t("abstention", { count: summary.abstentions })}
          </span>
        )}
      </div>
    </div>
  );
}
