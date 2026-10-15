// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** The four-field matrix board (beamer + results view).
 *
 *  Pure rendering from props: a square-ish plot (16:9 in `present` mode,
 *  `RESULTS_ASPECT` in `results` mode) with four lightly tinted fields, the
 *  two axis lines, the four axis-end labels (outside the plot; the x ends
 *  run vertically), the cards, and a category legend (bottom right, only
 *  with categories).
 *
 *  Cards: a full-colour category tab (colours mode: with the letter in white
 *  or near-black) and a body tinted with the same colour. Their type size
 *  follows the plot width (beamer-sized) and shrinks when a quadrant gets
 *  crowded (`matrixCardFont`). Overlapping cards are nudged apart where
 *  they are drawn (`relaxCards`, within their zone; stored x/y unchanged).
 *  The presenter zooms the whole board around it (MatrixPanel); with
 *  `onZoomQuadrant` each quadrant gets a small magnifier in its outer corner.
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
 *  `interactive` (presenter): cards become buttons in reading order (zone,
 *  then position). Pointer drag follows the pointer (board point =
 *  `fromPixel` of the pointer on the plot box, never an offset from the
 *  clamped drawing) and lights up the zone the card would land in (client
 *  `resolveZone` with hysteresis) — or, over another card, that card as the
 *  stack target. A click without movement opens the card; arrow keys move
 *  it in small steps (Shift: larger). Newly arrived cards flash briefly
 *  (not with reduced motion). The beamer is always light.
 *
 *  Rating (`rating` with scores): every rated visible top card gets a score
 *  row at the bottom of its body — a fill bar (points: category colour,
 *  relative to the best card; plus/minus: green from the left, rosé from
 *  the right, relative to the most-rated card) and the score as text, which
 *  stays on the card tint (contrast). Unrated cards are unchanged; nothing
 *  grows with the score. `interactive.stackLocked`: a drop onto a card only
 *  moves (no stack target). */
import {
  createElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { EyeOff, ZoomIn } from "lucide-react";
import { localizedText } from "@basicbar/ui";
import type { MatrixBoard, MatrixCard, MatrixRating, MatrixScore, MatrixSettingsPayload } from "../api";
import { categoryLabel, mixHex, paletteEntry, readableOn } from "../matrixPalette";
import { fromPixel, resolveZone, toPixel, zoneRect, type Box, type Zone } from "./matrixGeometry";
import { relaxCards, type LayoutItem } from "./matrixLayout";
import { useReducedMotion } from "./motion";
import { CORRECT as UP, MINUS as DOWN } from "./palette";

/** Plus / minus counts as text on a tinted card body (≥ 4.5:1 on every
 *  category tint; the palette's CORRECT_STRONG / MINUS_INK are too light), as
 *  Tailwind classes with a light variant for dark surfaces (management UI
 *  only: pass `dark` false on the beamer, which stays light). */
export const matrixUpInkClass = (dark: boolean) =>
  `text-[oklch(0.45_0.13_150)] ${dark ? "dark:text-[oklch(0.82_0.15_150)]" : ""}`;
export const matrixDownInkClass = (dark: boolean) =>
  `text-[oklch(0.45_0.15_20)] ${dark ? "dark:text-[oklch(0.82_0.13_20)]" : ""}`;

export interface MatrixInteraction {
  /** Drop / arrow key at board point (x, y) — unclamped; the server resolves
   *  zone (hysteresis) and position. */
  onMove(cardId: number, x: number, y: number, via: "pointer" | "keyboard"): Promise<unknown> | void;
  onStack(cardId: number, ontoId: number): void;
  onOpen(cardId: number, byKeyboard: boolean): void;
  /** Rating stage: stacks are locked — a drop onto a card only moves it. */
  stackLocked?: boolean;
}

export interface MatrixProps {
  board: MatrixBoard;
  settings: MatrixSettingsPayload;
  mode: "present" | "results";
  /** Detailed: descriptions shown on the cards. */
  detailed: boolean;
  /** Present mode: a magnifier per quadrant zooms the view onto it. */
  onZoomQuadrant?(quadrant: "q1" | "q2" | "q3" | "q4"): void;
  /** A quadrant fills the view: its magnifiers are hidden (their space
   *  stays reserved, so no card moves). */
  quadrantFocused?: boolean;
  /** Categories switched off in the legend (their cards are not drawn). */
  hiddenCategories?: Set<string>;
  onToggleCategory?(key: string): void;
  /** `data-help` id of the legend (presenter "?" help). */
  legendHelp?: string;
  /** Present mode: also draw hidden cards (marked), to show them again. */
  showHidden?: boolean;
  interactive?: MatrixInteraction;
  /** Scores to draw on the cards (only when they are to be shown). */
  rating?: { mode: MatrixRating["mode"]; scores: Record<string, MatrixScore> };
}

/** Score row of one card: bar shares (0–1) and the text. */
interface ScoreLook {
  up: number;
  down: number;
  points?: number;
  counts?: { up: number; down: number };
}

/** Bar shares per rated card id: points relative to the best card,
 *  plus/minus (up and down) relative to the most-rated card. */
export function matrixScoreLooks(rating: MatrixProps["rating"]): Map<number, ScoreLook> {
  const out = new Map<number, ScoreLook>();
  if (!rating) return out;
  const entries = Object.entries(rating.scores).map(([k, v]) => [Number(k), v] as const);
  if (rating.mode === "points") {
    const max = Math.max(1, ...entries.map(([, v]) => ("points" in v ? v.points : 0)));
    for (const [id, v] of entries) {
      if (!("points" in v) || v.points <= 0) continue;
      out.set(id, { up: v.points / max, down: 0, points: v.points });
    }
  } else {
    const max = Math.max(1, ...entries.map(([, v]) => ("up" in v ? v.up + v.down : 0)));
    for (const [id, v] of entries) {
      if (!("up" in v) || v.up + v.down === 0) continue;
      out.set(id, { up: v.up / max, down: v.down / max, counts: { up: v.up, down: v.down } });
    }
  }
  return out;
}

/** Arrow-key step in board units (Shift: the larger one). */
const KEY_STEP = 0.05;
const KEY_STEP_LARGE = 0.2;
/** Pointer travel (px) before a press becomes a drag. */
const DRAG_SLOP = 4;
/** Reading order of the zones (tab order of the cards). */
const READING_ORDER = ["q2", "e_top", "q1", "e_left", "e_right", "q3", "e_bottom", "q4"];

interface DragState {
  id: number;
  /** Board point under the pointer (clipped to the board). */
  x: number;
  y: number;
  zone: Zone;
  /** The card (top) under the pointer: drop stacks onto it. */
  target: number | null;
}

/** Plot aspect ratio (w/h) of the results view. */
const RESULTS_ASPECT = 5 / 4;
const NO_CATEGORY_GREY = "#94a3b8";
/** Card bodies: a light tint of the category colour (dark: into slate-800). */
const TINT_LIGHT = 0.15;
const TINT_DARK = 0.28;
const SLATE_800 = "#1e293b";

/** Card type size (px) from the plot width: beamer-sized on the board,
 *  smaller in the management results view; phones stay compact. */
const CARD_FONT = {
  present: { perWidth: 0.017, min: 13, max: 26 },
  results: { perWidth: 0.017, min: 13, max: 18 },
  narrow: 12,
};
/** Rough card footprint in em (width × height; detailed cards are taller),
 *  for the crowding estimate. */
const CARD_EM = { width: 9, height: 2.6, heightDetailed: 4.4 };
/** Share of a quadrant the cards of its most crowded quadrant may cover
 *  before all cards are scaled down — never below FIT_MIN or MIN_FONT px. */
const COVERAGE = 0.18;
const FIT_MIN = 0.55;
const MIN_FONT = 12;

/** Font size (px, before zoom) of the cards: the plot-based size, scaled
 *  down by the load of the most crowded quadrant (an edge card counts half
 *  for both its neighbours). */
export function matrixCardFont(
  box: Box,
  zones: string[],
  opts: { mode: "present" | "results"; narrow: boolean; detailed: boolean },
): number {
  if (opts.narrow) return CARD_FONT.narrow;
  const spec = CARD_FONT[opts.mode];
  const base = Math.max(spec.min, Math.min(spec.max, box.width * spec.perWidth));
  const load: Record<string, number> = { q1: 0, q2: 0, q3: 0, q4: 0 };
  const neighbours: Record<string, string[]> = {
    e_top: ["q1", "q2"],
    e_right: ["q1", "q4"],
    e_bottom: ["q3", "q4"],
    e_left: ["q2", "q3"],
  };
  for (const zone of zones) {
    if (zone in load) load[zone] += 1;
    else for (const q of neighbours[zone] ?? []) load[q] += 0.5;
  }
  const crowd = Math.max(...Object.values(load));
  if (crowd === 0) return base;
  const card = CARD_EM.width * base * (opts.detailed ? CARD_EM.heightDetailed : CARD_EM.height) * base;
  const quadrant = (box.width * box.height) / 4;
  const fit = Math.max(FIT_MIN, Math.min(1, Math.sqrt((COVERAGE * quadrant) / (crowd * card))));
  return Math.max(Math.min(base, MIN_FONT), base * fit);
}

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
    // Layout size of the padding box (the cards' containing block) — not
    // getBoundingClientRect: the presenter scales the whole board with a
    // CSS transform.
    const update = () => {
      const { clientWidth: width, clientHeight: height } = el;
      setBox((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, box] as const;
}

/** Stacked-paper offset of a stack's look (px). */
const SHADOW = 6;
/** Side and inset of the quadrant magnifiers (px); cards keep clear. */
const MAGNIFIER = 30;
const MAGNIFIER_INSET = 6;

/** A card drawn at `left`/`top` (computed by the board from all measured
 *  card sizes); reports its own size. Until measured it is invisible and
 *  not animated (no slide-in from a provisional spot). */
function PlacedCard({
  tag,
  left,
  top,
  onSize,
  style,
  children,
  cardRef,
  ...rest
}: {
  tag: "div" | "button";
  cardRef?: (el: HTMLElement | null) => void;
  left: number | null;
  top: number | null;
  onSize(size: Box): void;
  style: CSSProperties;
  children: ReactNode;
  [attr: string]: unknown;
}) {
  const ref = useRef<HTMLElement>(null);
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = "";
    const update = () => {
      const { offsetWidth: width, offsetHeight: height } = el;
      const key = `${width}x${height}`;
      if (key === last) return;
      last = key;
      onSizeRef.current({ width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const placed = left != null && top != null;
  const [settled, setSettled] = useState(false);
  useLayoutEffect(() => {
    if (!placed || settled) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [placed, settled]);
  const setRef = (el: HTMLElement | null) => {
    (ref as { current: HTMLElement | null }).current = el;
    cardRef?.(el);
  };
  return createElement(
    tag,
    {
      ref: setRef,
      ...rest,
      style: {
        ...style,
        left: left ?? 0,
        top: top ?? 0,
        ...(placed ? null : { visibility: "hidden" }),
        ...(settled ? null : { transition: "none" }),
      },
    },
    children,
  );
}

export default function Matrix({
  board,
  settings,
  mode,
  detailed,
  hiddenCategories,
  onToggleCategory,
  legendHelp,
  showHidden = false,
  interactive,
  rating,
  onZoomQuadrant,
  quadrantFocused = false,
}: MatrixProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("de") ? "de" : "en";
  const reduced = useReducedMotion();
  const [plotRef, box] = useBox<HTMLDivElement>();
  const results = mode === "results";
  // The management board on a phone: titles only (the list below carries the
  // details); the beamer keeps its descriptions at any size.
  const narrow = results && box != null && box.width < 480;
  const showDescriptions = detailed && !narrow;
  // Dark theme only in the management UI; the beamer stays light.
  const dk = (classes: string) => (results ? classes : "");

  const categories = settings.categories;
  const categoryMode = settings.category_mode;
  const knownCategory = (key: string) => categories.some((c) => c.key === key);

  // Stacks come from the whole board: a member whose top is filtered out
  // (hidden card or category toggled off) must not be promoted to a top.
  const stacks = matrixStacks(board.cards)
    .filter(
      (s) =>
        !hiddenCategories?.has(s.card.category) &&
        // Present mode: moderated cards are gone (a hidden top takes its
        // members) — unless the presenter asked to see them.
        (results || showHidden || !s.card.hidden),
    )
    .sort(
      (a, b) =>
        READING_ORDER.indexOf(a.card.zone) - READING_ORDER.indexOf(b.card.zone) ||
        b.card.y - a.card.y ||
        a.card.x - b.card.x ||
        a.card.id - b.card.id,
    );

  // --- Newly arrived cards flash for ~1 s (present mode, not reduced). ---
  const seenRef = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(() => new Set());
  // One timer per arrival, cleared only on unmount: a second batch arriving
  // within the second must not cancel the first one's expiry.
  const freshTimers = useRef<Set<number>>(new Set());
  useEffect(() => {
    const timers = freshTimers.current;
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  const idsKey = board.cards.map((c) => c.id).join(",");
  useEffect(() => {
    const ids = new Set(board.cards.map((c) => c.id));
    const seen = seenRef.current;
    seenRef.current = ids;
    if (!seen || results || reduced) return;
    const added = [...ids].filter((id) => !seen.has(id));
    if (added.length === 0) return;
    setFresh((prev) => new Set([...prev, ...added]));
    const timer = window.setTimeout(() => {
      freshTimers.current.delete(timer);
      setFresh((prev) => new Set([...prev].filter((id) => !added.includes(id))));
    }, 1000);
    freshTimers.current.add(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // --- Dragging (pointer) ---
  const [drag, setDrag] = useState<DragState | null>(null);
  const press = useRef<{ id: number; zone: string; px: number; py: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const pointAt = (clientX: number, clientY: number): [number, number] | null => {
    const el = plotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const [x, y] = fromPixel(clientX - r.left, clientY - r.top, { width: r.width, height: r.height });
    const clip = (v: number) => Math.max(-1, Math.min(1, v));
    return [clip(x), clip(y)];
  };
  const targetAt = (clientX: number, clientY: number, self: number): number | null => {
    if (interactive?.stackLocked) return null;
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const hit = (el as HTMLElement).closest?.("[data-card-id]") as HTMLElement | null;
      if (!hit || !plotRef.current?.contains(hit)) continue;
      // A hidden card (shown to the presenter on request) is no stack target.
      if (hit.dataset.hidden === "true") continue;
      const id = Number(hit.dataset.cardId);
      if (id !== self) return id;
    }
    return null;
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, card: MatrixCard) => {
    if (!interactive || e.button !== 0) return;
    press.current = { id: card.id, zone: card.zone, px: e.clientX, py: e.clientY, moved: false };
    suppressClick.current = false;
    endKeyboardSession();
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.px, e.clientY - p.py) < DRAG_SLOP) return;
    p.moved = true;
    const point = pointAt(e.clientX, e.clientY);
    if (!point) return;
    const [x, y] = point;
    setDrag({
      id: p.id,
      x,
      y,
      zone: resolveZone(p.zone, x, y, settings.edges),
      target: targetAt(e.clientX, e.clientY, p.id),
    });
  };
  const endDrag = (e: ReactPointerEvent<HTMLElement>, drop: boolean) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.moved) {
      // The click that may follow the drop is not an "open" (browsers differ
      // on whether it fires at all after a captured drag).
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      if (drop && interactive) {
        const target = targetAt(e.clientX, e.clientY, p.id);
        const point = pointAt(e.clientX, e.clientY);
        if (target != null) interactive.onStack(p.id, target);
        else if (point) interactive.onMove(p.id, point[0], point[1], "pointer");
      }
    }
    setDrag(null);
  };

  // --- Keyboard: arrows push the card; the intended point accumulates while
  // the card keeps focus, so repeated presses can overcome the hysteresis
  // even though the server clamps the stored position back into the zone.
  const keyPoint = useRef<{ id: number; x: number; y: number } | null>(null);
  /** The card to give its focus back once its keyboard move has settled
   *  (one shot; the reading order may have moved it in the DOM). */
  const refocus = useRef<{ id: number; settled: boolean } | null>(null);
  const [, setSettledTick] = useState(0);
  const cardRefs = useRef(new Map<number, HTMLElement>());
  // Any pointer interaction ends the keyboard session: no stale push point,
  // no focus pulled back onto a card (a clicker's → must navigate again).
  const endKeyboardSession = () => {
    keyPoint.current = null;
    refocus.current = null;
  };
  useEffect(() => {
    if (!interactive) return;
    document.addEventListener("pointerdown", endKeyboardSession, true);
    return () => document.removeEventListener("pointerdown", endKeyboardSession, true);
  }, [interactive]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>, card: MatrixCard) => {
    if (!interactive) return;
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const delta: Record<string, [number, number]> = {
      ArrowRight: [step, 0],
      ArrowLeft: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    if (e.key === "Enter" || e.key === " ") {
      // Activates the button (opens the card) — never the presenter's
      // advance key.
      e.stopPropagation();
      return;
    }
    const d = delta[e.key];
    if (!d || e.altKey || e.ctrlKey || e.metaKey) return;
    // Only a keyboard-focused card takes the arrows; a card that merely got
    // focus from a click lets them navigate the presentation.
    if (!e.currentTarget.matches(":focus-visible")) return;
    e.preventDefault();
    e.stopPropagation(); // arrows move the card, they don't navigate questions
    const base = keyPoint.current?.id === card.id ? keyPoint.current : { id: card.id, x: card.x, y: card.y };
    const clip = (v: number) => Math.max(-1, Math.min(1, v));
    const next = { id: card.id, x: clip(base.x + d[0]), y: clip(base.y + d[1]) };
    keyPoint.current = next;
    const token = { id: card.id, settled: false };
    refocus.current = token;
    void Promise.resolve(interactive.onMove(card.id, next.x, next.y, "keyboard")).finally(() => {
      if (refocus.current !== token) return;
      token.settled = true;
      setSettledTick((n) => n + 1);
    });
  };
  // The reading order can move the focused card in the DOM (which drops its
  // focus): once the move has settled, put the focus back — once.
  useLayoutEffect(() => {
    const r = refocus.current;
    if (!r?.settled) return;
    refocus.current = null;
    const el = cardRefs.current.get(r.id);
    if (el && document.activeElement !== el && (document.activeElement == null || document.activeElement === document.body)) {
      el.focus({ preventScroll: true });
    }
  });

  const label = (c: MatrixCard) => {
    if (categoryMode === "off") return { short: "", name: "", a11y: "" };
    if (!knownCategory(c.category)) return { short: "", name: "", a11y: t("no category") };
    return categoryLabel(categories, c.category, categoryMode, lang, t);
  };

  const scoreLooks = useMemo(() => matrixScoreLooks(rating), [rating]);
  const scoreText = (look: ScoreLook) =>
    look.points != null ? t("{{count}} points", { count: look.points }) : "";

  // Card size: beamer-sized from the plot, scaled down when crowded.
  const cardFont = box
    ? matrixCardFont(box, stacks.map((st) => st.card.zone), { mode, narrow, detailed: showDescriptions })
    : CARD_FONT.narrow;

  // --- Where the cards are drawn: measured sizes, relaxed apart. ---
  const [sizes, setSizes] = useState<Map<number, Box>>(() => new Map());
  const reportSize = (id: number, size: Box) =>
    setSizes((prev) => {
      const old = prev.get(id);
      if (old && old.width === size.width && old.height === size.height) return prev;
      return new Map(prev).set(id, size);
    });
  const magnifiers = !!onZoomQuadrant && !results;
  // Relaxation is O(n²) per pass: computed only when what it depends on
  // changes — the stacks' stored positions/zones/sizes, the measured card
  // sizes, the plot, edges, magnifiers and WHICH card is dragged (not the
  // pointer position, which changes on every move).
  const dragId = drag?.id ?? null;
  const stacksKey = stacks.map((st) => `${st.card.id}:${st.card.x}:${st.card.y}:${st.card.zone}:${stackSize(st)}`).join("|");
  const stacksRef = useRef(stacks);
  stacksRef.current = stacks;
  /** The last drawn centres: the dragged card stays where it was drawn. */
  const lastPlacements = useRef(new Map<number, { cx: number; cy: number }>());
  const placements = useMemo(() => {
    if (!box) return new Map<number, { cx: number; cy: number }>();
    const items: LayoutItem[] = [];
    for (const stack of stacksRef.current) {
      const size = sizes.get(stack.card.id);
      if (!size) continue;
      const shadow = stackSize(stack) > 1 ? SHADOW : 0;
      const [px, py] = toPixel(stack.card.x, stack.card.y, box);
      const [xmin, xmax, ymin, ymax] = zoneRect(stack.card.zone as Zone, settings.edges);
      const [zx0, zy0] = toPixel(xmin, ymax, box);
      const [zx1, zy1] = toPixel(xmax, ymin, box);
      // The dragged card keeps its drawn place among the others (no
      // shuffling while dragging); it is drawn at the pointer.
      const dragged = dragId === stack.card.id;
      const last = dragged ? lastPlacements.current.get(stack.card.id) : undefined;
      items.push({
        id: stack.card.id,
        // The footprint includes the paper shadow (right/bottom): the centre
        // of the footprint sits half a shadow right/below the card's centre.
        cx: last?.cx ?? px + shadow / 2,
        cy: last?.cy ?? py + shadow / 2,
        w: size.width + shadow,
        h: size.height + shadow,
        zone: { x0: zx0, y0: zy0, x1: zx1, y1: zy1 },
        fixed: dragged,
      });
    }
    if (magnifiers) {
      const m = MAGNIFIER + MAGNIFIER_INSET;
      const corners: [number, number][] = [
        [m / 2, m / 2],
        [box.width - m / 2, m / 2],
        [m / 2, box.height - m / 2],
        [box.width - m / 2, box.height - m / 2],
      ];
      corners.forEach(([x, y], i) =>
        items.push({ id: -1 - i, cx: x, cy: y, w: m, h: m, zone: { x0: 0, y0: 0, x1: box.width, y1: box.height }, fixed: true }),
      );
    }
    return relaxCards(items, box);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stacksKey, sizes, box, settings.edges, magnifiers, dragId]);
  lastPlacements.current = placements;

  // Semantic field tints: most positive (top right) green, least (bottom
  // left) rose, the two mixed fields amber (top left) and slate (bottom
  // right). Light and low in saturation so the category colours of the cards
  // stay dominant; dark (results page only) is a subtle wash of the same hue.
  const tint = {
    q1: `bg-[#ebf6ee] ${dk("dark:bg-emerald-400/[0.07]")}`,
    q2: `bg-[#fcf5de] ${dk("dark:bg-amber-300/[0.06]")}`,
    q3: `bg-[#fbebec] ${dk("dark:bg-rose-400/[0.07]")}`,
    q4: `bg-[#edf0f5] ${dk("dark:bg-slate-400/[0.08]")}`,
  };
  const axisLine = `bg-slate-500 ${dk("dark:bg-slate-400")}`;
  // Axis labels live in the margin OUTSIDE the plot (the plot box stays the
  // coordinate box), so they can never overlap cards. Presentation-sized on
  // the beamer. The x ends run vertically (left bottom-to-top, right
  // top-to-bottom, as on the participant page) in narrow side columns of
  // up to two lines, so the plot keeps its width.
  const axisLabel = `font-semibold leading-tight text-slate-700 [overflow-wrap:anywhere] ${dk("dark:text-slate-200")}`;
  const axisSize = narrow ? "text-xs" : results ? "text-sm" : "text-xl";
  const xLabel = (side: "x_from" | "x_to") => (
    <div data-axis={side} className={`relative row-start-2 ${side === "x_from" ? "col-start-1" : "col-start-3"}`}>
      <span
        data-axis-text
        className={`${axisLabel} absolute inset-0 flex items-center justify-center overflow-hidden px-[0.15em] text-center [writing-mode:vertical-rl] ${
          side === "x_from" ? "rotate-180" : ""
        }`}
      >
        <span data-axis-label>{localizedText(settings.axes[side])}</span>
      </span>
    </div>
  );

  return (
    <div
      className={`grid w-full grid-cols-[2.6em_minmax(0,1fr)_2.6em] ${axisSize} ${
        results ? "" : "aspect-video grid-rows-[auto_minmax(0,1fr)_auto_auto]"
      }`}
    >
      <span className={`${axisLabel} col-start-2 row-start-1 px-1.5 pb-1 text-center`} data-axis="y_to">
        <span data-axis-label>{localizedText(settings.axes.y_to)}</span>
      </span>
      {xLabel("x_from")}
      {xLabel("x_to")}
      <span className={`${axisLabel} col-start-2 row-start-3 px-1.5 pt-1 text-center`} data-axis="y_from">
        <span data-axis-label>{localizedText(settings.axes.y_from)}</span>
      </span>
      <div
        ref={plotRef}
        data-matrix-board
        // Focus target when the last card under the focus went away.
        tabIndex={interactive ? -1 : undefined}
        className={`relative col-start-2 row-start-2 w-full select-none rounded-lg border border-slate-300 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${dk("dark:border-slate-600")} ${
          results ? "" : "h-full min-h-0"
        }`}
        style={results ? { aspectRatio: RESULTS_ASPECT } : undefined}
      >
        <div aria-hidden className="absolute inset-0 overflow-hidden rounded-[inherit]">
          {(["q2", "q1", "q3", "q4"] as const).map((q) => (
            <div
              key={q}
              data-tint={q}
              className={`absolute h-1/2 w-1/2 ${tint[q]}`}
              style={{ left: q === "q2" || q === "q3" ? 0 : "50%", top: q === "q2" || q === "q1" ? 0 : "50%" }}
            />
          ))}
          <div className={`absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 ${axisLine}`} />
          <div className={`absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 ${axisLine}`} />
          {drag && drag.target == null && box && (() => {
            // The zone the card would land in (edge bands only show here).
            const [xmin, xmax, ymin, ymax] = zoneRect(drag.zone, settings.edges);
            const [l, t0] = toPixel(xmin, ymax, box);
            const [r, b] = toPixel(xmax, ymin, box);
            return (
              <div
                data-drop-zone={drag.zone}
                className="absolute rounded-sm border-2 border-dashed border-brand-600 bg-brand-500/15"
                style={{ left: l, top: t0, width: r - l, height: b - t0 }}
              />
            );
          })()}
        </div>

        {magnifiers &&
          !quadrantFocused &&
          (["q2", "q1", "q3", "q4"] as const).map((q) => {
            const right = q === "q1" || q === "q4";
            const bottom = q === "q3" || q === "q4";
            const name = t("Zoom into the field “{{zone}}”", { zone: matrixZoneName(q, settings.axes, t) });
            return (
              <button
                key={q}
                type="button"
                data-zoom-quadrant={q}
                // One help label for all four.
                data-help={q === "q2" ? "mx.focus" : undefined}
                aria-label={name}
                title={name}
                onClick={(e) => {
                  e.currentTarget.blur();
                  onZoomQuadrant?.(q);
                }}
                className="absolute z-30 flex items-center justify-center rounded-full border border-slate-300 bg-white/80 text-slate-500 hover:bg-white hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                style={{
                  width: MAGNIFIER,
                  height: MAGNIFIER,
                  [right ? "right" : "left"]: MAGNIFIER_INSET,
                  [bottom ? "bottom" : "top"]: MAGNIFIER_INSET,
                }}
              >
                <ZoomIn aria-hidden className="h-4 w-4" />
              </button>
            );
          })}

        {box &&
          stacks.map((stack) => {
            const { card } = stack;
            const dragging = drag?.id === card.id;
            const size = sizes.get(card.id);
            const n0 = stackSize(stack);
            const shadow = n0 > 1 ? SHADOW : 0;
            const placed = placements.get(card.id);
            let left: number | null = null;
            let top: number | null = null;
            if (size && dragging) {
              // Follows the pointer, kept inside the plot.
              const [px, py] = toPixel(drag.x, drag.y, box);
              left = Math.max(0, Math.min(px - size.width / 2, box.width - size.width - shadow));
              top = Math.max(0, Math.min(py - size.height / 2, box.height - size.height - shadow));
            } else if (size && placed) {
              left = placed.cx - (size.width + shadow) / 2;
              top = placed.cy - (size.height + shadow) / 2;
            }
            const isTarget = drag != null && drag.target === card.id;
            const isFresh = fresh.has(card.id);
            const n = stackSize(stack);
            const cat = label(card);
            const categoryHex =
              categoryMode && categoryMode !== "off" && knownCategory(card.category)
                ? paletteEntry(card.category)?.hex
                : undefined;
            const hex = categoryHex ?? NO_CATEGORY_GREY;
            const isHidden = card.hidden;
            const zoneName = matrixZoneName(card.zone, settings.axes, t);
            const Tag = interactive ? "button" : "div";
            const score = isHidden ? undefined : scoreLooks.get(card.id);
            const scoreA11y = score
              ? score.counts
                ? t("{{up}} plus, {{down}} minus, balance {{balance}}", {
                    ...score.counts,
                    balance: score.counts.up - score.counts.down,
                  })
                : scoreText(score)
              : "";
            return (
              <PlacedCard
                key={card.id}
                tag={Tag}
                left={left}
                top={top}
                onSize={(sz: Box) => reportSize(card.id, sz)}
                {...(interactive
                  ? {
                      type: "button" as const,
                      cardRef: (el: HTMLElement | null) => {
                        if (el) cardRefs.current.set(card.id, el);
                        else cardRefs.current.delete(card.id);
                      },
                      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => onPointerDown(e, card),
                      onPointerMove,
                      onPointerUp: (e: ReactPointerEvent<HTMLElement>) => endDrag(e, true),
                      onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => endDrag(e, false),
                      onClick: (e: { detail: number }) => {
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        interactive.onOpen(card.id, e.detail === 0);
                      },
                      onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => onKeyDown(e, card),
                      onBlur: (e: { relatedTarget: EventTarget | null }) => {
                        // Focus moved elsewhere on purpose: stop pushing.
                        if (e.relatedTarget) endKeyboardSession();
                      },
                    }
                  : {})}
                data-card-id={card.id}
                data-zone={card.zone}
                data-stack-size={n}
                data-hidden={isHidden ? "true" : undefined}
                data-stack-target={isTarget ? "true" : undefined}
                data-fresh={isFresh ? "true" : undefined}
                className={`absolute flex w-max items-stretch overflow-hidden rounded-md text-left leading-tight ${
                  interactive
                    ? `cursor-grab touch-none focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                        dragging ? "z-20 cursor-grabbing" : ""
                      }`
                    : ""
                } ${n > 1 && !dragging ? "z-10" : ""} ${isTarget ? "outline outline-[3px] outline-offset-2 outline-brand-600" : ""} ${
                  isFresh && !isTarget ? "outline outline-4 outline-amber-300" : ""
                } ${
                  isHidden
                    ? `border border-dashed border-slate-400 text-slate-600 ${dk("dark:border-slate-500 dark:text-slate-300")}`
                    : `text-slate-900 shadow-[0_1px_3px_rgba(0,0,0,.25)] ${dk("dark:text-slate-100")}`
                }`}
                style={{
                  fontSize: `${cardFont}px`,
                  maxWidth: narrow ? "34%" : `min(${results ? 26 : 28}%, 11em)`,
                  transition: reduced || dragging ? "none" : "left .25s ease, top .25s ease, outline-color .3s ease",
                  ...(n > 1
                    ? { boxShadow: "3px 3px 0 #ddd, 6px 6px 0 #ccc, 0 1px 3px rgba(0,0,0,.25)" }
                    : null),
                }}
              >
                {/* Category tab: the full colour, the letter (colours mode) in
                    white or near-black, whichever contrasts more. */}
                <span
                  aria-hidden
                  data-card-tab
                  className={`flex flex-none items-center justify-center font-bold ${cat.short ? "w-[1.4em]" : "w-[0.35em]"}`}
                  style={{ background: hex, color: readableOn(hex) }}
                >
                  {cat.short}
                </span>
                <span
                  data-card-body
                  className={`block min-w-0 flex-1 px-[0.55em] py-[0.35em] ${
                    isHidden
                      ? `bg-slate-100 ${dk("dark:bg-slate-900")}`
                      : `bg-[var(--mx-tint)] ${dk("dark:bg-[var(--mx-tint-dark)]")}`
                  }`}
                  style={
                    {
                      "--mx-tint": categoryHex ? mixHex(categoryHex, "#ffffff", TINT_LIGHT) : "#ffffff",
                      "--mx-tint-dark": categoryHex ? mixHex(categoryHex, SLATE_800, TINT_DARK) : SLATE_800,
                    } as CSSProperties
                  }
                >
                  <span className={`flex items-start gap-[0.3em] ${narrow ? "flex-wrap" : ""}`}>
                    <span data-card-title className="line-clamp-2 min-w-0 font-semibold [overflow-wrap:anywhere]">
                      {card.title}
                    </span>
                    {n > 1 && (
                      <span
                        data-testid="matrix-stack-badge"
                        className="ml-auto flex-none rounded-full bg-slate-800 px-1.5 text-[0.7em] font-semibold text-white"
                      >
                        ×{n}
                      </span>
                    )}
                  </span>
                  {showDescriptions && card.description && (
                    <span className={`mt-0.5 line-clamp-3 block text-[0.85em] text-slate-700 [overflow-wrap:anywhere] ${dk("dark:text-slate-300")}`}>
                      {card.description}
                    </span>
                  )}
                  {score && (
                    <span data-card-score="" className="mt-[0.3em] flex items-center gap-[0.4em]">
                      <span
                        aria-hidden
                        data-score-track=""
                        className="relative block h-[0.5em] min-w-[2.5em] flex-1 overflow-hidden rounded-full bg-white/80 ring-1 ring-inset ring-slate-400/60"
                      >
                        {score.counts ? (
                          <>
                            {score.up > 0 && (
                              <span
                                data-score-up=""
                                className="absolute inset-y-0 left-0 block"
                                style={{ width: `${(score.up * 100).toFixed(1)}%`, background: UP, transition: reduced ? undefined : "width .4s ease" }}
                              />
                            )}
                            {score.down > 0 && (
                              <span
                                data-score-down=""
                                className="absolute inset-y-0 right-0 block"
                                style={{ width: `${(score.down * 100).toFixed(1)}%`, background: DOWN, transition: reduced ? undefined : "width .4s ease" }}
                              />
                            )}
                          </>
                        ) : (
                          <span
                            data-score-bar=""
                            className="absolute inset-y-0 left-0 block"
                            style={{ width: `${(score.up * 100).toFixed(1)}%`, background: categoryHex ?? "#64748b", transition: reduced ? undefined : "width .4s ease" }}
                          />
                        )}
                      </span>
                      <span aria-hidden data-score-text="" className="flex-none whitespace-nowrap text-[0.8em] font-bold tabular-nums">
                        {score.counts ? (
                          <>
                            <span className={matrixUpInkClass(results)}>+{score.counts.up}</span>
                            {" / "}
                            <span className={matrixDownInkClass(results)}>−{score.counts.down}</span>
                          </>
                        ) : (
                          // Phone board: the bare number fits the small card.
                          narrow ? score.points : scoreText(score)
                        )}
                      </span>
                    </span>
                  )}
                  {isHidden && (
                    <span data-testid="matrix-hidden-marker" className="mt-0.5 flex items-center gap-1 text-[0.8em] font-medium">
                      <EyeOff aria-hidden className="h-[1em] w-[1em]" />
                      {t("hidden")}
                    </span>
                  )}
                  <span className="sr-only">
                    {` – ${[cat.a11y, zoneName, scoreA11y].filter(Boolean).join(", ")}`}
                  </span>
                </span>
              </PlacedCard>
            );
          })}

      </div>
      {categoryMode !== "off" && categories.length > 0 && (
        <ul
          aria-label={t("Categories")}
          data-help={legendHelp}
          // The app's legend look (LikertResult): text-sm, 12px rounded swatches.
          // On the beamer presentation-sized like the axis labels.
          className={`col-start-2 row-start-4 flex flex-wrap items-center justify-end px-1.5 text-slate-600 ${
            results ? "mt-2 gap-x-4 gap-y-1.5 text-sm" : "mt-3 gap-x-6 gap-y-2 text-xl"
          } ${dk("dark:text-slate-300")}`}
          data-testid="matrix-legend"
        >
          {categories.map((c) => {
            const cat = categoryLabel(categories, c.key, categoryMode, lang, t);
            const off = hiddenCategories?.has(c.key) ?? false;
            const content = (
              <>
                <span
                  aria-hidden
                  data-swatch
                  className={`inline-block flex-none rounded border ${results ? "h-3 w-3" : "h-4 w-4"}`}
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
                    className={`inline-flex items-center rounded hover:underline ${results ? "gap-1.5" : "gap-2"} focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600`}
                  >
                    {content}
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1.5">{content}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
