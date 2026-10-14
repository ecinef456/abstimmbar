// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** The four-field matrix board (beamer + results view).
 *
 *  Pure rendering from props: a square-ish plot (16:9 in `present` mode,
 *  `RESULTS_ASPECT` in `results` mode) with four lightly tinted fields, the
 *  two axis lines, the four axis-end labels (inside the board, next to the
 *  line ends), the cards, and a category legend (bottom right, only with
 *  categories).
 *
 *  Cards are individually addressable (`data-card-id`) and positioned
 *  absolutely from their (x, y) via `toPixel` on the measured plot box
 *  (`data-matrix-board`), centred on the point. A stack renders once, at its
 *  top's position, with a stacked-paper look and a "×n" badge. Hidden cards
 *  are omitted in `present` mode and shown with an "hidden" marker in
 *  `results` mode (no opacity: the text must stay readable).
 *
 *  Tolerance (questions stay editable after cards exist): an edge card with
 *  edges now off still sits on its axis line (stored x/y); a card whose
 *  category no longer exists gets a neutral grey bar and "no category".
 *
 *  `interactive` is the hook for the presenter's drag/stack/open handlers;
 *  without it the board is read-only. The beamer is always light. */
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { EyeOff } from "lucide-react";
import { localizedText } from "@basicbar/ui";
import type { MatrixBoard, MatrixCard, MatrixSettingsPayload } from "../api";
import { categoryLabel, paletteEntry } from "../matrixPalette";
import { toPixel, type Box } from "./matrixGeometry";
import { useReducedMotion } from "./motion";

export interface MatrixInteraction {
  onMove(cardId: number, x: number, y: number): void;
  onStack(cardId: number, ontoId: number): void;
  onOpen(cardId: number): void;
}

export interface MatrixProps {
  board: MatrixBoard;
  settings: MatrixSettingsPayload;
  mode: "present" | "results";
  /** Detailed: descriptions shown on the cards. */
  detailed: boolean;
  /** Text scale of the cards (1 = default). */
  zoom?: number;
  /** Categories switched off in the legend (their cards are not drawn). */
  hiddenCategories?: Set<string>;
  onToggleCategory?(key: string): void;
  interactive?: MatrixInteraction;
}

/** Plot aspect ratio (w/h) of the results view. */
const RESULTS_ASPECT = 5 / 4;
const NO_CATEGORY_GREY = "#94a3b8";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A zone's written-out name, composed like the participant page (`mxZoneName`):
 *  the x part first ("nützlich & modern"); edges read "between A and B". */
export function matrixZoneName(
  zone: string,
  axes: MatrixSettingsPayload["axes"],
  t: Translate,
): string {
  const xt = localizedText(axes.x_to);
  const xf = localizedText(axes.x_from);
  const yt = localizedText(axes.y_to);
  const yf = localizedText(axes.y_from);
  const q = { q1: `${xt} & ${yt}`, q2: `${xf} & ${yt}`, q3: `${xf} & ${yf}`, q4: `${xt} & ${yf}` };
  const between = (a: keyof typeof q, b: keyof typeof q) =>
    t("between {{a}} and {{b}}", { a: q[a], b: q[b] });
  switch (zone) {
    case "e_top": return between("q2", "q1");
    case "e_right": return between("q1", "q4");
    case "e_bottom": return between("q3", "q4");
    case "e_left": return between("q2", "q3");
    default: return q[zone as keyof typeof q] ?? zone;
  }
}

export interface MatrixStack {
  card: MatrixCard;
  /** Members stacked under `card` (already in board order). */
  members: MatrixCard[];
}

/** The tops (loose cards are stacks of one) with their members. A member
 *  whose top is missing counts as a top. */
export function matrixStacks(cards: MatrixCard[]): MatrixStack[] {
  const ids = new Set(cards.map((c) => c.id));
  const members = new Map<number, MatrixCard[]>();
  const tops: MatrixCard[] = [];
  for (const card of cards) {
    if (card.stack != null && ids.has(card.stack)) {
      members.set(card.stack, [...(members.get(card.stack) ?? []), card]);
    } else {
      tops.push(card);
    }
  }
  return tops.map((card) => ({ card, members: members.get(card.id) ?? [] }));
}

/** Size of the stack as shown in the "×n" badge: the top plus its members
 *  that were not hidden individually. */
export const stackSize = (stack: MatrixStack) =>
  1 + stack.members.filter((m) => !m.hidden).length;

function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      setBox((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, box] as const;
}

export default function Matrix({
  board,
  settings,
  mode,
  detailed,
  zoom = 1,
  hiddenCategories,
  onToggleCategory,
  interactive,
}: MatrixProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("de") ? "de" : "en";
  const reduced = useReducedMotion();
  const [plotRef, box] = useBox<HTMLDivElement>();
  const results = mode === "results";
  // Dark theme only in the management UI; the beamer stays light.
  const dk = (classes: string) => (results ? classes : "");

  const categories = settings.categories;
  const categoryMode = settings.category_mode;
  const knownCategory = (key: string) => categories.some((c) => c.key === key);

  const visibleCards = board.cards.filter((c) => !hiddenCategories?.has(c.category));
  const hiddenIds = new Set(visibleCards.filter((c) => c.hidden).map((c) => c.id));
  const stacks = matrixStacks(visibleCards).filter(
    // Present mode: moderated cards are gone (a hidden top takes its members).
    (s) => results || !(s.card.hidden || hiddenIds.has(s.card.id)),
  );

  const label = (c: MatrixCard) => {
    if (categoryMode === "off") return { short: "", name: "", a11y: "" };
    if (!knownCategory(c.category)) return { short: "", name: "", a11y: t("no category") };
    return categoryLabel(categories, c.category, categoryMode, lang, t);
  };

  const tint = {
    q1: "bg-[#f5fbf6]",
    q2: "bg-[#f6f8ff]",
    q3: "bg-[#fbf7f3]",
    q4: "bg-[#f8f6fb]",
  };
  const axisLine = `bg-slate-500 ${dk("dark:bg-slate-400")}`;
  const axisLabel = `absolute rounded bg-white px-1.5 py-px text-[0.7rem] font-semibold text-slate-700 [overflow-wrap:anywhere] max-w-[40%] ${dk(
    "dark:bg-slate-900 dark:text-slate-200",
  )}`;
  const axisStyle: CSSProperties = { fontSize: `${0.7 * zoom}rem` };

  return (
    <div className="flex w-full flex-col">
      <div
        ref={plotRef}
        data-matrix-board
        className={`relative w-full select-none rounded-lg border border-slate-300 ${dk("dark:border-slate-600")} ${
          results ? "" : "aspect-video"
        }`}
        style={results ? { aspectRatio: RESULTS_ASPECT } : undefined}
      >
        <div aria-hidden className="absolute inset-0 overflow-hidden rounded-[inherit]">
          {(["q2", "q1", "q3", "q4"] as const).map((q) => (
            <div
              key={q}
              className={`absolute h-1/2 w-1/2 ${tint[q]} ${dk("dark:bg-white/[0.04]")}`}
              style={{ left: q === "q2" || q === "q3" ? 0 : "50%", top: q === "q2" || q === "q1" ? 0 : "50%" }}
            />
          ))}
          <div className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 ${axisLine}`} />
          <div className={`absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 ${axisLine}`} />
        </div>

        <span className={`${axisLabel} left-1 top-[calc(50%+6px)]`} style={axisStyle} data-axis="x_from">
          ← {localizedText(settings.axes.x_from)}
        </span>
        <span className={`${axisLabel} right-1 top-[calc(50%+6px)] text-right`} style={axisStyle} data-axis="x_to">
          {localizedText(settings.axes.x_to)} →
        </span>
        <span className={`${axisLabel} left-[calc(50%+6px)] top-1`} style={axisStyle} data-axis="y_to">
          ↑ {localizedText(settings.axes.y_to)}
        </span>
        <span className={`${axisLabel} bottom-1 left-[calc(50%+6px)]`} style={axisStyle} data-axis="y_from">
          ↓ {localizedText(settings.axes.y_from)}
        </span>

        {box &&
          stacks.map((stack) => {
            const { card } = stack;
            const [px, py] = toPixel(card.x, card.y, box);
            const n = stackSize(stack);
            const cat = label(card);
            const hex = !categoryMode || categoryMode === "off"
              ? NO_CATEGORY_GREY
              : (knownCategory(card.category) && paletteEntry(card.category)?.hex) || NO_CATEGORY_GREY;
            const isHidden = card.hidden;
            const zoneName = matrixZoneName(card.zone, settings.axes, t);
            const Tag = interactive ? "button" : "div";
            return (
              <Tag
                key={card.id}
                {...(interactive ? { type: "button" as const } : {})}
                data-card-id={card.id}
                data-zone={card.zone}
                data-stack-size={n}
                data-hidden={isHidden ? "true" : undefined}
                className={`absolute max-w-[22%] -translate-x-1/2 -translate-y-1/2 rounded-md border-l-[5px] px-2 py-1 text-left leading-tight ${
                  isHidden
                    ? `border-y border-r border-dashed border-slate-400 bg-slate-100 text-slate-600 ${dk(
                        "dark:border-slate-500 dark:bg-slate-900 dark:text-slate-300",
                      )}`
                    : `bg-white text-slate-900 shadow-[0_1px_3px_rgba(0,0,0,.25)] ${dk("dark:bg-slate-800 dark:text-slate-100")}`
                }`}
                style={{
                  left: px,
                  top: py,
                  borderLeftColor: hex,
                  fontSize: `${0.75 * zoom}rem`,
                  transition: reduced ? "none" : "left .25s ease, top .25s ease",
                  ...(n > 1
                    ? { boxShadow: "3px 3px 0 #ddd, 6px 6px 0 #ccc, 0 1px 3px rgba(0,0,0,.25)" }
                    : null),
                }}
              >
                <span className="flex items-start gap-1">
                  {cat.short && (
                    <span aria-hidden className="font-bold text-slate-700 dark:text-slate-300">
                      {cat.short}
                    </span>
                  )}
                  <span className="line-clamp-2 min-w-0 font-semibold [overflow-wrap:anywhere]">{card.title}</span>
                  {n > 1 && (
                    <span
                      data-testid="matrix-stack-badge"
                      className="ml-auto flex-none rounded-full bg-slate-800 px-1.5 text-[0.65em] font-semibold text-white"
                    >
                      ×{n}
                    </span>
                  )}
                </span>
                {detailed && card.description && (
                  <span className={`mt-0.5 line-clamp-3 block text-[0.85em] text-slate-600 [overflow-wrap:anywhere] ${dk("dark:text-slate-300")}`}>
                    {card.description}
                  </span>
                )}
                {isHidden && (
                  <span data-testid="matrix-hidden-marker" className="mt-0.5 flex items-center gap-1 text-[0.8em] font-medium">
                    <EyeOff aria-hidden className="h-3 w-3" />
                    {t("hidden")}
                  </span>
                )}
                <span className="sr-only">
                  {` – ${[cat.a11y, zoneName].filter(Boolean).join(", ")}`}
                </span>
              </Tag>
            );
          })}

        {categoryMode !== "off" && categories.length > 0 && (
          <ul
            aria-label={t("Categories")}
            className={`absolute bottom-1.5 right-2 flex flex-wrap justify-end gap-x-2 gap-y-0.5 rounded bg-white/90 px-1.5 py-0.5 text-[0.7rem] text-slate-700 ${dk(
              "dark:bg-slate-900/90 dark:text-slate-200",
            )}`}
            style={{ fontSize: `${0.7 * zoom}rem` }}
            data-testid="matrix-legend"
          >
            {categories.map((c) => {
              const cat = categoryLabel(categories, c.key, categoryMode, lang, t);
              const off = hiddenCategories?.has(c.key) ?? false;
              const content = (
                <>
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full border"
                    style={{
                      background: off ? "transparent" : paletteEntry(c.key)?.hex,
                      borderColor: paletteEntry(c.key)?.hex,
                    }}
                  />
                  <span className={off ? "line-through" : ""}>{cat.name || cat.short}</span>
                </>
              );
              return (
                <li key={c.key}>
                  {onToggleCategory ? (
                    <button
                      type="button"
                      aria-pressed={!off}
                      aria-label={cat.name || cat.a11y}
                      onClick={() => onToggleCategory(c.key)}
                      className="inline-flex items-center gap-1 rounded hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                    >
                      {content}
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1">{content}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
