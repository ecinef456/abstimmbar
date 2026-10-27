// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** One answer's result bar: letter tile, label, value and a growing fill.
 * `state` drives the reveal colouring (green correct, rosé wrong, palette
 * otherwise). Shared by the presenter (size "present", animated) and the
 * results page (size "compact"). */
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { API_BASE_URL } from "../api";
import CountUp from "./CountUp";
import { EASE, STAGGER_MS, useGrown, useReducedMotion, useSettled } from "./motion";
import {
  CORRECT,
  CORRECT_STRONG,
  CORRECT_TINT,
  INK,
  NEUTRAL_TILE,
  WRONG,
  WRONG_TINT,
  categoryColor,
  categoryTint,
} from "./palette";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type BarState = "neutral" | "correct" | "wrong";

export default function ResultBar({
  index,
  label,
  image,
  count,
  pct,
  state = "neutral",
  size = "present",
  animate = false,
  letter,
  color,
  before,
  beforeLabels,
}: {
  index: number;
  label: React.ReactNode;
  image?: string | null;
  count: number;
  pct: number;
  state?: BarState;
  size?: "present" | "compact";
  animate?: boolean;
  letter?: string | null;
  color?: string;
  before?: { count: number; pct: number } | null;
  /** quizbar (fork): other labels for the two bars (e.g. "Vote 1" / "Vote 2"). */
  beforeLabels?: [string, string];
}) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const anim = animate && !reduced;
  const grown = useGrown(anim);
  // Stagger only the entrance; afterwards live updates move immediately.
  const settled = useSettled(anim, index * STAGGER_MS + 1400);
  const d = anim && !settled ? index * STAGGER_MS : 0;
  const present = size === "present";
  const tile = letter === undefined ? LETTERS[index] : letter;

  const fill = state === "correct" ? CORRECT : state === "wrong" ? WRONG : (color ?? categoryColor(index));
  const tint = state === "correct" ? CORRECT_TINT : state === "wrong" ? WRONG_TINT : categoryTint(index);
  const tileBg = state === "correct" ? CORRECT_STRONG : state === "wrong" ? NEUTRAL_TILE : fill;
  const tileInk = state === "correct" ? "white" : INK;

  const darkTrack = present ? "" : " dark:bg-slate-800";
  const darkText = present ? "" : " dark:text-slate-400";
  const trackH = present ? 34 : 20;
  const radius = present ? 10 : 6;
  const track = (value: number, background: string, delay: number) => (
    <div className={`flex-1 bg-slate-100${darkTrack}`} style={{ height: trackH, borderRadius: radius }}>
      <div
        style={{
          height: "100%",
          borderRadius: radius,
          width: `${grown ? value : 0}%`,
          background,
          transition: `width 900ms ${EASE} ${delay}ms, background-color 500ms`,
        }}
      />
    </div>
  );

  return (
    <div>
      <div className={`mb-1 flex items-center gap-2.5 ${present ? "text-xl" : "text-sm"}`}>
        {tile && (
          <span
            aria-hidden
            className={`inline-flex shrink-0 items-center justify-center rounded-md font-bold ${present ? "h-7 w-7 text-sm" : "h-5 w-5 text-[11px]"}`}
            style={{ background: tileBg, color: tileInk, transition: "background-color 500ms" }}
          >
            {tile}
          </span>
        )}
        {image && (
          <img src={`${API_BASE_URL}${image}`} alt="" className="max-h-12 rounded-lg" />
        )}
        <span
          className={`min-w-0 [overflow-wrap:anywhere] ${state === "correct" ? "font-bold" : ""} ${state === "wrong" ? `text-slate-500${darkText}` : ""}`}
        >
          {label}
        </span>
        {state === "correct" && (
          <span
            className={`ab-pop inline-flex shrink-0 items-center gap-1 rounded-full font-bold text-white ${present ? "px-2.5 py-0.5 text-sm" : "px-2 py-px text-[11px]"}`}
            style={{ background: CORRECT_STRONG }}
          >
            <Check aria-hidden className={present ? "h-4 w-4" : "h-3 w-3"} strokeWidth={3} />
            {t("Correct")}
          </span>
        )}
        {!before && (
          <span className={`ml-auto shrink-0 whitespace-nowrap tabular-nums text-slate-500${darkText}`}>
            {count} · <CountUp value={pct} animate={anim} delay={d} />
          </span>
        )}
      </div>
      {before ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-sm font-semibold uppercase tracking-wide text-slate-400">
              {beforeLabels?.[0] ?? t("Before")}
            </span>
            {track(before.pct, tint, d)}
            <span className={`w-28 text-right tabular-nums text-slate-500${darkText}`}>
              {before.count} · <CountUp value={before.pct} animate={anim} delay={d} />
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-sm font-semibold uppercase tracking-wide text-slate-400">
              {beforeLabels?.[1] ?? t("After")}
            </span>
            {track(pct, fill, anim && !settled ? d + 450 : 0)}
            <span className={`w-28 text-right tabular-nums text-slate-500${darkText}`}>
              {count} · <CountUp value={pct} animate={anim} delay={anim && !settled ? d + 450 : 0} />
            </span>
          </div>
        </div>
      ) : (
        <div className="flex">{track(pct, fill, d)}</div>
      )}
    </div>
  );
}
