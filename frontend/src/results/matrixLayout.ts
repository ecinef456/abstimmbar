// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Render-time collision avoidance of the four-field matrix cards.
 *
 *  The stored (x, y) of a card stays as it is; only where it is DRAWN moves:
 *  each card wants its centre at its stored point, overlapping cards are
 *  pushed apart in a few deterministic relaxation passes (along the axis of
 *  the smaller overlap, half each; a fixed item — the card being dragged,
 *  an obstacle like the quadrant magnifiers — does not move), and every
 *  card's footprint (incl. a stack's paper offset) is kept inside its zone
 *  where it fits (else its centre stays in the zone) and inside the plot,
 *  a little clear of the border. Pure: same input, same output.
 *
 *  A pair is always pushed apart in the order of its WANTED centres (left /
 *  right, above / below; equal: the lower id goes left / up) — never in the
 *  order of where they happen to be drawn. Clamping into the zone can swap
 *  that drawn order (a taller card's centre is held further from the
 *  border), and pushing by it would flip the arrangement the teacher made,
 *  e.g. when the detailed cards grow. */

export interface LayoutRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LayoutItem {
  id: number;
  /** Wanted centre (px, plot coordinates). */
  cx: number;
  cy: number;
  /** Footprint incl. the stacked-paper shadow (px). */
  w: number;
  h: number;
  /** The card's zone in px; its centre never leaves it. */
  zone: LayoutRect;
  /** Does not move (dragged card, obstacle). */
  fixed?: boolean;
}

const GAP = 4;
/** Distance kept from the plot border (px). */
const INSET = 2;
const PASSES = 120;

/** Allowed range of a centre on one axis: fully inside the zone and the
 *  plot where the card fits; else the centre stays within the zone. */
function range(z0: number, z1: number, half: number, plot: number): [number, number] {
  const lo = Math.max(z0 + half, half + INSET);
  const hi = Math.min(z1 - half, plot - half - INSET);
  if (lo <= hi) return [lo, hi];
  const flo = Math.max(z0, Math.min(half, plot / 2));
  const fhi = Math.min(z1, Math.max(plot - half, plot / 2));
  if (flo <= fhi) return [flo, fhi];
  const mid = (z0 + z1) / 2;
  return [mid, mid];
}

/** Drawn centres (by id) of the items after relaxation. */
export function relaxCards(
  items: LayoutItem[],
  plot: { width: number; height: number },
): Map<number, { cx: number; cy: number }> {
  const n = items.length;
  const xr = items.map((it) => range(it.zone.x0, it.zone.x1, it.w / 2, plot.width));
  const yr = items.map((it) => range(it.zone.y0, it.zone.y1, it.h / 2, plot.height));
  const clampX = (i: number, v: number) => (items[i].fixed ? items[i].cx : Math.max(xr[i][0], Math.min(xr[i][1], v)));
  const clampY = (i: number, v: number) => (items[i].fixed ? items[i].cy : Math.max(yr[i][0], Math.min(yr[i][1], v)));
  const cx = items.map((it, i) => clampX(i, it.cx));
  const cy = items.map((it, i) => clampY(i, it.cy));
  // Overlap of a pair per axis (allocation-free; ≤ 0: apart on that axis).
  const overlapX = (i: number, j: number) => (items[i].w + items[j].w) / 2 + GAP - Math.abs(cx[j] - cx[i]);
  const overlapY = (i: number, j: number) => (items[i].h + items[j].h) / 2 + GAP - Math.abs(cy[j] - cy[i]);
  /** Side of j relative to i on an axis (+1: j right of / below i, −1:
   *  left of / above). Two cards keep the order of their WANTED centres
   *  (ties by id); against a fixed item (obstacle, dragged card) — and as
   *  the last resort when that order is blocked by walls — the order in
   *  which they are drawn. */
  const side = (i: number, j: number, axis: "x" | "y", drawn: boolean) => {
    const wanted = !drawn && !items[i].fixed && !items[j].fixed;
    const d = axis === "x" ? (wanted ? items[j].cx - items[i].cx : cx[j] - cx[i]) : wanted ? items[j].cy - items[i].cy : cy[j] - cy[i];
    if (Math.abs(d) > 0.5) return d > 0 ? 1 : -1;
    return items[j].id > items[i].id ? 1 : -1;
  };
  /** How far i and j must still move apart on an axis to be clear of each
   *  other on that side (more than the overlap when drawn the other way). */
  const need = (i: number, j: number, axis: "x" | "y", sign: number) =>
    axis === "x"
      ? (items[i].w + items[j].w) / 2 + GAP - sign * (cx[j] - cx[i])
      : (items[i].h + items[j].h) / 2 + GAP - sign * (cy[j] - cy[i]);
  /** Push i and j apart along one axis (j to the `sign` side of i) until
   *  clear; returns whether either moved. */
  const push = (i: number, j: number, axis: "x" | "y", sign: number) => {
    const c = axis === "x" ? cx : cy;
    const clamp = axis === "x" ? clampX : clampY;
    const amount = need(i, j, axis, sign);
    const fi = !!items[i].fixed;
    const fj = !!items[j].fixed;
    const oi = c[i];
    const oj = c[j];
    const mi = fi ? 0 : fj ? amount : amount / 2;
    const mj = fj ? 0 : fi ? amount : amount / 2;
    c[i] = clamp(i, oi - sign * mi);
    c[j] = clamp(j, oj + sign * mj);
    // Blocked on one side (zone wall): the other one takes the rest.
    const got = () => Math.abs(c[i] - oi) + Math.abs(c[j] - oj);
    if (got() < amount - 0.5 && !fj) c[j] = clamp(j, c[j] + sign * (amount - got()));
    if (got() < amount - 0.5 && !fi) c[i] = clamp(i, c[i] - sign * (amount - got()));
    return Math.abs(c[i] - oi) + Math.abs(c[j] - oj) > 0.01;
  };
  /** One relaxation pass; false when nothing overlapped any more. `keep`:
   *  pairs of cards keep their wanted order (else the drawn order). */
  const relax = (keep: boolean) => {
    let any = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (items[i].fixed && items[j].fixed) continue;
        if (overlapX(i, j) <= 0 || overlapY(i, j) <= 0) continue;
        any = true;
        const sx = side(i, j, "x", !keep);
        const sy = side(i, j, "y", !keep);
        const first = need(i, j, "x", sx) <= need(i, j, "y", sy) ? "x" : "y";
        const other = first === "x" ? "y" : "x";
        const stillOverlap = () => overlapX(i, j) > 0 && overlapY(i, j) > 0;
        // That way blocked (zone wall): the other axis; both blocked: the
        // drawn order.
        if (push(i, j, first, first === "x" ? sx : sy)) continue;
        if (stillOverlap() && push(i, j, other, other === "x" ? sx : sy)) continue;
        if (keep && stillOverlap()) {
          const axis = overlapX(i, j) <= overlapY(i, j) ? "x" : "y";
          if (!push(i, j, axis, side(i, j, axis, true)) && stillOverlap()) {
            const rest = axis === "x" ? "y" : "x";
            push(i, j, rest, side(i, j, rest, true));
          }
        }
      }
    }
    return any;
  };
  let done = false;
  for (let pass = 0; pass < PASSES && !done; pass++) done = !relax(true);
  if (!done) {
    // Too crowded to keep every order (the passes keep undoing each other):
    // start over and push apart by the drawn order alone.
    items.forEach((it, i) => {
      cx[i] = clampX(i, it.cx);
      cy[i] = clampY(i, it.cy);
    });
    for (let pass = 0; pass < PASSES && !done; pass++) done = !relax(false);
  }
  return new Map(items.map((it, i) => [it.id, { cx: cx[i], cy: cy[i] }]));
}
