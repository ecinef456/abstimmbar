// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Zoom/pan of the whole matrix board on the beamer, modelled on the mind
 *  map (MindMap.tsx): the board (the "world": labels, plot, cards, legend at
 *  their overview size) is scaled and moved with one CSS transform inside
 *  the viewport. Wheel / trackpad pinch zoom at the pointer, dragging empty
 *  space pans, + / − / 0 and Shift+arrows on the keyboard. A quadrant can be
 *  focused: the view animates so the quadrant fills the viewport; [ / ] step
 *  through the quadrants in reading order (q2 → q1 → q3 → q4), Esc / 0
 *  return to the overview. The view never zooms out below the overview and
 *  the board always covers the viewport where it is larger than it. Card
 *  interaction keeps working because the board maps pointers through its
 *  transformed bounding box. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

export type Quadrant = "q1" | "q2" | "q3" | "q4";
export const QUADRANT_ORDER: Quadrant[] = ["q2", "q1", "q3", "q4"];

export interface View {
  s: number;
  x: number;
  y: number;
  /** Animate the change (buttons, keys, focus) — not wheel or drag. */
  smooth: boolean;
}

const MAX_ZOOM = 4;
const STEP = 1.25;
const PAN_STEP = 90;
/** Margin of the stage around a focused quadrant (px, viewport); on top it
 *  leaves room for the focus bar. */
const FOCUS_PAD = 12;
const FOCUS_TOP = 60;
/** A focused quadrant shows this much (px, board) past its inner axis lines. */
const INNER = 3;
/** Margin around the outer axis labels (px, board). */
const LABEL_PAD = 4;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Layout rect of `el` in `root`'s coordinates (offsets, so the transform
 *  on `root` does not matter). */
function rectIn(el: HTMLElement, root: HTMLElement): Rect {
  let x = 0;
  let y = 0;
  let e: HTMLElement | null = el;
  while (e && e !== root) {
    x += e.offsetLeft;
    y += e.offsetTop;
    const parent = e.offsetParent as HTMLElement | null;
    if (parent && parent !== root) {
      x += parent.clientLeft;
      y += parent.clientTop;
    }
    e = parent;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

interface Size {
  w: number;
  h: number;
}

/** Keep the board covering the viewport (centred where it is smaller). */
export function clampView(v: View, world: Size, vp: Size): View {
  const s = Math.max(1, Math.min(MAX_ZOOM, v.s));
  const axis = (pos: number, size: number, avail: number) => {
    const scaled = size * s;
    if (scaled <= avail) return (avail - scaled) / 2;
    return Math.min(0, Math.max(avail - scaled, pos));
  };
  return { s, x: axis(v.x, world.w, vp.w), y: axis(v.y, world.h, vp.h), smooth: v.smooth };
}

export function useMatrixView({
  viewportRef,
  worldRef,
  enabled,
  worldKey,
}: {
  viewportRef: RefObject<HTMLElement>;
  worldRef: RefObject<HTMLElement>;
  /** Keys active (no dialog / drawer in the way). */
  enabled: boolean;
  /** Changes when the board element is (re)created or resized. */
  worldKey: unknown;
}) {
  const [vp, setVp] = useState<Size>({ w: 0, h: 0 });
  const [world, setWorld] = useState<Size>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0, smooth: false });
  const [focus, setFocus] = useState<Quadrant | null>(null);
  /** clip-path of the board while a quadrant is focused. */
  const [clip, setClip] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const sizes = useRef({ vp, world });
  sizes.current = { vp, world };

  // Sizes of the viewport and the (untransformed) board.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      setVp((p) => (p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }));
      const w = worldRef.current;
      if (w) setWorld((p) => (p.w === w.offsetWidth && p.h === w.offsetHeight ? p : { w: w.offsetWidth, h: w.offsetHeight }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (worldRef.current) ro.observe(worldRef.current);
    return () => ro.disconnect();
  }, [viewportRef, worldRef, worldKey]);

  /** The free stage inside the viewport (viewport coordinates): clear of
   *  the focus bar on top and of fixed overlays (`data-beamer-inset`: edge
   *  handles, LiveStats, QR, logo) — each overlay cuts the side that costs
   *  the least area. */
  const stage = useCallback((): Rect | null => {
    const el = viewportRef.current;
    if (!el) return null;
    const v = el.getBoundingClientRect();
    let x0 = FOCUS_PAD;
    let y0 = FOCUS_TOP;
    let x1 = v.width - FOCUS_PAD;
    let y1 = v.height - FOCUS_PAD;
    for (const o of document.querySelectorAll<HTMLElement>("[data-beamer-inset]")) {
      if (el.contains(o)) continue;
      const r = o.getBoundingClientRect();
      const l = r.left - v.left;
      const t = r.top - v.top;
      const rr = r.right - v.left;
      const b = r.bottom - v.top;
      if (r.width === 0 || r.height === 0 || rr <= x0 || l >= x1 || b <= y0 || t >= y1) continue;
      const cuts = [
        { side: "right", cost: (x1 - (l - FOCUS_PAD)) * (y1 - y0) },
        { side: "left", cost: (rr + FOCUS_PAD - x0) * (y1 - y0) },
        { side: "bottom", cost: (y1 - (t - FOCUS_PAD)) * (x1 - x0) },
        { side: "top", cost: (b + FOCUS_PAD - y0) * (x1 - x0) },
      ].sort((a, c) => a.cost - c.cost);
      const side = cuts[0].side;
      if (side === "right") x1 = l - FOCUS_PAD;
      else if (side === "left") x0 = rr + FOCUS_PAD;
      else if (side === "bottom") y1 = t - FOCUS_PAD;
      else y0 = b + FOCUS_PAD;
    }
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }, [viewportRef]);

  /** Framing of a quadrant: the quadrant's rect plus its two outer axis
   *  labels (board coordinates), fitted uniformly and centred into the
   *  stage; everything else of the board is clipped away (a few px past the
   *  inner axis lines stay, so edge cards on them show half). */
  const focusView = useCallback(
    (q: Quadrant): { view: View; clip: string } | null => {
      const board = worldRef.current;
      const plot = board?.querySelector<HTMLElement>("[data-matrix-board]");
      const st = stage();
      if (!board || !plot || !st) return null;
      const right = q === "q1" || q === "q4";
      const bottom = q === "q3" || q === "q4";
      const p = rectIn(plot, board);
      const quad: Rect = { x: p.x + (right ? p.w / 2 : 0), y: p.y + (bottom ? p.h / 2 : 0), w: p.w / 2, h: p.h / 2 };
      // Inner sides: just past the axis lines; outer sides: the plot border.
      const rects: Rect[] = [
        {
          x: quad.x - (right ? INNER : 0),
          y: quad.y - (bottom ? INNER : 0),
          w: quad.w + INNER,
          h: quad.h + INNER,
        },
      ];
      for (const name of [bottom ? "y_from" : "y_to", right ? "x_to" : "x_from"]) {
        const label = board.querySelector<HTMLElement>(`[data-axis="${name}"] [data-axis-label]`);
        if (!label) continue;
        const r = rectIn(label, board);
        rects.push({ x: r.x - LABEL_PAD, y: r.y - LABEL_PAD, w: r.w + 2 * LABEL_PAD, h: r.h + 2 * LABEL_PAD });
      }
      const bx0 = Math.min(...rects.map((r) => r.x));
      const by0 = Math.min(...rects.map((r) => r.y));
      const bx1 = Math.max(...rects.map((r) => r.x + r.w));
      const by1 = Math.max(...rects.map((r) => r.y + r.h));
      const s = Math.min(MAX_ZOOM, st.w / (bx1 - bx0), st.h / (by1 - by0));
      const view = {
        s,
        x: st.x + (st.w - (bx1 - bx0) * s) / 2 - bx0 * s,
        y: st.y + (st.h - (by1 - by0) * s) / 2 - by0 * s,
        smooth: true,
      };
      // Union of the rects (same winding: nonzero fill = union).
      const clip = `path('${rects
        .map((r) => `M${r.x} ${r.y}H${r.x + r.w}V${r.y + r.h}H${r.x}Z`)
        .join(" ")}')`;
      return { view, clip };
    },
    [worldRef, stage],
  );

  // Re-fit on resize: overview stays the overview, a focus stays focused.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useLayoutEffect(() => {
    if (vp.w === 0 || world.w === 0) return;
    const q = focusRef.current;
    const target = q ? focusView(q) : null;
    if (target) {
      setClip(target.clip);
      setView({ ...target.view, smooth: false });
    } else setView((v) => clampView({ ...v, smooth: false }, world, vp));
  }, [vp, world, focusView]);

  /** A manual zoom / pan: leaves a quadrant focus (and its clipping). */
  const apply = (v: View) => {
    const { vp: p, world: w } = sizes.current;
    setFocus(null);
    setClip(null);
    setView(clampView(v, w, p));
  };
  const zoomAt = (factor: number, px: number, py: number, smooth: boolean) => {
    const v = viewRef.current;
    const s = Math.max(1, Math.min(MAX_ZOOM, v.s * factor));
    apply({ s, x: px - ((px - v.x) * s) / v.s, y: py - ((py - v.y) * s) / v.s, smooth });
  };
  const zoomCentre = (factor: number) => zoomAt(factor, sizes.current.vp.w / 2, sizes.current.vp.h / 2, true);
  const panBy = (dx: number, dy: number) => {
    const v = viewRef.current;
    apply({ ...v, x: v.x + dx, y: v.y + dy, smooth: true });
  };
  const overview = () => apply({ s: 1, x: 0, y: 0, smooth: true });
  const focusOn = (q: Quadrant) => {
    const target = focusView(q);
    if (!target) return;
    setFocus(q);
    setClip(target.clip);
    setView(target.view);
  };
  const step = (dir: 1 | -1) => {
    const at = focusRef.current ? QUADRANT_ORDER.indexOf(focusRef.current) : dir === 1 ? -1 : QUADRANT_ORDER.length;
    focusOn(QUADRANT_ORDER[(at + dir + QUADRANT_ORDER.length) % QUADRANT_ORDER.length]);
  };
  const zoomed = view.s > 1.0001 || focus != null;

  const api = { zoomAt, zoomCentre, panBy, overview, focusOn, step };
  const apiRef = useRef(api);
  apiRef.current = api;

  // Wheel / trackpad pinch (native listener: React's wheel is passive).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.012 : 0.0015));
      apiRef.current.zoomAt(Math.min(1.35, Math.max(1 / 1.35, factor)), e.clientX - rect.left, e.clientY - rect.top, false);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewportRef]);

  // Keys: + / − zoom, 0 overview, [ / ] previous / next field, Shift+arrows
  // pan. Plain arrows stay the presenter's (or a focused card's).
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      const a = apiRef.current;
      let handled = true;
      if (e.key === "+" || e.key === "=") a.zoomCentre(STEP);
      else if (e.key === "-" || e.key === "_") a.zoomCentre(1 / STEP);
      else if (e.key === "0") a.overview();
      else if (e.key === "]") a.step(1);
      else if (e.key === "[") a.step(-1);
      else if (e.shiftKey && e.key === "ArrowLeft") a.panBy(PAN_STEP, 0);
      else if (e.shiftKey && e.key === "ArrowRight") a.panBy(-PAN_STEP, 0);
      else if (e.shiftKey && e.key === "ArrowUp") a.panBy(0, PAN_STEP);
      else if (e.shiftKey && e.key === "ArrowDown") a.panBy(0, -PAN_STEP);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  // Drag on empty space pans (cards, buttons and the focus bar keep theirs).
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest("[data-card-id], button, input, textarea, select, a, [data-matrix-focus-bar]")) return;
    const start = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    const id = e.pointerId;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (ev.buttons === 0) return up(ev);
      const v = viewRef.current;
      apply({ ...v, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y, smooth: false });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  return { view, focus, clip, zoomed, onPointerDown, ...api };
}
