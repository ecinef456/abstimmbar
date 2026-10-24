// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Ordering result: the correct sequence with, between neighbours, how many
 * kept them in a row, plus brackets for the longest correct chains. Shared by
 * the live presenter view and the walkthrough. */
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { localizedText } from "@basicbar/ui";
import type { OrderingResults } from "../api";
import { useCountUp, useReducedMotion } from "./motion";
import { MathText } from "../math";

export default function OrderingResult({
  ordering,
  animate = false,
}: {
  ordering: OrderingResults;
  animate?: boolean;
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const anim = animate && !reduced;
  const pct = useCountUp(ordering.full_correct_rate, { animate: anim });
  const delay = (i: number) => (anim ? { animationDelay: `${300 + i * 120}ms` } : undefined);

  return (
    <div className="mt-8">
      <p className="mb-4 text-xl font-semibold tabular-nums">
        {t("{{pct}}% got the full order correct", { pct })}
      </p>
      <div className="inline-grid gap-x-3" style={{ gridTemplateColumns: "max-content auto" }}>
        {ordering.items.flatMap((it, i) => {
          const link = ordering.links?.[i];
          const rows = [
            <div
              key={`item-${it.id}`}
              className="col-start-1 flex items-center gap-3 text-xl"
              style={{ gridRow: 2 * i + 1 }}
            >
              <span className="tabular-nums text-slate-400">{it.correct_position}.</span>
              <span><MathText text={localizedText(it.text)} /></span>
            </div>,
          ];
          if (link) {
            rows.push(
              <div
                key={`link-${it.id}`}
                className="ab-fade-in col-start-1 flex items-center justify-center py-1"
                style={{ gridRow: 2 * i + 2, ...delay(i) }}
              >
                {/* The rate drives the border strength only — fading the
                    text would drop it below 4.5:1 (#178). */}
                <span
                  className="rounded-full border border-brand-600/[var(--rate)] bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  style={{ "--rate": 0.15 + 0.85 * (link.rate / 100) } as CSSProperties}
                >
                  {t("{{pct}}% in a row", { pct: link.rate })}
                </span>
              </div>,
            );
          }
          return rows;
        })}
        {ordering.chains.map((c, idx) => (
          <div
            key={`chain-${idx}`}
            className="ab-fade-in col-start-2 flex items-center gap-2 pl-1"
            style={{ gridRow: `${2 * c.start + 1} / ${2 * c.end + 2}`, ...delay(idx) }}
          >
            <div className="h-full w-2 rounded-r-lg border-y-2 border-r-2 border-brand-400" />
            <span className="text-sm font-medium tabular-nums text-brand-700 dark:text-brand-300">
              {c.rate}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
