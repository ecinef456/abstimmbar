// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Render-time collision avoidance of the four-field matrix cards.
 *
 *  The stored (x, y) of a card stays as it is; only where it is DRAWN moves:
 *  each card wants its centre at its stored point, overlapping cards are
 *  pushed apart in a few deterministic relaxation passes (along the axis of
 *  the smaller overlap, half each; a fixed item — the card being dragged,
 *  an obstacle like the quadrant magnifiers — does not move), and every
 *  card's centre is kept inside its zone (fully inside, where the card
 *  fits) and the card inside the plot. Pure: same input, same output. */

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
const PASSES = 120;

/** Allowed range of a centre on one axis: fully inside the zone and the
 *  plot where the card fits; else the centre stays within the zone. */
function range(z0: number, z1: number, half: number, plot: number): [number, number] {
  const lo = Math.max(z0 + half, half);
  const hi = Math.min(z1 - half, plot - half);
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
  const overlap = (i: number, j: number) => ({
    ox: (items[i].w + items[j].w) / 2 + GAP - Math.abs(cx[j] - cx[i]),
    oy: (items[i].h + items[j].h) / 2 + GAP - Math.abs(cy[j] - cy[i]),
  });
  /** Push i and j apart along one axis by `amount`; returns whether either moved. */
  const push = (i: number, j: number, axis: "x" | "y", amount: number) => {
    const c = axis === "x" ? cx : cy;
    const clamp = axis === "x" ? clampX : clampY;
    const d = c[j] - c[i];
    // Coincident centres: the later item goes right / down.
    const sign = d > 0 ? 1 : d < 0 ? -1 : 1;
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
  for (let pass = 0; pass < PASSES; pass++) {
    let any = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (items[i].fixed && items[j].fixed) continue;
        const { ox, oy } = overlap(i, j);
        if (ox <= 0 || oy <= 0) continue;
        any = true;
        const first = ox <= oy ? "x" : "y";
        if (!push(i, j, first, first === "x" ? ox : oy)) {
          // That way is blocked: try the other axis.
          const again = overlap(i, j);
          if (again.ox > 0 && again.oy > 0) push(i, j, first === "x" ? "y" : "x", first === "x" ? again.oy : again.ox);
        }
      }
    }
    if (!any) break;
  }
  return new Map(items.map((it, i) => [it.id, { cx: cx[i], cy: cy[i] }]));
}
