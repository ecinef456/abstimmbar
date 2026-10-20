// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Client mirror of backend/live/matrix.py geometry (EDGE_BAND, HYSTERESIS,
 *  zone_rect, zone_at, resolve_zone, clamp_to_zone). Used for the drag preview
 *  only — the server's answer is authoritative.
 *
 *  Board space: x, y ∈ [−1, 1], x −1 = left, y +1 = top. Pixel space (see
 *  `toPixel`): origin top-left, y grows downwards. */
export type Zone = "q1" | "q2" | "q3" | "q4" | "e_top" | "e_right" | "e_bottom" | "e_left";

export const ZONES: readonly Zone[] = ["q1", "q2", "q3", "q4", "e_top", "e_right", "e_bottom", "e_left"];
const QUADRANTS = ZONES.slice(0, 4) as Zone[];
const EDGES = ZONES.slice(4) as Zone[];
/** Reading order of the fields (top row q2, q1; bottom row q3, q4; then the
 *  edges) — the order of the zone pickers (participant page, beamer) and of
 *  every field-grouped list (participant rating list in
 *  live/matrix_rating.py READING_ORDER, results list). */
export const READING_ZONES: readonly Zone[] = ["q2", "q1", "q3", "q4", "e_top", "e_right", "e_bottom", "e_left"];

export const EDGE_BAND = 0.12;
export const HYSTERESIS = 0.12;

/** [xmin, xmax, ymin, ymax] of a zone. */
export type Rect = [number, number, number, number];

const clip = (v: number) => Math.max(-1, Math.min(1, v));

export function zoneRect(zone: Zone, edges: boolean): Rect {
  const b = edges ? EDGE_BAND : 0;
  switch (zone) {
    case "q1": return [b, 1, b, 1];
    case "q2": return [-1, -b, b, 1];
    case "q3": return [-1, -b, -1, -b];
    case "q4": return [b, 1, -1, -b];
    case "e_top": return [-b, b, b, 1];
    case "e_bottom": return [-b, b, -1, -b];
    case "e_right": return [b, 1, -b, b];
    case "e_left": return [-1, -b, -b, b];
  }
}

const zonesFor = (edges: boolean): Zone[] => (edges ? [...ZONES] : QUADRANTS);

function distance(zone: Zone, x: number, y: number, edges: boolean): number {
  const [xmin, xmax, ymin, ymax] = zoneRect(zone, edges);
  const dx = Math.max(xmin - x, 0, x - xmax);
  const dy = Math.max(ymin - y, 0, y - ymax);
  return Math.hypot(dx, dy);
}

/** The zone containing (x, y); outside all rectangles the nearest one, ties
 *  broken by ZONES order (as the server). */
export function zoneAt(x: number, y: number, edges: boolean): Zone {
  x = clip(x);
  y = clip(y);
  let best: Zone = "q1";
  let bestDistance = Infinity;
  for (const zone of zonesFor(edges)) {
    const d = distance(zone, x, y, edges);
    if (d < bestDistance) {
      best = zone;
      bestDistance = d;
    }
  }
  return best;
}

/** Hysteresis: `current` sticks until the point is more than HYSTERESIS away
 *  from its rectangle. A forbidden current zone never sticks. */
export function resolveZone(current: Zone | string, x: number, y: number, edges: boolean): Zone {
  x = clip(x);
  y = clip(y);
  const allowed = zonesFor(edges);
  if (allowed.includes(current as Zone) && distance(current as Zone, x, y, edges) <= HYSTERESIS) {
    return current as Zone;
  }
  return zoneAt(x, y, edges);
}

/** Pull a point into a zone; edge cards are pinned onto their axis line. */
export function clampToZone(zone: Zone, x: number, y: number, edges: boolean): [number, number] {
  let [xmin, xmax, ymin, ymax] = zoneRect(zone, edges);
  if (EDGES.includes(zone)) {
    if (zone === "e_top" || zone === "e_bottom") xmin = xmax = 0;
    else ymin = ymax = 0;
  }
  return [Math.min(Math.max(clip(x), xmin), xmax), Math.min(Math.max(clip(y), ymin), ymax)];
}

export interface Box {
  width: number;
  height: number;
}

/** Board point → pixel offset inside the box (top-left origin). */
export function toPixel(x: number, y: number, box: Box): [number, number] {
  return [((x + 1) / 2) * box.width, ((1 - y) / 2) * box.height];
}

/** Pixel offset inside the box → board point (not clamped). */
export function fromPixel(px: number, py: number, box: Box): [number, number] {
  return [(px / box.width) * 2 - 1, 1 - (py / box.height) * 2];
}
