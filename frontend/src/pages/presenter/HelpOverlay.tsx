// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** "?" help of the presenter: dims the beamer and puts a label card (name,
 *  half a sentence, key) next to every control that is visible right now —
 *  the footer controls and the right-edge handles, found via `data-help`
 *  (see `PRESENTER_HELP`). The view switcher's segments share one card that
 *  lists exactly the segments shown for this question; ‹ › share one card.
 *  A compact key list sits bottom-centre. Click, Esc, ? or H closes it; while
 *  it is open no presenter shortcut fires. Beamer: always light. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { PRESENTER_HELP, segmentKey, type ViewSegment } from "./footer";

interface Target {
  id: string;
  rect: DOMRect;
  inFooter: boolean;
  disabled: boolean;
}

interface CardSpec {
  /** data-help ids this card explains (the e2e checks their union). */
  ids: string[];
  anchor: { left: number; top: number; right: number; bottom: number };
  inFooter: boolean;
}

interface Placed {
  x: number;
  y: number;
}

const MARGIN = 8;
const GAP = 8;
const DIM = "rgba(15, 23, 42, 0.62)";

/** Rendered and actually visible (handles fade to opacity 0 while their
 *  drawer is open; off-screen or display:none elements don't count). */
function isShown(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return false;
  for (let e: HTMLElement | null = el; e; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
  }
  return true;
}

function collectTargets(): Target[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-help]"))
    .filter((el) => !el.closest("[data-help-overlay]") && isShown(el))
    .map((el) => ({
      id: el.dataset.help ?? "",
      rect: el.getBoundingClientRect(),
      inFooter: el.closest("footer") != null,
      disabled: el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled === true,
    }))
    .filter((t) => t.id in PRESENTER_HELP);
}

function union(rects: DOMRect[]) {
  return {
    left: Math.min(...rects.map((r) => r.left)),
    top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
}

/** One card per control; the switcher segments and ‹ › are grouped. */
function buildCards(targets: Target[]): CardSpec[] {
  const cards: CardSpec[] = [];
  const views = targets.filter((t) => t.id.startsWith("view."));
  const nav = targets.filter((t) => t.id === "prev" || t.id === "next");
  let viewsDone = false;
  let navDone = false;
  for (const t of targets) {
    if (t.id.startsWith("view.")) {
      if (viewsDone) continue;
      viewsDone = true;
      cards.push({ ids: views.map((v) => v.id), anchor: union(views.map((v) => v.rect)), inFooter: t.inFooter });
    } else if (t.id === "prev" || t.id === "next") {
      if (navDone) continue;
      navDone = true;
      cards.push({ ids: nav.map((v) => v.id), anchor: union(nav.map((v) => v.rect)), inFooter: t.inFooter });
    } else {
      cards.push({ ids: [t.id], anchor: union([t.rect]), inFooter: t.inFooter });
    }
  }
  return cards;
}

/** Ordered 1-D packing: each item wants to start at `want`; overlapping
 *  neighbours merge into clusters centred on their wishes, clamped to
 *  [lo, hi]. Keeps the order, so leader lines never cross. */
function pack(items: { want: number; size: number }[], lo: number, hi: number): number[] {
  type Cluster = { first: number; last: number; start: number; size: number };
  const clusters: Cluster[] = [];
  const place = (c: Cluster) => {
    let offset = 0;
    let sum = 0;
    for (let i = c.first; i <= c.last; i++) {
      sum += items[i].want - offset;
      offset += items[i].size + GAP;
    }
    c.start = Math.max(lo, Math.min(hi - c.size, sum / (c.last - c.first + 1)));
  };
  items.forEach((it, i) => {
    let c: Cluster = { first: i, last: i, start: it.want, size: it.size };
    place(c);
    while (clusters.length) {
      const prev = clusters[clusters.length - 1];
      if (prev.start + prev.size + GAP <= c.start) break;
      clusters.pop();
      c = { first: prev.first, last: c.last, start: 0, size: prev.size + GAP + c.size };
      place(c);
    }
    clusters.push(c);
  });
  const out: number[] = [];
  for (const c of clusters) {
    let pos = c.start;
    for (let i = c.first; i <= c.last; i++) {
      out[i] = pos;
      pos += items[i].size + GAP;
    }
  }
  return out;
}

/** Footer cards above the footer (one row, two when they don't fit), edge
 *  cards left of their handle. */
function layout(cards: CardSpec[], sizes: { w: number; h: number }[]): Placed[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const placed: Placed[] = cards.map(() => ({ x: 0, y: 0 }));
  const footerIdx = cards.map((c, i) => (c.inFooter ? i : -1)).filter((i) => i >= 0);
  const edgeIdx = cards.map((c, i) => (c.inFooter ? -1 : i)).filter((i) => i >= 0);
  const footerTop = footerIdx.length ? Math.min(...footerIdx.map((i) => cards[i].anchor.top)) : vh;

  const byX = [...footerIdx].sort(
    (a, b) => cards[a].anchor.left + cards[a].anchor.right - (cards[b].anchor.left + cards[b].anchor.right),
  );
  const total = byX.reduce((s, i) => s + sizes[i].w + GAP, -GAP);
  const rows: number[][] = total <= vw - 2 * MARGIN ? [byX] : [byX.filter((_, k) => k % 2 === 0), byX.filter((_, k) => k % 2 === 1)];
  let bottom = footerTop - 18;
  for (const row of rows) {
    const h = Math.max(0, ...row.map((i) => sizes[i].h));
    // Keep clear of right-edge handles that sit at this row's height.
    const blocking = edgeIdx
      .map((i) => cards[i].anchor)
      .filter((a) => a.bottom > bottom - h - GAP && a.top < bottom + GAP)
      .map((a) => a.left - 2 * GAP);
    const xs = pack(
      row.map((i) => ({ want: (cards[i].anchor.left + cards[i].anchor.right) / 2 - sizes[i].w / 2, size: sizes[i].w })),
      MARGIN,
      Math.min(vw - MARGIN, ...blocking),
    );
    row.forEach((i, k) => {
      placed[i] = { x: xs[k], y: bottom - sizes[i].h };
    });
    bottom -= h + 14;
  }

  const byY = [...edgeIdx].sort((a, b) => cards[a].anchor.top - cards[b].anchor.top);
  const ys = pack(
    byY.map((i) => ({ want: (cards[i].anchor.top + cards[i].anchor.bottom) / 2 - sizes[i].h / 2, size: sizes[i].h })),
    MARGIN,
    Math.max(MARGIN + 1, bottom),
  );
  byY.forEach((i, k) => {
    const a = cards[i].anchor;
    const right = a.left - 16;
    placed[i] = { x: Math.max(MARGIN, right - sizes[i].w), y: ys[k] };
  });
  return placed;
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-block min-w-[1.5em] whitespace-nowrap rounded border border-slate-300 bg-slate-50 px-1 text-center font-sans text-xs font-semibold text-slate-700">
      {children}
    </kbd>
  );
}

export default function HelpOverlay({
  onClose,
  views = [],
  canCycle = false,
  disabledReason,
}: {
  onClose: () => void;
  /** The footer's view list (icons and keys of the switcher card). */
  views?: ViewSegment[];
  /** Whether A would switch anything right now (the presenter's rule). */
  canCycle?: boolean;
  /** Why a disabled segment can't be chosen (state-specific). */
  disabledReason?: string;
}) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<Target[]>(() => collectTargets());
  const [placed, setPlaced] = useState<Placed[] | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cards = buildCards(targets);
  const signature = targets.map((tg) => `${tg.id}:${Math.round(tg.rect.left)},${Math.round(tg.rect.top)}:${tg.disabled}`).join("|");

  // Re-collect on resize and DOM changes (SSE updates, a drawer closing).
  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = collectTargets();
        setTargets((prev) => {
          const sig = (ts: Target[]) => ts.map((tg) => `${tg.id}:${Math.round(tg.rect.left)},${Math.round(tg.rect.top)}:${tg.disabled}`).join("|");
          return sig(prev) === sig(next) ? prev : next;
        });
      });
    };
    const mo = new MutationObserver(refresh);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "aria-disabled", "disabled"] });
    window.addEventListener("resize", refresh);
    // Handles fade (transition-opacity): catch the end state.
    const late = window.setTimeout(refresh, 350);
    return () => {
      mo.disconnect();
      window.removeEventListener("resize", refresh);
      window.clearTimeout(late);
      cancelAnimationFrame(frame);
    };
  }, []);

  // Measure the cards (rendered hidden first), then place them.
  useLayoutEffect(() => {
    const sizes = cards.map((_, i) => {
      const el = cardRefs.current[i];
      return { w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 };
    });
    setPlaced(layout(cards, sizes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Focus moves into the help and comes back to where it was on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (before && before !== document.body && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  // Capture phase on window: runs before every other keydown listener (the
  // presenter's, the mind map's, the tour's) and stops them — no presenter
  // shortcut while the help is open, and Esc only closes the help.
  const onKeyCapture = useCallback(
    (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
      // Focus trap: the close button is the only focusable element; nothing
      // behind the dim layer can be reached or activated.
      if (e.key === "Tab") {
        e.preventDefault();
        closeRef.current?.focus({ preventScroll: true });
        return;
      }
      const inside = (document.activeElement as HTMLElement | null)?.closest("[data-help-overlay]") != null;
      if ((e.key === "Enter" || e.key === " ") && !inside) {
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "escape" || key === "?" || key === "h") {
        e.preventDefault();
        onClose();
      } else if (key !== "enter" && key !== " ") {
        e.preventDefault();
      }
    },
    [onClose],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKeyCapture, true);
    return () => window.removeEventListener("keydown", onKeyCapture, true);
  }, [onKeyCapture]);

  const ids = new Set(targets.map((tg) => tg.id));
  const segById = new Map(views.map((s) => [s.id, s]));
  const visibleSegs = views.filter((s) => ids.has(s.id));
  const keyRows: [string, string][] = [];
  if (canCycle && visibleSegs.length > 1) keyRows.push(["A", t("Cycle through the views")]);
  if (visibleSegs.some((s) => s.level === "results")) keyRows.push(["E", t("Results")]);
  if (visibleSegs.some((s) => s.level === "solution")) keyRows.push(["L", t("Solution")]);
  if (ids.has("qr")) keyRows.push(["Q", t("QR code")]);
  if (ids.has("toggle")) keyRows.push([t("S · Enter · Space"), t("Start / Stop")]);
  if (ids.has("prev") || ids.has("next")) keyRows.push(["← →", t("Previous / next question")]);
  if (ids.has("handle.zoom")) keyRows.push(["+ − 0", t("Zoom")]);
  if (ids.has("end")) keyRows.push(["Esc", t("Leave presentation")]);
  keyRows.push(["? / H", t("Help")]);

  const ready = placed !== null && placed.length === cards.length ? placed : null;
  const footerCardTops = ready ? cards.map((c, i) => (c.inFooter ? ready[i].y : Infinity)) : [];
  const keyListBottom = Math.min(window.innerHeight - 80, ...footerCardTops) - 24;

  const renderCard = (card: CardSpec) => {
    if (card.ids[0].startsWith("view.")) {
      return (
        <>
          <div className="mb-1 flex items-center justify-between gap-3">
            <b className="text-sm text-slate-900">{t("View")}</b>
            <span className="text-xs text-slate-500">
              <Kbd>A</Kbd> {t("cycles")}
            </span>
          </div>
          <ul className="space-y-0.5">
            {card.ids.map((id) => {
              const seg = segById.get(id);
              const Icon = seg?.icon;
              const off = targets.find((tg) => tg.id === id)?.disabled;
              return (
                <li key={id} className={`flex items-center gap-2 text-xs ${off ? "text-slate-400" : "text-slate-700"}`}>
                  {Icon && <Icon aria-hidden className="h-4 w-4 shrink-0" />}
                  <span>
                    <b className="font-semibold">{t(PRESENTER_HELP[id].name)}</b>{" "}
                    {off && disabledReason ? disabledReason : t(PRESENTER_HELP[id].text)}
                  </span>
                  {seg && segmentKey(views, seg) && (
                    <span className="ml-auto pl-2">
                      <Kbd>{segmentKey(views, seg)}</Kbd>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      );
    }
    const isNav = card.ids.includes("prev") || card.ids.includes("next");
    const entry = PRESENTER_HELP[card.ids[0]];
    const name = isNav ? t("Previous / next question") : t(entry.name);
    const text = isNav ? t("Moves between the questions.") : t(entry.text);
    const keys = isNav ? "← →" : entry.keys;
    return (
      <>
        <div className="flex items-center justify-between gap-2">
          <b className="text-sm text-slate-900">{name}</b>
          {keys && <Kbd>{keys}</Kbd>}
        </div>
        <div className="text-xs leading-snug text-slate-600">{text}</div>
      </>
    );
  };

  return createPortal(
    <div
      data-help-overlay=""
      data-testid="presenter-help"
      role="dialog"
      aria-modal="true"
      aria-label={t("Help")}
      onClick={onClose}
      className="ab-fade-in fixed inset-0 z-[60] cursor-pointer text-slate-900"
      style={{ colorScheme: "light" }}
    >
      {/* Dim layer with a hole at every explained control. */}
      <svg aria-hidden className="absolute inset-0 h-full w-full">
        <defs>
          <mask id="presenter-help-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {targets.map((tg) => (
              <rect
                key={tg.id}
                x={tg.rect.left - 3}
                y={tg.rect.top - 3}
                width={tg.rect.width + 6}
                height={tg.rect.height + 6}
                rx="10"
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill={DIM} mask="url(#presenter-help-mask)" />
        {targets.map((tg) => (
          <rect
            key={tg.id}
            x={tg.rect.left - 3}
            y={tg.rect.top - 3}
            width={tg.rect.width + 6}
            height={tg.rect.height + 6}
            rx="10"
            fill="none"
            stroke="white"
            strokeWidth="2"
          />
        ))}
        {ready &&
          cards.map((card, i) => {
            const p = ready[i];
            const el = cardRefs.current[i];
            if (!el) return null;
            const w = el.offsetWidth;
            const h = el.offsetHeight;
            const a = card.anchor;
            if (card.inFooter) {
              const ax = (a.left + a.right) / 2;
              const cx = Math.max(p.x + 12, Math.min(p.x + w - 12, ax));
              return <line key={i} x1={ax} y1={a.top - 3} x2={cx} y2={p.y + h} stroke="white" strokeWidth="1.5" />;
            }
            const ay = (a.top + a.bottom) / 2;
            const cy = Math.max(p.y + 10, Math.min(p.y + h - 10, ay));
            return <line key={i} x1={a.left - 3} y1={ay} x2={p.x + w} y2={cy} stroke="white" strokeWidth="1.5" />;
          })}
      </svg>

      {cards.map((card, i) => (
        <div
          key={card.ids.join(" ")}
          ref={(el) => {
            cardRefs.current[i] = el;
          }}
          data-testid="help-card"
          data-help-for={card.ids.join(" ")}
          className={`absolute rounded-lg bg-white px-3 py-2 shadow-lg ${
            card.ids[0].startsWith("view.") ? "w-72" : "w-max max-w-[13rem]"
          }`}
          style={
            ready
              ? { left: ready[i].x, top: ready[i].y }
              : { left: 0, top: 0, visibility: "hidden" }
          }
        >
          {renderCard(card)}
        </div>
      ))}

      <div
        data-testid="help-keys"
        className="absolute left-1/2 w-max max-w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl bg-white px-5 py-3 shadow-xl"
        style={{ bottom: window.innerHeight - keyListBottom, visibility: ready ? undefined : "hidden" }}
      >
        <div className="mb-2 flex items-center justify-between gap-6">
          <h2 className="text-sm font-bold text-slate-900">{t("Keyboard shortcuts")}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t("Close help")}
            title={`${t("Close help")} (Esc)`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-700">
          {keyRows.map(([k, label]) => (
            <div key={k} className="contents">
              <dt className="text-right">
                <Kbd>{k}</Kbd>
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-center text-xs text-slate-500">{t("Click anywhere or press Esc to close.")}</p>
      </div>
    </div>,
    document.body,
  );
}
