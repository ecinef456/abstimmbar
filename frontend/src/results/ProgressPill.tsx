// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Progress pill for the beamer's live counter: connected participants,
 * participants who have answered and — for item-based kinds (several terms,
 * mind map, matrix, rating stage) — items against the capacity
 * (participants × per-person limit). The pill fills from the left with a
 * light tint plus a thin full-colour bar along its bottom edge, coloured by
 * share (pastel red < 50 %, yellow ≤ 80 %, light green ≤ 95 %, dark green
 * above) and glowing once when it is full. Results stay hidden while voting;
 * this is the only live cue. The fill is decorative — the numbers carry the
 * meaning. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Check, Grid2x2, Star, Tags, ThumbsUp, Users, type LucideIcon } from "lucide-react";
import type { LiveCounter } from "../api";
import { EASE } from "./motion";

export function shareColor(share: number): string {
  if (share < 0.5) return "oklch(0.76 0.12 22)";
  if (share <= 0.8) return "oklch(0.86 0.13 95)";
  if (share <= 0.95) return "oklch(0.84 0.12 150)";
  return "oklch(0.60 0.14 150)";
}

/** Tint alpha behind the slate-700 numbers. Computed WCAG contrast at 18 %
 * over white: rose 9.0, yellow 9.6, light green 9.6, green 8.4 (all ≥ 4.5). */
const TINT = 0.18;

type Progress = LiveCounter;
type ProgressUnit = LiveCounter["unit"];

const UNITS: Record<Exclude<ProgressUnit, "answers">, { icon: LucideIcon; label: string }> = {
  terms: { icon: Tags, label: "Terms created of possible" },
  cards: { icon: Grid2x2, label: "Cards created of possible" },
  points: { icon: Star, label: "Points given of possible" },
  ratings: { icon: ThumbsUp, label: "Ratings given of possible" },
};

/** Share of the pill to fill: items of the capacity when there is one,
 * else answered of the connected (never above 1 — answers from tabs that
 * have since disconnected can outnumber the connected count). */
export function progressShare(participants: number, progress: Progress): {
  share: number;
  capacity: number | null;
} {
  const { answered, items, per_person } = progress;
  const capacity = items != null && per_person != null ? Math.max(participants, answered) * per_person : null;
  const share = capacity
    ? Math.min(1, (items ?? 0) / capacity)
    : answered / Math.max(participants, answered, 1);
  return { share, capacity };
}

export default function ProgressPill({
  participants,
  progress,
  answeredLabel,
  className = "relative",
}: {
  participants: number;
  progress: Progress;
  /** Tooltip of the answered count (default: participants who have answered). */
  answeredLabel?: string;
  /** Positioning (must establish a containing block, e.g. `fixed …`). */
  className?: string;
}) {
  const { t } = useTranslation();
  const { share, capacity } = progressShare(participants, progress);
  const complete = share >= 1 && (progress.items ?? progress.answered) > 0;
  // Glow once on the transition to 100 % (not on every re-render at 100 %).
  const wasComplete = useRef(complete);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (complete && !wasComplete.current) setFlash((n) => n + 1);
    wasComplete.current = complete;
  }, [complete]);
  const color = shareColor(share);
  const grow: CSSProperties = {
    width: `${share * 100}%`,
    transition: `width 600ms ${EASE}, background-color 500ms`,
  };
  const unit = progress.items != null && progress.unit !== "answers" ? UNITS[progress.unit] : null;
  const UnitIcon = unit?.icon;
  return (
    <div
      className={`flex items-center gap-3 rounded-full border border-slate-200 bg-white/90 px-3 py-1.5 text-sm text-slate-700 shadow-sm backdrop-blur ${className}`}
      role="group"
      aria-label={t("Participation")}
      aria-live="polite"
      data-testid="live-stats"
      data-share={share.toFixed(2)}
      data-beamer-inset=""
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
        <span
          data-progress-fill=""
          className="absolute inset-y-0 left-0"
          style={{ ...grow, backgroundColor: `color-mix(in oklab, ${color} ${TINT * 100}%, transparent)` }}
        />
        <span
          data-progress-bar=""
          className="absolute bottom-0 left-0 h-[3px]"
          style={{ ...grow, backgroundColor: color }}
        />
      </span>
      {flash > 0 && (
        <span
          key={flash}
          aria-hidden
          className="ab-fill-flash pointer-events-none absolute inset-0 rounded-full"
          style={{ "--ab-fill": color } as CSSProperties}
        />
      )}
      <span className="relative flex items-center gap-1.5" title={t("Connected participants")}>
        <Users aria-hidden className="h-4 w-4 text-slate-500" />
        <span className="min-w-[2ch] tabular-nums">{participants}</span>
        <span className="sr-only">{t("Connected participants")}</span>
      </span>
      <span className="relative flex items-center gap-1.5" title={answeredLabel ?? t("Participants who have answered")}>
        <Check aria-hidden className="h-4 w-4 text-slate-500" />
        <span className="min-w-[2ch] tabular-nums">{progress.answered}</span>
        <span className="sr-only">{answeredLabel ?? t("Participants who have answered")}</span>
      </span>
      {unit && UnitIcon && (
        <span className="relative flex items-center gap-1.5" title={t(unit.label)} data-progress-items="">
          <UnitIcon aria-hidden className="h-4 w-4 text-slate-500" />
          <span className="min-w-[5ch] tabular-nums">
            {capacity ? `${progress.items} / ${capacity}` : progress.items}
          </span>
          <span className="sr-only">{t(unit.label)}</span>
        </span>
      )}
    </div>
  );
}
