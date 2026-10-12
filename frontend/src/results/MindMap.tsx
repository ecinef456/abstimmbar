// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Beamer mind map (stage 1): the shared tree as a two-sided map — root in
 * the centre, main branches alternating right/left (balanced by size), sub-
 * terms growing outwards, curved connectors in the main branch's colour.
 *
 * Split in two parts:
 *  - `layoutMindMap` — a pure function (tree + node box sizes → positions,
 *    connectors, bounds). No DOM, no React; readable and testable on its own.
 *  - `MindMap` — measures the node boxes with a canvas (no layout thrash: no
 *    DOM reads per node), renders absolutely positioned pills plus an SVG for
 *    the connectors, animates layout changes via CSS transitions, and offers
 *    zoom/pan (wheel, drag, + / − / 0, Shift+arrows) with auto-fit.
 *
 * Stage 2 (expert mode, presenter only): "+" on hover adds a term (also on
 * the root), dragging a term onto another merges it, dragging it onto the
 * "attach here" tab beside a term (or onto the root) moves it there, double-
 * click renames. Invalid targets are shown red with the reason; the checks
 * mirror the server's (`backend/live/mindmap.py`). */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  CornerDownRight,
  FolderPlus,
  Languages,
  Maximize2,
  Merge,
  Minus,
  MoveRight,
  Plus,
  X,
  ZoomIn,
} from "lucide-react";
import { localizedText } from "@basicbar/ui";
import type { LiveMindmapNode, MindmapRating } from "../api";
import { CORRECT, CORRECT_STRONG, CORRECT_TINT, INK, MINUS, MINUS_INK, MINUS_TINT, NEUTRAL_TILE } from "./palette";
import { EASE, useReducedMotion } from "./motion";

// ---------------------------------------------------------------------------
// Pure layout
// ---------------------------------------------------------------------------

export type Side = 1 | -1; // 1 = right of the root, -1 = left
export interface BoxSize {
  w: number;
  h: number;
}
/** The (visible) tree the layout works on. */
export interface MindTreeNode {
  id: number;
  children: MindTreeNode[];
}
export interface PlacedNode {
  id: number;
  /** Centre of the box; the root sits at (0, 0). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 1 = main branch. */
  depth: number;
  /** Index of the main branch among `branches` (colour). */
  branch: number;
  side: Side;
}
export interface MindEdge {
  /** The child node's id (one edge per non-root node). */
  id: number;
  /** SVG path (cubic Bézier) from the parent's outer edge to the child. */
  d: string;
  depth: number;
  branch: number;
}
export interface MindLayout {
  root: BoxSize;
  nodes: PlacedNode[];
  edges: MindEdge[];
  sides: Map<number, Side>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}
export interface MindGaps {
  /** Horizontal gap root → main branches. */
  rootX: number;
  /** Horizontal gap parent → child below the main branches. */
  x: number;
  /** Vertical gap between neighbouring main-branch subtrees. */
  branchY: number;
  /** Vertical gap between siblings deeper down. */
  y: number;
}
export const MIND_GAPS: MindGaps = { rootX: 68, x: 40, branchY: 24, y: 10 };

/** Main branches to sides: alternating, balanced by subtree height (greedy in
 * branch order — the lighter side gets the next branch, ties go right).
 * A branch keeps the side it had (`prev`) so the map doesn't flip around as
 * it grows; only when the sides drift clearly apart (> 1.5× + 120 px) do
 * single branches move over — each time the one that evens the sides out
 * best — so as few branches as possible change sides. */
export function assignSides(
  branches: { id: number; weight: number }[],
  prev?: ReadonlyMap<number, Side>,
): Map<number, Side> {
  const greedy = () => {
    const out = new Map<number, Side>();
    let right = 0;
    let left = 0;
    for (const b of branches) {
      if (right <= left) {
        out.set(b.id, 1);
        right += b.weight;
      } else {
        out.set(b.id, -1);
        left += b.weight;
      }
    }
    return out;
  };
  if (!prev || prev.size === 0) return greedy();
  const out = new Map<number, Side>();
  let right = 0;
  let left = 0;
  for (const b of branches) {
    const side = prev.get(b.id) ?? (right <= left ? 1 : -1);
    out.set(b.id, side);
    if (side === 1) right += b.weight;
    else left += b.weight;
  }
  const weights = new Map(branches.map((b) => [b.id, b.weight]));
  for (let guard = 0; guard < branches.length; guard++) {
    const heavy: Side = right >= left ? 1 : -1;
    const hi = Math.max(right, left);
    const lo = Math.min(right, left);
    if (hi <= lo * 1.5 + 120) break;
    let best: number | null = null;
    let bestGap = hi - lo;
    out.forEach((side, id) => {
      if (side !== heavy) return;
      const gap = Math.abs(hi - lo - 2 * weights.get(id)!);
      if (gap < bestGap) {
        bestGap = gap;
        best = id;
      }
    });
    if (best === null) break;
    const w = weights.get(best)!;
    out.set(best, -heavy as Side);
    if (heavy === 1) {
      right -= w;
      left += w;
    } else {
      left -= w;
      right += w;
    }
  }
  return out;
}

interface Measured {
  node: MindTreeNode;
  size: BoxSize;
  /** Height of the horizontal band the subtree occupies. */
  band: number;
  kids: Measured[];
  kidsSpan: number;
}

/** Two-sided tidy tree. Every subtree owns a horizontal band (its height =
 * max(own box, children's bands + gaps)); bands of siblings never overlap and
 * children always sit further out than their parent's outer edge, so neither
 * boxes nor connectors can collide. `size(node, depth)` gives each box. */
export function layoutMindMap(
  root: BoxSize,
  branches: MindTreeNode[],
  size: (node: MindTreeNode, depth: number) => BoxSize,
  prevSides?: ReadonlyMap<number, Side>,
  gaps: MindGaps = MIND_GAPS,
): MindLayout {
  const measure = (node: MindTreeNode, depth: number): Measured => {
    const own = size(node, depth);
    const kids = node.children.map((c) => measure(c, depth + 1));
    const kidsSpan =
      kids.reduce((sum, k) => sum + k.band, 0) + Math.max(0, kids.length - 1) * gaps.y;
    return { node, size: own, band: Math.max(own.h, kidsSpan), kids, kidsSpan };
  };
  const measured = branches.map((b) => measure(b, 1));
  const sides = assignSides(
    measured.map((m) => ({ id: m.node.id, weight: m.band })),
    prevSides,
  );

  const nodes: PlacedNode[] = [];
  const edges: MindEdge[] = [];
  let minX = -root.w / 2;
  let maxX = root.w / 2;
  let minY = -root.h / 2;
  let maxY = root.h / 2;

  const curve = (ax: number, ay: number, bx: number, by: number) => {
    const k = Math.abs(bx - ax) * 0.55;
    const s = Math.sign(bx - ax) || 1;
    const f = (v: number) => Math.round(v * 10) / 10;
    return `M ${f(ax)} ${f(ay)} C ${f(ax + s * k)} ${f(ay)} ${f(bx - s * k)} ${f(by)} ${f(bx)} ${f(by)}`;
  };

  // `inner` = distance of the box's inner edge from the root's centre line.
  const place = (
    m: Measured,
    depth: number,
    branch: number,
    side: Side,
    inner: number,
    top: number,
    anchor: { x: number; y: number },
  ) => {
    const { w, h } = m.size;
    const cy = top + m.band / 2;
    const cx = side * (inner + w / 2);
    nodes.push({ id: m.node.id, x: cx, y: cy, w, h, depth, branch, side });
    edges.push({ id: m.node.id, d: curve(anchor.x, anchor.y, side * inner, cy), depth, branch });
    minX = Math.min(minX, cx - w / 2);
    maxX = Math.max(maxX, cx + w / 2);
    minY = Math.min(minY, cy - h / 2);
    maxY = Math.max(maxY, cy + h / 2);
    let kidTop = cy - m.kidsSpan / 2;
    const outer = inner + w;
    for (const k of m.kids) {
      place(k, depth + 1, branch, side, outer + gaps.x, kidTop, { x: side * outer, y: cy });
      kidTop += k.band + gaps.y;
    }
  };

  for (const side of [1, -1] as Side[]) {
    const list = measured
      .map((m, branch) => ({ m, branch }))
      .filter(({ m }) => sides.get(m.node.id) === side);
    const total =
      list.reduce((sum, { m }) => sum + m.band, 0) + Math.max(0, list.length - 1) * gaps.branchY;
    let top = -total / 2;
    for (const { m, branch } of list) {
      place(m, 1, branch, side, root.w / 2 + gaps.rootX, top, { x: (side * root.w) / 2, y: 0 });
      top += m.band + gaps.branchY;
    }
  }
  return { root, nodes, edges, sides, bounds: { minX, maxX, minY, maxY } };
}

/** Viewport transform that fits the map: the largest scale (≤ `maxScale`) at
 * which everything is visible while the root stays near the centre — it may
 * move off-centre by at most `maxOffset` of the viewport per axis, so a
 * lopsided map (one deep side) isn't shrunk for empty space on the other.
 * Returns the scale and the root's position in the viewport. */
export function fitTransform(
  b: MindLayout["bounds"],
  vw: number,
  vh: number,
  { pad = 28, maxScale = 1.3, maxOffset = 0.12 } = {},
): { s: number; x: number; y: number } {
  if (vw <= 0 || vh <= 0) return { s: 1, x: vw / 2, y: vh / 2 };
  const scaleFor = (lo: number, hi: number, size: number) => {
    const before = -lo + pad;
    const after = hi + pad;
    const limit = maxOffset * size;
    const s = size / (before + after);
    const offset = s * before - size / 2;
    if (Math.abs(offset) <= limit) return s;
    const o = Math.sign(offset) * limit;
    return Math.min((size / 2 + o) / before, (size / 2 - o) / after);
  };
  const s = Math.min(scaleFor(b.minX, b.maxX, vw), scaleFor(b.minY, b.maxY, vh), maxScale);
  const rootAt = (lo: number, hi: number, size: number) => {
    const low = s * (-lo + pad) - size / 2; // smallest offset that shows the start
    const high = size / 2 - s * (hi + pad); // largest offset that shows the end
    const limit = maxOffset * size;
    const o = Math.min(Math.max(0, low), high); // as central as possible
    return size / 2 + Math.max(-limit, Math.min(limit, o));
  };
  return { s, x: rootAt(b.minX, b.maxX, vw), y: rootAt(b.minY, b.maxY, vh) };
}

export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Like `fitTransform`, but keeps the map clear of overlays on top of the
 * canvas (QR boxes, logo, counters, edge handles — rects relative to the
 * viewport). Each overlay becomes an inset on one side: the nearer
 * horizontal or the nearer vertical edge; all combinations are tried and
 * the one with the largest scale wins (few overlays, so this is cheap).
 * Panning may still move content underneath them. */
export function fitAround(
  b: MindLayout["bounds"],
  vw: number,
  vh: number,
  obstacles: Obstacle[],
  opts: { pad?: number; maxScale?: number; maxOffset?: number } = {},
): { s: number; x: number; y: number } {
  const list = obstacles
    .filter((o) => o.x < vw && o.x + o.w > 0 && o.y < vh && o.y + o.h > 0)
    .slice(0, 8);
  let best = fitTransform(b, vw, vh, opts);
  if (list.length === 0) return best;
  best = { s: -1, x: 0, y: 0 };
  const choices = list.map((o) => {
    const left = o.x + o.w;
    const right = vw - o.x;
    const top = o.y + o.h;
    const bottom = vh - o.y;
    return [
      left < right ? { side: "l" as const, v: left } : { side: "r" as const, v: right },
      top < bottom ? { side: "t" as const, v: top } : { side: "b" as const, v: bottom },
    ];
  });
  for (let mask = 0; mask < 1 << list.length; mask++) {
    const ins = { l: 0, r: 0, t: 0, b: 0 };
    choices.forEach((c, i) => {
      const pick = c[(mask >> i) & 1];
      ins[pick.side] = Math.max(ins[pick.side], pick.v);
    });
    const iw = vw - ins.l - ins.r;
    const ih = vh - ins.t - ins.b;
    if (iw < 80 || ih < 80) continue;
    const f = fitTransform(b, iw, ih, opts);
    if (f.s > best.s) best = { s: f.s, x: ins.l + f.x, y: ins.t + f.y };
  }
  return best.s > 0 ? best : fitTransform(b, vw, vh, opts);
}

/** Display term of a node: seeded nodes carry both languages (`text_i18n`),
 * resolved to the UI language; `text` is the canonical fallback (and the
 * merge key — never use this for comparisons). */
export function mindmapNodeText(n: LiveMindmapNode): string {
  return (n.text_i18n && localizedText(n.text_i18n)) || n.text;
}

/** Display descriptions: the predefined (seeded) one, if present, is first
 * and resolved to the UI language. */
export function mindmapNodeDescriptions(n: LiveMindmapNode): string[] {
  if (!n.description_i18n || n.descriptions.length === 0) return n.descriptions;
  return [localizedText(n.description_i18n) || n.descriptions[0], ...n.descriptions.slice(1)];
}

/** The presenter payload carries hidden nodes; a hidden node hides its whole
 * subtree. */
export function visibleMindmap(nodes: LiveMindmapNode[]): LiveMindmapNode[] {
  return nodes
    .filter((n) => !n.hidden)
    .map((n) => ({ ...n, children: visibleMindmap(n.children) }));
}

/** Explicitly hidden nodes (for the restore drawer): path from the main
 * branch down, and how many terms hang below. */
export function hiddenMindmapNodes(
  nodes: LiveMindmapNode[],
  path: string[] = [],
): { id: number; text: string; path: string[]; below: number }[] {
  const size = (n: LiveMindmapNode): number =>
    n.children.reduce((sum, c) => sum + 1 + size(c), 0);
  return nodes.flatMap((n) => [
    ...(n.hidden ? [{ id: n.id, text: mindmapNodeText(n), path, below: size(n) }] : []),
    ...hiddenMindmapNodes(n.children, [...path, mindmapNodeText(n)]),
  ]);
}

// ---------------------------------------------------------------------------
// Text measurement (canvas) and node styling
// ---------------------------------------------------------------------------

let ctx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();
function textWidth(text: string, px: number, weight: number, family: string): number {
  const key = `${weight}|${px}|${family}|${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  let w = text.length * px * 0.56; // fallback estimate (as the word cloud does)
  if (ctx) {
    ctx.font = `${weight} ${px}px ${family}`;
    w = ctx.measureText(text).width;
  }
  if (widthCache.size > 5000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

/** Greedy word wrap into at most `maxLines` lines (the last one ellipsised
 * when the text doesn't fit); words longer than a line are split. */
function wrapText(
  text: string,
  px: number,
  weight: number,
  family: string,
  maxW: number,
  maxLines: number,
): { lines: string[]; width: number } {
  const measure = (s: string) => textWidth(s, px, weight, family);
  const lines: string[] = [];
  let line = "";
  const pushWord = (word: string) => {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(candidate) <= maxW) {
      line = candidate;
      return;
    }
    if (line) lines.push(line);
    line = "";
    // Split an overlong word by characters.
    let rest = word;
    while (measure(rest) > maxW && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && measure(rest.slice(0, cut)) > maxW) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  };
  for (const word of text.split(/\s+/).filter(Boolean)) pushWord(word);
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && measure(`${last}…`) > maxW) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last.trimEnd()}…`;
    lines.splice(0, lines.length, ...kept);
  }
  return { lines, width: Math.max(0, ...lines.map(measure)) };
}

interface NodeLook {
  font: number;
  weight: number;
  padX: number;
  padY: number;
  maxW: number;
}
const LOOKS: NodeLook[] = [
  { font: 26, weight: 800, padX: 26, padY: 15, maxW: 340 }, // root
  { font: 21, weight: 650, padX: 16, padY: 8, maxW: 250 },
  { font: 18, weight: 600, padX: 13, padY: 6, maxW: 230 },
  { font: 16, weight: 500, padX: 11, padY: 5, maxW: 210 },
];
const LINE = 1.22;
const DESC_LINE = 1.28;
const BADGE_GAP = 8;

/** Rating badges of a node (rating phase, when scores are shown). */
type RateBadge = { text: string; tone: "points" | "up" | "down" | "balance"; sign?: number };
interface RateLook {
  /** Emphasis 0–1 relative to the best-rated entry (points: points;
   *  plus/minus: a positive balance). */
  r: number;
  badges: RateBadge[];
  /** Fill bar inside the pill, as fractions of its width: points fill from
   *  the left (`up`); plus/minus fill green from the left and rosé from the
   *  right, both relative to the most-rated entry. */
  bar: { up: number; down: number };
}
const RATE_GAP = 4;
/** How much the best-rated term grows (font and line width). */
const RATE_GROW = 0.7;
function rateBadgeWidth(b: RateBadge, font: number, family: string): number {
  const w = Math.ceil(textWidth(b.text, font, 700, family));
  if (b.tone === "points") return w + Math.round(font * 0.5) + 4 + 14; // dot + gap + padding
  if (b.tone === "balance") return w + 14;
  return w + 2; // plain coloured text
}

interface NodeBox extends BoxSize {
  lines: string[];
  font: number;
  weight: number;
  padX: number;
  padY: number;
  desc: string[];
  descFont: number;
  badge: number; // badge width (0 = none)
  rate: (RateBadge & { w: number })[];
  rateFont: number;
}

function boxFor(
  text: string,
  count: number,
  descriptions: string[],
  depth: number,
  emphasise: boolean,
  detailed: boolean,
  family: string,
  rateLook?: RateLook,
): NodeBox {
  const look = LOOKS[Math.min(depth, LOOKS.length - 1)];
  // Duplicate emphasis: bigger and bolder the more people named the term.
  // With ratings shown, the score takes over the emphasis.
  const boost = !rateLook && emphasise && count > 1 ? Math.min(count - 1, 5) : 0;
  const rr = rateLook?.r ?? 0;
  const font = Math.round(look.font * (1 + 0.08 * boost) * (1 + RATE_GROW * rr));
  const weight = Math.min(
    800,
    look.weight + (boost > 0 ? 150 : 0) + (rr >= 0.5 ? 150 : rr > 0 ? 75 : 0),
  );
  // A rated term grows: so does its line width, so it wraps as before.
  const title = wrapText(text, font, weight, family, look.maxW * (1 + RATE_GROW * rr), 3);
  const badgeFont = Math.round(font * 0.68);
  const badge =
    count > 1 ? Math.ceil(textWidth(String(count), badgeFont, 700, family)) + 14 : 0;
  let desc: string[] = [];
  let descW = 0;
  const descFont = Math.max(13, Math.round(font * 0.78));
  if (detailed && descriptions.length > 0) {
    const all = descriptions.flatMap(
      (d) => wrapText(d, descFont, 400, family, Math.max(look.maxW, 200), 3).lines,
    );
    desc = all.slice(0, 3);
    if (all.length > 3) {
      let last = desc[2];
      while (last.length > 1 && textWidth(`${last}…`, descFont, 400, family) > look.maxW)
        last = last.slice(0, -1);
      desc[2] = `${last.trimEnd()}…`;
    }
    descW = Math.max(0, ...desc.map((l) => textWidth(l, descFont, 400, family)));
  }
  const rateFont = Math.max(13, Math.round(look.font * 0.7));
  const rate = (rateLook?.badges ?? []).map((b) => ({ ...b, w: rateBadgeWidth(b, rateFont, family) }));
  const rateW = rate.length
    ? BADGE_GAP + rate.reduce((sum, b) => sum + b.w, 0) + (rate.length - 1) * RATE_GAP
    : 0;
  const titleW = title.width + (badge ? BADGE_GAP + badge : 0) + rateW;
  const w = Math.ceil(Math.max(titleW, descW) + 2 * look.padX + 2);
  const h = Math.ceil(
    title.lines.length * font * LINE +
      (desc.length ? 4 + desc.length * descFont * DESC_LINE : 0) +
      2 * look.padY,
  );
  return {
    w,
    h,
    lines: title.lines,
    font,
    weight,
    padX: look.padX,
    padY: look.padY,
    desc,
    descFont,
    badge,
    rate,
    rateFont,
  };
}

/** Mind-map palette: the six category hues of `palette.ts` (same OKLCH
 * lightness/chroma) plus green and coral — only here, since a mind map has no
 * right/wrong reading (polls keep avoiding green and red). */
export const MINDMAP_HUES = [250, 60, 305, 220, 85, 335, 150, 25] as const;
const fill = (hue: number) => `oklch(0.80 0.095 ${hue})`;
const tint = (hue: number) => `oklch(0.92 0.04 ${hue})`;
const deep = (hue: number) => `oklch(0.62 0.11 ${hue})`;

/** Hue index per main branch. `clockwise` lists the branch ids in display
 * order (right side top → bottom, then left side bottom → top); `stable`
 * gives each branch's creation rank (id order, incl. hidden branches). Each
 * branch prefers `stable % n`; if that equals a neighbour's hue (the list
 * wraps around) it takes the first hue used by neither neighbour. */
export function branchHues(
  clockwise: number[],
  stable: ReadonlyMap<number, number>,
  n: number = MINDMAP_HUES.length,
): Map<number, number> {
  const out = new Map<number, number>();
  const pref = (id: number) => (stable.get(id) ?? 0) % n;
  clockwise.forEach((id, i) => {
    const want = pref(id);
    if (clockwise.length < 2) {
      out.set(id, want);
      return;
    }
    const prevId = clockwise[(i - 1 + clockwise.length) % clockwise.length];
    const nextId = clockwise[(i + 1) % clockwise.length];
    const prev = out.get(prevId) ?? pref(prevId);
    const next = out.get(nextId) ?? pref(nextId);
    let hue = want;
    if (hue === prev || hue === next) {
      for (let h = 0; h < n; h++) {
        if (h !== prev && h !== next) {
          hue = h;
          break;
        }
      }
    }
    out.set(id, hue);
  });
  return out;
}

/** Hue (degrees) per main branch as last drawn by a `MindMap` with that
 * `memoryKey` (small LRU, like the branch sides). */
const hueMemory = new Map<string, Map<number, number>>();

/** Hue (degrees) of each visible main branch, as the map colours it: what
 * the map with `memoryKey` last drew, otherwise the same rule without the
 * display order (stable rank by id, neighbours in tree order differ) — e.g.
 * on the results page, where no map is drawn. */
export function mindmapBranchHues(
  nodes: LiveMindmapNode[],
  memoryKey?: string,
): Map<number, number> {
  const remembered = memoryKey ? hueMemory.get(memoryKey) : undefined;
  const stable = new Map(
    nodes.map((n) => n.id).sort((a, b) => a - b).map((id, i) => [id, i] as const),
  );
  const ids = nodes.filter((n) => !n.hidden).map((n) => n.id);
  const fallback = branchHues(ids, stable);
  return new Map(
    ids.map((id) => [id, remembered?.get(id) ?? MINDMAP_HUES[fallback.get(id) ?? 0]] as const),
  );
}
/** Fill colour of a main branch with hue `hue` (degrees). */
export const mindmapBranchFill = (hue: number) => fill(hue);

/** Fill / border / connector per depth: the main branch's hue, lighter
 * outwards. */
function nodeColors(depth: number, hue: number) {
  if (depth <= 1) return { bg: fill(hue), border: "transparent" };
  if (depth === 2) return { bg: tint(hue), border: fill(hue) };
  if (depth === 3) return { bg: `oklch(0.96 0.02 ${hue})`, border: `oklch(0.86 0.06 ${hue})` };
  return { bg: "#fff", border: `oklch(0.9 0.04 ${hue})` };
}
function edgeStyle(depth: number, hue: number) {
  if (depth <= 1) return { stroke: fill(hue), width: 6 };
  if (depth === 2) return { stroke: fill(hue), width: 4 };
  if (depth === 3) return { stroke: `oklch(0.85 0.07 ${hue})`, width: 3 };
  return { stroke: `oklch(0.88 0.05 ${hue})`, width: 2.5 };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
const MAX_FIT = 1.3;
const FIT_PAD = 28;
const TRANSITION_MS = 600;
/** Drop-target colours (valid / invalid). */
const GOOD = "oklch(0.52 0.15 250)";
const GOOD_BG = "oklch(0.95 0.03 250 / 0.85)";
const BAD = "oklch(0.55 0.2 27)";
const BAD_BG = "oklch(0.95 0.04 27 / 0.85)";
const PLUS_BTN =
  "flex h-7 w-7 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-600 shadow-sm hover:bg-slate-100 hover:text-slate-900";

/** Side assignments survive a remount (e.g. the brief "closed" phase between
 * open and results, or navigating back to the question), keyed by
 * `memoryKey`. Small LRU. */
const sideMemory = new Map<string, Map<number, Side>>();

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range"].includes(type);
  }
  return el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export default function MindMap({
  rootLabel,
  nodes: allNodes,
  detailed = false,
  highlightDuplicates = true,
  onHide,
  onAdd,
  onMerge,
  onMove,
  onRename,
  maxDepth = 8,
  withDescriptions = false,
  zoomHandleTop,
  keyboard = true,
  memoryKey,
  rating,
  lockedNote,
  previewMarks = false,
}: {
  rootLabel: string;
  /** Presenter-form tree (hidden nodes are skipped with their subtree). */
  nodes: LiveMindmapNode[];
  /** Show descriptions under the terms. */
  detailed?: boolean;
  highlightDuplicates?: boolean;
  /** Expert mode: × on hover hides a term with its subtree. */
  onHide?: (node: LiveMindmapNode) => void;
  /** Expert mode: "+" on hover adds a term below a node (`null` = root). */
  onAdd?: (parent: number | null, text: string, description?: string) => void;
  /** Expert mode: drag a term onto another one. */
  onMerge?: (source: number, target: number) => void;
  /** Expert mode: drag a term onto the "attach here" tab (or the root). */
  onMove?: (node: number, parent: number | null, from: number | null) => void;
  /** Expert mode: double-click renames a term. */
  onRename?: (node: number, text: string) => void;
  /** Levels below the root terms may occupy (the question's depth). */
  maxDepth?: number;
  /** The "+" form asks for a description too. */
  withDescriptions?: boolean;
  /** Beamer: the zoom controls become a collapsible right-edge handle at
   *  this viewport y (px); otherwise they sit bottom right in the map. */
  zoomHandleTop?: number;
  /** Zoom/pan keys (+ / − / 0 / F, Shift+arrows) on the window. */
  keyboard?: boolean;
  /** Identifies the map (run + question) so the branch sides are kept. */
  memoryKey?: string;
  /** Rating phase: with `scores`, each rated term shows its score and is
   *  emphasised by it (points: size/weight/intensity; plus/minus: green /
   *  rosé accent by the balance's sign). The root never carries a score. */
  rating?: MindmapRating;
  /** Why add/merge/move/rename are switched off right now (tooltip). */
  lockedNote?: string;
  /** AI preview: terms changed by the proposal get a ring and small marks
   *  (merged / renamed / moved / new parent term) with a tooltip. */
  previewMarks?: boolean;
}) {
  const { t, i18n } = useTranslation();
  // Seeded terms resolve to the UI language (mindmapNodeText): re-measure on
  // a language switch.
  const uiLang = i18n.resolvedLanguage;
  const reduced = useReducedMotion();
  const animate = !reduced;
  const containerRef = useRef<HTMLDivElement | null>(null);

  // --- font (for canvas measurement); re-measure once web fonts are in ---
  const [family, setFamily] = useState(
    () =>
      (typeof document !== "undefined" && getComputedStyle(document.body).fontFamily) ||
      "sans-serif",
  );
  const [fontTick, setFontTick] = useState(0);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (el) setFamily(getComputedStyle(el).fontFamily || "sans-serif");
    let alive = true;
    document.fonts?.ready.then(() => {
      if (!alive) return;
      widthCache.clear();
      setFontTick((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  // --- layout ---
  const visible = useMemo(() => visibleMindmap(allNodes), [allNodes]);
  const byId = useMemo(() => {
    const map = new Map<number, LiveMindmapNode>();
    const walk = (list: LiveMindmapNode[]) =>
      list.forEach((n) => {
        map.set(n.id, n);
        walk(n.children);
      });
    walk(visible);
    return map;
  }, [visible]);
  // Same term under several parents: a dashed ring marks each of them.
  const repeatedKeys = useMemo(() => {
    const seen = new Map<string, number>();
    byId.forEach((n) => {
      // `key` is presenter-only; results trees fall back to the lowercased text.
      const k = n.key ?? n.text.toLowerCase();
      seen.set(k, (seen.get(k) ?? 0) + 1);
    });
    return new Set([...seen].filter(([, c]) => c > 1).map(([k]) => k));
  }, [byId]);

  // Full tree (incl. hidden terms — the server counts them for depth and
  // name clashes): parent, level (main branch = 1) and subtree height.
  const tree = useMemo(() => {
    const parent = new Map<number, number | null>();
    const level = new Map<number, number>();
    const height = new Map<number, number>();
    const node = new Map<number, LiveMindmapNode>();
    const walk = (list: LiveMindmapNode[], p: number | null, depth: number): number =>
      list.reduce((max, n) => {
        parent.set(n.id, p);
        level.set(n.id, depth);
        node.set(n.id, n);
        const h = 1 + walk(n.children, n.id, depth + 1);
        height.set(n.id, h);
        return Math.max(max, h);
      }, 0);
    walk(allNodes, null, 1);
    return { parent, level, height, node };
  }, [allNodes]);
  const moderating = !!(onMerge || onMove);

  // --- rating scores (only when the payload carries them) ---
  const scores = rating?.scores;
  const rateMode = rating?.mode;
  const rateLooks = useMemo(() => {
    const out = new Map<number, RateLook>();
    if (!scores || !rateMode) return out;
    const entries = Object.entries(scores).map(([k, v]) => [Number(k), v] as const);
    if (rateMode === "points") {
      const max = Math.max(1, ...entries.map(([, v]) => ("points" in v ? v.points : 0)));
      for (const [id, v] of entries) {
        if (!("points" in v) || v.points <= 0) continue;
        out.set(id, {
          r: v.points / max,
          badges: [{ text: String(v.points), tone: "points" }],
          bar: { up: v.points / max, down: 0 },
        });
      }
    } else {
      const maxPos = Math.max(1, ...entries.map(([, v]) => ("balance" in v ? v.balance : 0)));
      const maxTotal = Math.max(1, ...entries.map(([, v]) => ("up" in v ? v.up + v.down : 0)));
      for (const [id, v] of entries) {
        if (!("balance" in v)) continue;
        const sign = v.balance > 0 ? "+" : v.balance < 0 ? "−" : "±";
        out.set(id, {
          r: Math.max(0, v.balance) / maxPos,
          badges: [
            { text: `+${v.up}`, tone: "up" },
            { text: `−${v.down}`, tone: "down" },
            { text: `${sign}${Math.abs(v.balance)}`, tone: "balance", sign: Math.sign(v.balance) },
          ],
          bar: { up: v.up / maxTotal, down: v.down / maxTotal },
        });
      }
    }
    return out;
  }, [scores, rateMode]);
  // An empty score map (nothing rated yet) changes nothing on the map.
  const showScores = rateLooks.size > 0;
  const scoresKey = useMemo(() => JSON.stringify(scores ?? null), [scores]);

  const sidesRef = useRef<Map<number, Side>>(
    (memoryKey && sideMemory.get(memoryKey)) || new Map(),
  );
  const { layout, boxes, rootBox } = useMemo(() => {
    const boxes = new Map<number, NodeBox>();
    const rootBox = boxFor(rootLabel || "…", 0, [], 0, false, false, family);
    const layout = layoutMindMap(
      rootBox,
      visible,
      (node, depth) => {
        const n = node as LiveMindmapNode;
        const box = boxFor(
          mindmapNodeText(n),
          n.count,
          mindmapNodeDescriptions(n),
          depth,
          highlightDuplicates,
          detailed,
          family,
          rateLooks.get(n.id),
        );
        boxes.set(n.id, box);
        return box;
      },
      sidesRef.current,
    );
    return { layout, boxes, rootBox };
    // fontTick: re-measure after web fonts have loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rootLabel, detailed, highlightDuplicates, family, fontTick, uiLang, scoresKey]);
  // Hue per main branch (indexed like `PlacedNode.branch`): stable rank by
  // id over the full tree (hidden branches keep their rank), neighbours in
  // clockwise display order never share a hue.
  const branchHue = useMemo(() => {
    const stable = new Map(
      [...allNodes].map((n) => n.id).sort((a, b) => a - b).map((id, i) => [id, i] as const),
    );
    const mains = layout.nodes.filter((p) => p.depth === 1);
    const clockwise = [
      ...mains.filter((p) => p.side === 1).sort((a, b) => a.y - b.y),
      ...mains.filter((p) => p.side === -1).sort((a, b) => b.y - a.y),
    ].map((p) => p.id);
    const hues = branchHues(clockwise, stable);
    return visible.map((v) => MINDMAP_HUES[hues.get(v.id) ?? 0]);
  }, [layout, allNodes, visible]);
  useEffect(() => {
    if (!memoryKey) return;
    hueMemory.delete(memoryKey);
    hueMemory.set(memoryKey, new Map(visible.map((v, i) => [v.id, branchHue[i]] as const)));
    if (hueMemory.size > 20) hueMemory.delete(hueMemory.keys().next().value!);
  }, [branchHue, visible, memoryKey]);
  useEffect(() => {
    sidesRef.current = layout.sides;
    if (!memoryKey) return;
    sideMemory.delete(memoryKey);
    sideMemory.set(memoryKey, layout.sides);
    if (sideMemory.size > 20) sideMemory.delete(sideMemory.keys().next().value!);
  }, [layout, memoryKey]);

  // --- fresh nodes pop in (kept for the animation's duration, so live
  // re-renders in between don't cut it short) ---
  const seenRef = useRef<Set<number> | null>(null);
  const freshRef = useRef<Map<number, number>>(new Map());
  const now = Date.now();
  if (seenRef.current === null) {
    seenRef.current = new Set(byId.keys()); // first paint: no pops
  } else if (animate) {
    byId.forEach((_, id) => {
      if (!seenRef.current!.has(id)) freshRef.current.set(id, now + 700);
    });
  }
  useEffect(() => {
    // The previous render's ids: re-appearing terms (unhidden, an undone
    // merge) pop in like new ones.
    seenRef.current = new Set(byId.keys());
    freshRef.current.forEach((until, id) => {
      if (until < Date.now()) freshRef.current.delete(id);
    });
  });
  const isFresh = (id: number) => (freshRef.current.get(id) ?? 0) > now;

  // --- viewport: size, auto-fit, zoom/pan ---
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [view, setView] = useState({ s: 1, x: 0, y: 0, smooth: false });
  const [zoomOpen, setZoomOpen] = useState(false);
  const manual = useRef(false);
  const fitted = useRef(false);
  const { minX, maxX, minY, maxY } = layout.bounds;
  // Fixed overlays marked `data-beamer-inset` (QR corners, logo, counter,
  // edge handles) that cover the canvas: the auto-fit keeps clear of them.
  // They come and go independently of this component, so they are re-read
  // periodically (a handful of rects — cheap).
  const [obstacles, setObstacles] = useState<Obstacle[]>([]);
  useEffect(() => {
    let last = "";
    const read = () => {
      const el = containerRef.current;
      if (!el) return;
      const c = el.getBoundingClientRect();
      const list = [...document.querySelectorAll<HTMLElement>("[data-beamer-inset]")]
        .map((o) => o.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({
          x: Math.round(r.left - c.left),
          y: Math.round(r.top - c.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        }));
      const key = JSON.stringify(list);
      if (key !== last) {
        last = key;
        setObstacles(list);
      }
    };
    read();
    const id = window.setInterval(read, 800);
    return () => window.clearInterval(id);
  }, []);
  const fitView = useMemo(
    () =>
      fitAround({ minX, maxX, minY, maxY }, viewport.w, viewport.h, obstacles, {
        pad: FIT_PAD,
        maxScale: MAX_FIT,
      }),
    [minX, maxX, minY, maxY, viewport.w, viewport.h, obstacles],
  );
  useLayoutEffect(() => {
    if (viewport.w === 0 || manual.current) return;
    setView({ ...fitView, smooth: fitted.current });
    fitted.current = true;
  }, [fitView, viewport.w]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const zoomAt = (factor: number, px: number, py: number) => {
    const v = viewRef.current;
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s * factor));
    manual.current = true;
    setView({ s, x: px - ((px - v.x) * s) / v.s, y: py - ((py - v.y) * s) / v.s, smooth: false });
  };
  const zoomCentre = (factor: number) => {
    manual.current = true;
    const v = viewRef.current;
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s * factor));
    const px = viewport.w / 2;
    const py = viewport.h / 2;
    setView({ s, x: px - ((px - v.x) * s) / v.s, y: py - ((py - v.y) * s) / v.s, smooth: true });
  };
  const panBy = (dx: number, dy: number) => {
    manual.current = true;
    const v = viewRef.current;
    setView({ ...v, x: v.x + dx, y: v.y + dy, smooth: true });
  };
  const fit = () => {
    manual.current = false;
    setView({ ...fitView, smooth: true });
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const zoomCentreRef = useRef(zoomCentre);
  zoomCentreRef.current = zoomCentre;
  const panByRef = useRef(panBy);
  panByRef.current = panBy;

  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;
  // Wheel zoom (native listener: React's wheel handler is passive).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // Trackpad pinch arrives as wheel + ctrlKey with small deltas: a much
      // higher gain; mouse wheels keep the gentle one. Clamped per event so a
      // burst can't jump.
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.012 : 0.0015));
      zoomAtRef.current(
        Math.min(1.35, Math.max(1 / 1.35, factor)),
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // --- moderation: why a drop target is invalid (null = fine) ---
  const keyOf = (n: LiveMindmapNode) => n.key ?? n.text.toLowerCase();
  const isAncestor = (a: number, of: number) => {
    for (let p = tree.parent.get(of) ?? null; p !== null; p = tree.parent.get(p) ?? null)
      if (p === a) return true;
    return false;
  };
  const tooDeep = t("Too deep: the branch would go beyond the allowed number of levels.");
  const mergeProblem = (source: number, target: number): string | null => {
    if (isAncestor(source, target) || isAncestor(target, source))
      return t("A term cannot be merged with its own branch.");
    if ((tree.level.get(target) ?? 1) + (tree.height.get(source) ?? 1) - 1 > maxDepth)
      return tooDeep;
    return null;
  };
  const moveProblem = (node: number, parent: number | null): string | null => {
    if ((tree.parent.get(node) ?? null) === parent)
      return parent === null ? t("It already is a main branch.") : t("It is already attached here.");
    if (parent !== null && (parent === node || isAncestor(node, parent)))
      return t("A term cannot be moved into its own branch.");
    if ((parent === null ? 0 : (tree.level.get(parent) ?? 0)) + (tree.height.get(node) ?? 1) > maxDepth)
      return tooDeep;
    const moved = tree.node.get(node);
    const siblings = parent === null ? allNodes : (tree.node.get(parent)?.children ?? []);
    if (moved && siblings.some((c) => c.id !== node && keyOf(c) === keyOf(moved)))
      return t("A term with this name already exists there — drop it onto that term to merge.");
    return null;
  };

  // --- pointer: drag a term (moderation) or pan (background / root) ---
  type Target = { kind: "merge" | "move"; id: number | null; problem: string | null };
  interface NodeDrag {
    id: number;
    /** Pointer in world coordinates and the grab offset from the box centre. */
    wx: number;
    wy: number;
    ox: number;
    oy: number;
    /** Term whose body or "attach here" tab the pointer is over. */
    active: number | null;
    target: Target | null;
  }
  const [nodeDrag, setNodeDrag] = useState<NodeDrag | null>(null);
  const press = useRef<{
    id: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    /** Set when the press started on a draggable term. */
    node: number | null;
    started: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const toWorld = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - rect.left - v.x) / v.s, y: (clientY - rect.top - v.y) / v.s };
  };
  const placedById = useMemo(() => new Map(layout.nodes.map((p) => [p.id, p])), [layout]);
  // The "attach here" tab must never cover another term (bodies are merge
  // targets): beside a leaf the space is empty, so it is wide and labelled;
  // a term with children only has the gap before them (icon only). It stays
  // within the term's own band, so siblings are never covered either.
  const TAB_W = 128;
  const tabRect = (p: PlacedNode) => {
    const h = Math.max(p.h, 40);
    const w = (byId.get(p.id)?.children.length ?? 0) > 0 ? MIND_GAPS.x - 6 : TAB_W;
    const x0 = p.side === 1 ? p.x + p.w / 2 + 3 : p.x - p.w / 2 - 3 - w;
    return { x: x0, y: p.y - h / 2, w, h, narrow: w < TAB_W };
  };
  const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) =>
    x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  const hitTest = (
    dragId: number,
    x: number,
    y: number,
    active: number | null,
  ): { active: number | null; target: Target | null } => {
    const act = active !== null ? placedById.get(active) : undefined;
    if (act && inside(tabRect(act), x, y))
      return { active, target: { kind: "move", id: active, problem: moveProblem(dragId, active) } };
    for (let i = layout.nodes.length - 1; i >= 0; i--) {
      const p = layout.nodes[i];
      if (!inside({ x: p.x - p.w / 2 - 3, y: p.y - p.h / 2 - 3, w: p.w + 6, h: p.h + 6 }, x, y))
        continue;
      if (p.id === dragId) return { active: null, target: null };
      return { active: p.id, target: { kind: "merge", id: p.id, problem: mergeProblem(dragId, p.id) } };
    }
    const r = layout.root;
    if (Math.abs(x) <= r.w / 2 + 16 && Math.abs(y) <= r.h / 2 + 16)
      return { active: null, target: { kind: "move", id: null, problem: moveProblem(dragId, null) } };
    return { active: null, target: null };
  };

  // Move/up are followed on the window while a press lasts (more robust
  // than pointer capture: a release anywhere ends the drag, never leaving a
  // stale one behind that the next click would complete).
  const nodeDragRef = useRef(nodeDrag);
  nodeDragRef.current = nodeDrag;
  const winHandlers = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    cancel: () => void;
  }>(null!);
  const detach = useRef<(() => void) | null>(null);
  useEffect(() => () => detach.current?.(), []);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button, input, textarea, form")) return;
    if (editor) setEditor(null);
    detach.current?.();
    const move = (ev: PointerEvent) => winHandlers.current.move(ev);
    const up = (ev: PointerEvent) => winHandlers.current.up(ev);
    // Leaving the window (alt-tab, …) cancels like a drop on empty space.
    const blur = () => winHandlers.current.cancel();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", blur);
    detach.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", blur);
      detach.current = null;
    };
    const v = viewRef.current;
    const nodeEl = moderating
      ? (e.target as Element).closest<HTMLElement>("[data-mm-node]")
      : null;
    press.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      vx: v.x,
      vy: v.y,
      node: nodeEl ? Number(nodeEl.dataset.mmNode) : null,
      started: false,
    };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = press.current;
    if (!d || d.id !== e.pointerId) return;
    // Button released where we didn't see it (e.g. outside the window).
    if (e.buttons === 0) {
      onPointerUp(e);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.started) {
      if (Math.hypot(dx, dy) < 4) return;
      d.started = true;
      // Captured only once it really is a drag (plain clicks and double-
      // clicks still reach the term), so moves beyond the map keep coming.
      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
      if (d.node !== null) {
        const p = placedById.get(d.node);
        const start = toWorld(d.x, d.y);
        if (p) {
          setNodeDrag({ id: d.node, wx: start.x, wy: start.y, ox: start.x - p.x, oy: start.y - p.y, active: null, target: null });
        } else d.node = null;
      }
      if (d.node === null) setDragging(true);
    }
    if (d.node !== null) {
      const w = toWorld(e.clientX, e.clientY);
      setNodeDrag((nd) => {
        if (!nd) return nd;
        const hit = hitTest(nd.id, w.x, w.y, nd.active);
        return { ...nd, wx: w.x, wy: w.y, ...hit };
      });
      return;
    }
    manual.current = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy, smooth: false }));
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = press.current;
    if (d?.id !== e.pointerId) return;
    press.current = null;
    detach.current?.();
    setDragging(false);
    const nd = nodeDragRef.current;
    if (d.node === null || !nd) return;
    const { id, target } = nd;
    nodeDragRef.current = null;
    setNodeDrag(null);
    // Dropped on empty space or an invalid target: nothing happens.
    if (e.type !== "pointerup" || !target || target.problem) return;
    if (target.kind === "merge" && target.id !== null) onMerge?.(id, target.id);
    else if (target.kind === "move") onMove?.(id, target.id, tree.parent.get(id) ?? null);
  };

  const cancelPress = () => {
    press.current = null;
    detach.current?.();
    setDragging(false);
    nodeDragRef.current = null;
    setNodeDrag(null);
  };
  winHandlers.current = { move: onPointerMove, up: onPointerUp, cancel: cancelPress };

  // --- inline editor: "+" (add below a term / the root) and rename ---
  const [editor, setEditor] = useState<{ mode: "add" | "rename"; id: number | null } | null>(null);
  useEffect(() => {
    // The term went away (hidden, merged by someone else): close.
    if (editor && editor.id !== null && !placedById.has(editor.id)) setEditor(null);
  }, [editor, placedById]);

  // Keys: + / − zoom, 0 or F fit, Shift+arrows pan. Plain arrows stay the
  // presenter's question navigation.
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const step = 90;
      let handled = true;
      if (e.key === "+" || e.key === "=") zoomCentreRef.current(1.25);
      else if (e.key === "-" || e.key === "_") zoomCentreRef.current(1 / 1.25);
      else if (e.key === "0" || e.key === "f" || e.key === "F") fitRef.current();
      else if (e.shiftKey && e.key === "ArrowLeft") panByRef.current(step, 0);
      else if (e.shiftKey && e.key === "ArrowRight") panByRef.current(-step, 0);
      else if (e.shiftKey && e.key === "ArrowUp") panByRef.current(0, step);
      else if (e.shiftKey && e.key === "ArrowDown") panByRef.current(0, -step);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard]);

  const move = animate ? `${TRANSITION_MS}ms ${EASE}` : null;
  const worldTransition = move && view.smooth && !dragging ? `transform ${move}` : undefined;

  const nodeEl = (p: PlacedNode) => {
    const n = byId.get(p.id);
    const box = boxes.get(p.id);
    if (!n || !box) return null;
    const hue = branchHue[p.branch] ?? MINDMAP_HUES[0];
    const colors = { ...nodeColors(p.depth, hue) };
    const rl = rateLooks.get(p.id);
    // Rated terms: points deepen the fill with the score; plus/minus frames
    // the term green or rosé by the balance's sign. Unrated terms recede.
    let shadow: string | undefined = p.depth === 1 ? "0 2px 6px rgba(15,23,42,0.08)" : undefined;
    if (showScores && rl) {
      // The fill bar carries the score: the pill itself turns pale.
      colors.bg = `oklch(0.975 0.012 ${hue})`;
      if (rateMode === "points" && rl.r > 0) {
        colors.border = deep(hue);
        shadow = `0 ${Math.round(2 + 6 * rl.r)}px ${Math.round(6 + 14 * rl.r)}px rgba(15,23,42,${(0.08 + 0.14 * rl.r).toFixed(2)})`;
      } else if (rateMode === "updown") {
        colors.border = fill(hue);
        const sign = rl.badges.find((b) => b.tone === "balance")?.sign ?? 0;
        if (sign !== 0) colors.border = sign > 0 ? CORRECT_STRONG : MINUS_INK;
      }
    }
    const recede = showScores && !rl && !nodeDrag;
    const repeated =
      highlightDuplicates && !showScores && repeatedKeys.has(n.key ?? n.text.toLowerCase());
    const roundish = box.lines.length === 1 && box.desc.length === 0;
    const scoreTitle = rl
      ? rateMode === "points"
        ? t("{{count}} points", { count: Number(rl.badges[0].text) })
        : rl.badges.map((b) => b.text).join(" ")
      : "";
    const marks = previewMarks ? previewMarksOf(n, t) : [];
    const nodeTitle =
      [n.count > 1 ? `${n.count}×` : "", scoreTitle, lockedNote ?? "", ...marks.map((m) => m.title)]
        .filter(Boolean)
        .join(" · ") || undefined;
    const target =
      nodeDrag?.target?.kind === "merge" && nodeDrag.target.id === p.id ? nodeDrag.target : null;
    const ring = target
      ? `3px solid ${target.problem ? BAD : GOOD}`
      : marks.length > 0
        ? `3px solid ${AI_MARK}`
        : repeated
          ? `2px dashed ${deep(hue)}`
          : undefined;
    return (
      <div
        key={p.id}
        className="absolute left-0 top-0"
        data-mm-node={moderating ? p.id : undefined}
        style={{
          width: box.w,
          height: box.h,
          transform: `translate(${p.x - box.w / 2}px, ${p.y - box.h / 2}px)`,
          transition: move ? `transform ${move}, width ${move}, height ${move}, opacity 150ms` : undefined,
          opacity: dimmed.has(p.id) ? 0.3 : recede ? 0.55 : 1,
          cursor: moderating ? (nodeDrag ? "grabbing" : "grab") : undefined,
        }}
        onDoubleClick={
          onRename
            ? (e) => {
                e.stopPropagation();
                setEditor({ mode: "rename", id: p.id });
              }
            : undefined
        }
      >
        <div
          className={`group relative h-full w-full hover:z-10 focus-within:z-10 focus:outline-none ${isFresh(p.id) ? "ab-pop" : ""}`}
          title={nodeTitle}
          // With moderation the node takes focus (Tab), which reveals its ×.
          tabIndex={onHide || onAdd ? 0 : undefined}
          style={{
            background: colors.bg,
            border: `2px solid ${colors.border}`,
            borderRadius: roundish ? 9999 : 14,
            color: INK,
            padding: `${box.padY - 2}px ${box.padX - 2}px`,
            fontSize: box.font,
            fontWeight: box.weight,
            lineHeight: LINE,
            outline: ring,
            outlineOffset: ring ? 2 : undefined,
            boxShadow: shadow,
            // Moved terms take on their new branch's colour smoothly.
            transition: move
              ? `font-size ${move}, background-color ${move}, border-color ${move}, box-shadow ${move}`
              : undefined,
          }}
        >
          {showScores && rl && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden"
              style={{ borderRadius: roundish ? 9999 : 12 }}
            >
              {rl.bar.up > 0 && (
                <div
                  className="absolute inset-y-0 left-0"
                  style={{
                    width: `${(rl.bar.up * 100).toFixed(1)}%`,
                    background: rateMode === "points" ? fill(hue) : CORRECT_TINT,
                    transition: move ? `width ${move}` : undefined,
                  }}
                />
              )}
              {rl.bar.down > 0 && (
                <div
                  className="absolute inset-y-0 right-0"
                  style={{
                    width: `${(rl.bar.down * 100).toFixed(1)}%`,
                    background: MINUS_TINT,
                    transition: move ? `width ${move}` : undefined,
                  }}
                />
              )}
            </div>
          )}
          <div
            className="relative flex items-center"
            style={{ gap: box.badge || box.rate.length ? BADGE_GAP : 0 }}
          >
            <div className="min-w-0 flex-1">
              {box.lines.map((line, i) => (
                <div key={i} className="whitespace-nowrap">
                  {line}
                </div>
              ))}
            </div>
            {box.badge > 0 && (
              <span
                className="inline-flex shrink-0 items-center justify-center rounded-full bg-white/85 tabular-nums"
                style={{
                  minWidth: box.badge,
                  fontSize: Math.round(box.font * 0.68),
                  fontWeight: 700,
                  lineHeight: 1.45,
                  color: deep(hue),
                }}
              >
                {n.count}
              </span>
            )}
            {box.rate.length > 0 && (
              <span
                className="inline-flex shrink-0 items-center tabular-nums"
                style={{ gap: RATE_GAP, fontSize: box.rateFont, fontWeight: 700, lineHeight: 1.45 }}
                data-mm-score=""
              >
                {box.rate.map((b) => (
                  <RateBadgeEl key={b.tone} badge={b} font={box.rateFont} />
                ))}
              </span>
            )}
          </div>
          {box.desc.length > 0 && (
            <div
              className="relative text-slate-600"
              style={{ marginTop: 4, fontSize: box.descFont, fontWeight: 400, lineHeight: DESC_LINE }}
            >
              {box.desc.map((line, i) => (
                <div key={i} className="whitespace-nowrap">
                  {line}
                </div>
              ))}
            </div>
          )}
          {marks.length > 0 && (
            <span
              className="absolute -left-3 -top-3.5 flex gap-0.5"
              data-mm-mark={marks.map((m) => m.kind).join(" ")}
            >
              {marks.map((m) => (
                <span
                  key={m.kind}
                  title={m.title}
                  aria-label={m.title}
                  role="img"
                  className="flex h-6 w-6 items-center justify-center rounded-full text-white shadow-sm"
                  style={{ background: AI_MARK }}
                >
                  <m.Icon className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
                </span>
              ))}
            </span>
          )}
          {onHide && !nodeDrag && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur();
                onHide(n);
              }}
              className="absolute -right-2.5 -top-2.5 hidden h-6 w-6 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow-sm hover:bg-slate-100 hover:text-slate-800 group-focus-within:flex group-hover:flex"
              aria-label={t("Hide {{word}}", { word: mindmapNodeText(n) })}
              title={t("Hide {{word}}", { word: mindmapNodeText(n) })}
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.5} />
            </button>
          )}
          {onAdd && p.depth < maxDepth && !nodeDrag && (
            // In the gap on the outward side (clear of the × and the count);
            // the padding bridges the way from the term, so hover holds.
            <span
              className={`absolute top-1/2 hidden -translate-y-1/2 group-focus-within:flex group-hover:flex ${
                p.side === 1 ? "-right-10 pl-3" : "-left-10 pr-3"
              }`}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  e.currentTarget.blur();
                  setEditor({ mode: "add", id: p.id });
                }}
                className={PLUS_BTN}
                aria-label={t("Add a term below {{word}}", { word: mindmapNodeText(n) })}
                title={t("Add a term below {{word}}", { word: mindmapNodeText(n) })}
              >
                <Plus className="h-4 w-4" strokeWidth={2.75} />
              </button>
            </span>
          )}
        </div>
      </div>
    );
  };

  // While dragging: the dragged term's branch is dimmed, a ghost follows the
  // pointer, the hovered term offers its "attach here" tab, and a bubble
  // names the action (or why it isn't possible).
  const dimmed = useMemo(() => {
    const out = new Set<number>();
    if (!nodeDrag) return out;
    const walk = (n: LiveMindmapNode) => {
      out.add(n.id);
      n.children.forEach(walk);
    };
    const n = byId.get(nodeDrag.id);
    if (n) walk(n);
    return out;
  }, [nodeDrag, byId]);
  const dragOverlay = (): {
    world: ReactNode;
    bubble: { x: number; y: number; text: string; bad: boolean } | null;
  } | null => {
    if (!nodeDrag) return null;
    const src = byId.get(nodeDrag.id);
    const srcBox = boxes.get(nodeDrag.id);
    const srcPlaced = placedById.get(nodeDrag.id);
    if (!src || !srcBox || !srcPlaced) return null;
    const hue = branchHue[srcPlaced.branch] ?? MINDMAP_HUES[0];
    const colors = nodeColors(srcPlaced.depth, hue);
    const tgt = nodeDrag.target;
    const act = nodeDrag.active !== null ? placedById.get(nodeDrag.active) : undefined;
    const tabOn = tgt?.kind === "move" && tgt.id !== null && tgt.id === nodeDrag.active;
    const tabBad = tabOn && !!tgt?.problem;
    // Bubble anchor (world): above the target.
    let bubble: { x: number; y: number; text: string; bad: boolean } | null = null;
    if (tgt) {
      const word = (id: number) => mindmapNodeText(byId.get(id)!);
      if (tgt.kind === "merge" && tgt.id !== null) {
        const p = placedById.get(tgt.id)!;
        bubble = {
          x: p.x,
          y: p.y - p.h / 2 - 10,
          text: tgt.problem ?? t("Merge into “{{word}}”", { word: word(tgt.id) }),
          bad: !!tgt.problem,
        };
      } else if (tgt.id !== null && act) {
        const r = tabRect(act);
        bubble = {
          x: r.x + r.w / 2,
          y: r.y - 10,
          text: tgt.problem ?? t("Attach below “{{word}}”", { word: word(tgt.id) }),
          bad: !!tgt.problem,
        };
      } else if (tgt.id === null) {
        bubble = {
          x: 0,
          y: -layout.root.h / 2 - 22,
          text: tgt.problem ?? t("Make it a main branch"),
          bad: !!tgt.problem,
        };
      }
    }
    const rootOn = tgt?.kind === "move" && tgt.id === null;
    const r = layout.root;
    const world = (
      <>
        {/* Root zone: always marked while dragging. */}
        <div
          className="pointer-events-none absolute left-0 top-0 rounded-3xl"
          style={{
            width: r.w + 32,
            height: r.h + 32,
            transform: `translate(${-r.w / 2 - 16}px, ${-r.h / 2 - 16}px)`,
            border: `3px dashed ${rootOn ? (tgt?.problem ? BAD : GOOD) : "rgba(100,116,139,0.45)"}`,
            background: rootOn ? (tgt?.problem ? BAD_BG : GOOD_BG) : undefined,
          }}
        />
        {act && (
          <div
            data-mm-tab=""
            className="pointer-events-none absolute left-0 top-0 flex items-center justify-center gap-1 rounded-xl text-sm font-semibold"
            style={{
              ...(() => {
                const tr = tabRect(act);
                return { width: tr.w, height: tr.h, transform: `translate(${tr.x}px, ${tr.y}px)` };
              })(),
              border: `2px dashed ${tabOn ? (tabBad ? BAD : GOOD) : "rgba(100,116,139,0.6)"}`,
              background: tabOn ? (tabBad ? BAD_BG : GOOD_BG) : "rgba(255,255,255,0.85)",
              color: tabOn ? (tabBad ? BAD : GOOD) : "#475569",
            }}
          >
            <CornerDownRight className="h-4 w-4 shrink-0" aria-hidden />
            {!tabRect(act).narrow && t("Attach here")}
          </div>
        )}
        {/* Ghost of the dragged term. */}
        <div
          className="pointer-events-none absolute left-0 top-0 rounded-[14px] shadow-xl"
          style={{
            width: srcBox.w,
            height: srcBox.h,
            transform: `translate(${nodeDrag.wx - nodeDrag.ox - srcBox.w / 2}px, ${nodeDrag.wy - nodeDrag.oy - srcBox.h / 2}px) rotate(-2deg)`,
            background: colors.bg,
            border: `2px solid ${colors.border}`,
            color: INK,
            padding: `${srcBox.padY - 2}px ${srcBox.padX - 2}px`,
            fontSize: srcBox.font,
            fontWeight: srcBox.weight,
            lineHeight: LINE,
            opacity: 0.78,
          }}
        >
          {srcBox.lines.map((line, i) => (
            <div key={i} className="whitespace-nowrap">
              {line}
            </div>
          ))}
        </div>
      </>
    );
    return { world, bubble };
  };
  const drag = dragOverlay();
  // The bubble lives in screen space (readable at any zoom), kept inside the
  // map's edges.
  const bubbleEl = () => {
    const b = drag?.bubble;
    if (!b) return null;
    const half = 170;
    const x = Math.min(
      Math.max(view.x + b.x * view.s, half),
      Math.max(half, viewport.w - half),
    );
    const y = Math.max(view.y + b.y * view.s, 8);
    return (
      <div
        role="status"
        className="pointer-events-none absolute z-20 max-w-xs rounded-lg px-2.5 py-1 text-center text-sm font-semibold text-white shadow-md"
        style={{
          left: x,
          top: y,
          transform: `translate(-50%, ${y > 40 ? "-100%" : "0"})`,
          width: "max-content",
          background: b.bad ? BAD : GOOD,
        }}
      >
        {b.text}
      </div>
    );
  };

  // The inline form sits in screen space next to its term (not scaled with
  // the zoom, so it stays readable).
  const editorEl = () => {
    if (!editor) return null;
    const p = editor.id !== null ? placedById.get(editor.id) : undefined;
    if (editor.id !== null && !p) return null;
    const n = editor.id !== null ? byId.get(editor.id) : undefined;
    const sx = (wx: number) => view.x + wx * view.s;
    const sy = (wy: number) => view.y + wy * view.s;
    // Top-left corner of the form (approximate size), kept inside the map.
    const W = 290;
    const H = withDescriptions && editor.mode === "add" ? 160 : 120;
    let left: number;
    let top: number;
    if (editor.mode === "rename" && p) {
      left = sx(p.x) - W / 2;
      top = sy(p.y) - H / 2;
    } else if (p) {
      const edge = sx(p.x + p.side * (p.w / 2 + 18));
      left = p.side === 1 ? edge : edge - W;
      top = sy(p.y) - H / 2;
    } else {
      left = sx(0) - W / 2;
      top = sy(layout.root.h / 2 + 18);
    }
    const style: CSSProperties = {
      left: Math.max(8, Math.min(left, viewport.w - W - 8)),
      top: Math.max(8, Math.min(top, viewport.h - H - 8)),
    };
    return (
      <MindEditor
        key={`${editor.mode}:${editor.id}`}
        style={style}
        mode={editor.mode}
        // Predefined terms are renamed in the canonical language: pre-fill
        // that (`text`), not the UI-language display.
        initial={editor.mode === "rename" && n ? n.text : ""}
        canonicalNote={editor.mode === "rename" && !!n && mindmapNodeText(n) !== n.text}
        parentLabel={editor.mode === "add" ? (n ? mindmapNodeText(n) : rootLabel) : ""}
        withDescription={editor.mode === "add" && withDescriptions}
        onCancel={() => setEditor(null)}
        onSubmit={(text, description) => {
          setEditor(null);
          if (editor.mode === "add") onAdd?.(editor.id, text, description);
          else if (editor.id !== null && n && text !== n.text) onRename?.(editor.id, text);
        }}
      />
    );
  };

  const ctl =
    "flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900";
  const zoomButtons = (
    <>
      <button
        type="button"
        className={ctl}
        onClick={(e) => {
          e.currentTarget.blur();
          zoomCentre(1 / 1.25);
        }}
        aria-label={t("Zoom out (−)")}
        title={t("Zoom out (−)")}
      >
        <Minus className="h-5 w-5" />
      </button>
      <button
        type="button"
        className={ctl}
        onClick={(e) => {
          e.currentTarget.blur();
          zoomCentre(1.25);
        }}
        aria-label={t("Zoom in (+)")}
        title={t("Zoom in (+)")}
      >
        <Plus className="h-5 w-5" />
      </button>
      <button
        type="button"
        className={ctl}
        onClick={(e) => {
          e.currentTarget.blur();
          fit();
        }}
        aria-label={t("Fit to screen (0)")}
        title={t("Fit to screen (0)")}
      >
        <Maximize2 className="h-5 w-5" />
      </button>
    </>
  );
  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full select-none overflow-hidden ${dragging || nodeDrag ? "cursor-grabbing" : "cursor-grab"}`}
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      data-testid="mindmap"
    >
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          transformOrigin: "0 0",
          transition: worldTransition,
        }}
      >
        <svg className="absolute left-0 top-0 overflow-visible" width={1} height={1} aria-hidden>
          {layout.edges.map((e) => {
            const st = edgeStyle(e.depth, branchHue[e.branch] ?? MINDMAP_HUES[0]);
            return (
              <path
                key={e.id}
                d={e.d}
                fill="none"
                stroke={st.stroke}
                strokeWidth={st.width}
                strokeLinecap="round"
                className={isFresh(e.id) ? "ab-fade-in" : undefined}
                style={
                  {
                    // CSS `d` animates the connector along with its nodes
                    // (Chromium/Firefox; elsewhere it simply jumps).
                    d: `path("${e.d}")`,
                    transition: move ? `d ${move}` : undefined,
                  } as CSSProperties
                }
              />
            );
          })}
        </svg>
        {/* Root: clearly the centre. */}
        <div
          className="group absolute left-0 top-0 flex flex-col items-center justify-center rounded-2xl text-center text-white shadow-lg focus:outline-none"
          tabIndex={onAdd ? 0 : undefined}
          title={lockedNote}
          style={{
            width: rootBox.w,
            height: rootBox.h,
            transform: `translate(${-rootBox.w / 2}px, ${-rootBox.h / 2}px)`,
            transition: move ? `transform ${move}, width ${move}, height ${move}` : undefined,
            background: INK,
            fontSize: rootBox.font,
            fontWeight: rootBox.weight,
            lineHeight: LINE,
          }}
        >
          {rootBox.lines.map((line, i) => (
            <div key={i} className="whitespace-nowrap">
              {line}
            </div>
          ))}
          {onAdd && !nodeDrag && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.currentTarget.blur();
                setEditor({ mode: "add", id: null });
              }}
              className={`${PLUS_BTN} absolute -bottom-3.5 left-1/2 hidden -translate-x-1/2 group-focus-within:flex group-hover:flex`}
              aria-label={t("Add a main branch")}
              title={t("Add a main branch")}
            >
              <Plus className="h-4 w-4" strokeWidth={2.75} />
            </button>
          )}
        </div>
        {layout.nodes.map(nodeEl)}
        {drag?.world}
      </div>
      {bubbleEl()}
      {editor && editorEl()}
      {visible.length === 0 && (
        <p
          className="pointer-events-none absolute inset-x-0 text-center text-lg text-slate-400"
          style={{ top: `calc(50% + ${(rootBox.h / 2) * view.s + 24}px)` }}
        >
          {t("No terms yet …")}
        </p>
      )}
      {zoomHandleTop === undefined ? (
        // Zoom controls (bottom right; the presenter's keys stay untouched).
        <div className="absolute bottom-2 right-2 flex flex-col-reverse rounded-xl border border-slate-200 bg-white/90 p-0.5 shadow-sm backdrop-blur">
          {zoomButtons}
        </div>
      ) : (
        // Beamer: a right-edge handle like the moderation pencil; collapsed
        // it shows one icon, expanded it opens to the left (− + fit), so it
        // never grows into the handles above or below it.
        <div
          data-beamer-inset=""
          className="fixed right-0 z-30 flex items-center rounded-l-xl border border-r-0 border-slate-200 bg-white/95 text-slate-500 shadow-md"
          style={{ top: zoomHandleTop }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {zoomOpen && <div className="flex items-center pl-1">{zoomButtons}</div>}
          <button
            type="button"
            className="p-3 hover:text-slate-800"
            onClick={(e) => {
              e.currentTarget.blur();
              setZoomOpen((o) => !o);
            }}
            aria-expanded={zoomOpen}
            aria-label={zoomOpen ? t("Hide zoom controls") : t("Zoom")}
            title={zoomOpen ? t("Hide zoom controls") : t("Zoom")}
          >
            {zoomOpen ? <ChevronRight className="h-5 w-5" /> : <ZoomIn className="h-5 w-5" />}
          </button>
        </div>
      )}
    </div>
  );
}

/** Accent of the AI preview marks (violet, clear of the pastel branch fills
 *  and of the green/red drag feedback; white icons pass 4.5:1). */
export const AI_MARK = "oklch(0.48 0.17 290)";

type MarkKind = "merged" | "renamed" | "moved" | "new";
/** The preview marks of a term, in a fixed order. */
function previewMarksOf(
  n: LiveMindmapNode,
  t: ReturnType<typeof useTranslation>["t"],
): { kind: MarkKind; title: string; Icon: typeof Merge }[] {
  const out: { kind: MarkKind; title: string; Icon: typeof Merge }[] = [];
  if (n.new) out.push({ kind: "new", title: t("New parent term"), Icon: FolderPlus });
  if (n.merged_from?.length)
    out.push({
      kind: "merged",
      title: t("Merged from {{terms}}", {
        terms: n.merged_from.join(", "),
      }),
      Icon: Merge,
    });
  if (n.renamed_from)
    out.push({
      kind: "renamed",
      title: t("Renamed: {{old}} → {{new}}", { old: n.renamed_from, new: mindmapNodeText(n) }),
      Icon: Languages,
    });
  if (n.moved) out.push({ kind: "moved", title: t("Moved here"), Icon: MoveRight });
  return out;
}

/** One rating badge on a term: points as a dark dot-voting pill, plus/minus
 *  as green / rosé counts and a balance pill tinted by its sign. */
function RateBadgeEl({ badge, font }: { badge: RateBadge & { w: number }; font: number }) {
  if (badge.tone === "points")
    return (
      <span
        className="inline-flex items-center justify-center rounded-full text-white"
        style={{ minWidth: badge.w, gap: 4, background: INK }}
      >
        <span
          aria-hidden
          className="inline-block rounded-full"
          style={{ width: Math.round(font * 0.5), height: Math.round(font * 0.5), background: CORRECT }}
        />
        {badge.text}
      </span>
    );
  if (badge.tone === "balance")
    return (
      <span
        className="inline-flex items-center justify-center rounded-full"
        style={{
          minWidth: badge.w,
          color: INK,
          background:
            (badge.sign ?? 0) > 0 ? CORRECT : (badge.sign ?? 0) < 0 ? MINUS : NEUTRAL_TILE,
        }}
      >
        {badge.text}
      </span>
    );
  return (
    <span
      className="inline-block text-center"
      style={{ minWidth: badge.w, color: badge.tone === "up" ? CORRECT_STRONG : MINUS_INK }}
    >
      {badge.text}
    </span>
  );
}

/** Inline form for "+" (term + optional description) and rename. Enter
 * submits, Esc cancels; the limits match the participant page. */
function MindEditor({
  style,
  mode,
  initial,
  parentLabel,
  withDescription,
  canonicalNote = false,
  onSubmit,
  onCancel,
}: {
  style: CSSProperties;
  /** Rename of a predefined term shown in another language than the
   *  canonical one: say which language is edited. */
  canonicalNote?: boolean;
  mode: "add" | "rename";
  initial: string;
  parentLabel: string;
  withDescription: boolean;
  onSubmit: (text: string, description?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [description, setDescription] = useState("");
  const titleRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);
  const submit = () => {
    const term = text.trim();
    if (!term) return;
    onSubmit(term, description.trim() || undefined);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  const field =
    "w-64 rounded-lg border border-field bg-white px-2.5 py-1.5 text-base text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-200";
  return (
    <form
      className="absolute z-20 flex flex-col gap-1.5 rounded-xl border border-slate-200 bg-white/95 p-2 shadow-lg backdrop-blur"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="text-xs font-semibold text-slate-500">
        {mode === "add"
          ? t("New term below “{{word}}”", { word: parentLabel })
          : t("Rename term")}
      </label>
      <input
        ref={titleRef}
        value={text}
        maxLength={60}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("Term")}
        aria-label={t("Term")}
        className={field}
      />
      {canonicalNote && (
        <p className="w-64 text-xs text-slate-500">
          {t("Predefined terms are renamed in their original language.")}
        </p>
      )}
      {withDescription && (
        <input
          value={description}
          maxLength={200}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("Description (optional)")}
          aria-label={t("Description (optional)")}
          className={field}
        />
      )}
      <div className="flex items-center justify-end gap-1.5 text-sm">
        <span className="mr-auto text-xs text-slate-400">{t("Enter saves · Esc cancels")}</span>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-2 py-1 text-slate-600 hover:bg-slate-100"
        >
          {t("Cancel")}
        </button>
        <button
          type="submit"
          disabled={!text.trim()}
          className="rounded-lg bg-brand-600 px-2.5 py-1 font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
        >
          {mode === "add" ? t("Add") : t("Save")}
        </button>
      </div>
    </form>
  );
}
