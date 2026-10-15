// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** The four-field matrix on the beamer: the live board (fitted 16:9 into the
 *  free space), dragging / stacking / keyboard moves with optimistic
 *  positions, the card dialog (unstack, hide/show, delete teacher cards), the
 *  pencil handle (add a teacher card, show hidden cards) and the display
 *  handle (compact / detailed, zoom − + fit). The whole board zooms and pans
 *  like the mind map (`useMatrixView`); a quadrant's magnifier focuses it,
 *  with previous / next field and overview in a bar on top. Every presenter
 *  may arrange and moderate (not expert-only).
 *
 *  Server answers are authoritative: every call returns the whole board,
 *  which replaces the shown one until the next SSE update arrives; errors
 *  revert the optimistic position and show a short toast. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  AlignJustify,
  ChevronLeft,
  ChevronRight,
  EyeOff,
  Info,
  List,
  Maximize2,
  Minus,
  Pencil,
  Plus,
  X,
  ZoomIn,
} from "lucide-react";
import { live, type MatrixBoard, type MatrixCard, type MatrixSettingsPayload } from "../../api";
import Matrix, { matrixStacks, matrixZoneName } from "../../results/Matrix";
import { clampToZone, resolveZone } from "../../results/matrixGeometry";
import { categoryLabel } from "../../matrixPalette";
import { MatrixCategoryChips, MatrixZonePicker } from "../../results/MatrixZonePicker";
import { requestDetail } from "../../results/mindmapModeration";
import { useReducedMotion } from "../../results/motion";
import { useMatrixView } from "./useMatrixView";

type Placement = { zone: string; x: number; y: number; stack?: number | null };

const ZOOM_STEP = 1.25;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 200;

const HANDLE =
  "fixed right-0 z-30 rounded-l-xl border border-r-0 border-slate-200 bg-white/95 text-slate-500 shadow-md transition-opacity hover:text-slate-800";
const ROUND_BTN =
  "flex h-9 w-9 items-center justify-center rounded-full hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600";
const SMALL_BTN =
  "rounded-lg border border-slate-200 px-2.5 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600";

/** Width of the largest 16:9 box that fits the element. */
function useFitWidth(ref: RefObject<HTMLDivElement>) {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const { width: w, height: h } = el.getBoundingClientRect();
      setWidth(Math.max(240, Math.floor(Math.min(w, h * (16 / 9)))));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export default function MatrixPanel({
  runId,
  questionId,
  board: serverBoard,
  settings,
  handleTop,
  handleStep,
  drawerAttr,
  overlayOpen = false,
}: {
  runId: number;
  questionId: number;
  board: MatrixBoard;
  settings: MatrixSettingsPayload;
  /** Top of the right-edge handle column (pencil; display below it). */
  handleTop: number;
  handleStep: number;
  /** Marks drawers/handles so the presenter's Enter/Space leave them alone. */
  drawerAttr: string;
  /** A presenter overlay (QR/join, AI or moderation panel) is open: its Esc
   *  comes first. */
  overlayOpen?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("de") ? "de" : "en";

  // --- Board: server state, last response, optimistic placements ---------
  const [local, setLocal] = useState<MatrixBoard | null>(null);
  // A new SSE board supersedes the last response.
  useEffect(() => setLocal(null), [serverBoard]);
  const [overrides, setOverrides] = useState<Map<number, Placement>>(() => new Map());
  const base = local ?? serverBoard;
  const board = useMemo<MatrixBoard>(() => {
    if (overrides.size === 0) return base;
    return {
      ...base,
      cards: base.cards.map((c) => {
        const o = overrides.get(c.id) ?? (c.stack != null ? overrides.get(c.stack) : undefined);
        if (!o) return c;
        const own = overrides.get(c.id);
        return { ...c, zone: o.zone, x: o.x, y: o.y, ...(own && own.stack !== undefined ? { stack: own.stack } : null) };
      }),
    };
  }, [base, overrides]);
  const boardRef = useRef(board);
  boardRef.current = board;
  const findCard = (id: number) => boardRef.current.cards.find((c) => c.id === id);

  // --- Toast + live announcement -----------------------------------------
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(id);
  }, [toast]);
  const [announce, setAnnounce] = useState("");

  const setOverride = (id: number, placement: Placement | null) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      if (placement) next.set(id, placement);
      else next.delete(id);
      return next;
    });

  // Every call gets a sequence number: a response older than one already
  // shown is dropped (responses can overtake each other). A card's
  // optimistic placement stays until its LAST in-flight request settles.
  const sentSeq = useRef(0);
  const shownSeq = useRef(0);
  const pending = useRef(new Map<number, number>());
  const call = useCallback(
    async (request: () => Promise<{ matrix: MatrixBoard }>, optimisticId?: number) => {
      const seq = ++sentSeq.current;
      if (optimisticId != null) pending.current.set(optimisticId, (pending.current.get(optimisticId) ?? 0) + 1);
      try {
        const { matrix } = await request();
        if (seq > shownSeq.current) {
          shownSeq.current = seq;
          setLocal(matrix);
        }
        return matrix;
      } catch (err) {
        setToast((p) => ({ text: t(requestDetail(err)), n: (p?.n ?? 0) + 1 }));
        return null;
      } finally {
        if (optimisticId != null) {
          const left = (pending.current.get(optimisticId) ?? 1) - 1;
          if (left > 0) pending.current.set(optimisticId, left);
          else {
            pending.current.delete(optimisticId);
            setOverride(optimisticId, null);
          }
        }
      }
    },
    [t],
  );

  const onMove = (id: number, x: number, y: number, via: "pointer" | "keyboard") => {
    const card = findCard(id);
    if (!card) return;
    const zone = resolveZone(card.zone, x, y, settings.edges);
    const [cx, cy] = clampToZone(zone, x, y, settings.edges);
    setOverride(id, { zone, x: cx, y: cy });
    return call(() => live.matrixMove(runId, questionId, id, x, y), id).then((result) => {
      const moved = result?.cards.find((c) => c.id === id);
      if (via === "keyboard" && moved) {
        setAnnounce(t("now in: {{zone}}", { zone: matrixZoneName(moved.zone, settings.axes, t) }));
      }
    });
  };
  const onStack = (id: number, onto: number) => {
    const target = findCard(onto);
    if (target) setOverride(id, { zone: target.zone, x: target.x, y: target.y, stack: onto });
    void call(() => live.matrixStack(runId, questionId, id, onto), id);
  };

  // --- Card dialog --------------------------------------------------------
  const [openId, setOpenId] = useState<number | null>(null);
  // How the dialog was opened: only a keyboard-opened one hands the focus
  // back to its card (a focus-visible card would then be moved by the arrows).
  const openedByKeyboard = useRef(false);
  const onOpenCard = useCallback((id: number, byKeyboard: boolean) => {
    openedByKeyboard.current = byKeyboard;
    setOpenId(id);
  }, []);
  /** Close the dialog. Keyboard: focus back on the card. Mouse: no card is
   *  left focused (a clicker's arrows must navigate, not move it). */
  const closeDialog = useCallback(
    (byKeyboard: boolean) => {
      const id = openId;
      setOpenId(null);
      if (id == null) return;
      window.requestAnimationFrame(() => {
        if (!byKeyboard || !openedByKeyboard.current) {
          (document.activeElement as HTMLElement | null)?.blur?.();
          return;
        }
        const el = document.querySelector<HTMLElement>(`[data-matrix-board] [data-card-id="${id}"]`);
        el?.focus({ preventScroll: true });
      });
    },
    [openId],
  );
  /** After hiding/deleting the opened card: focus the nearest remaining card,
   *  else the board — never body. */
  const focusNear = (id: number) => {
    const sel = (cid: number) => `[data-matrix-board] [data-card-id="${cid}"]`;
    const gone = document.querySelector<HTMLElement>(sel(id))?.getBoundingClientRect();
    setOpenId(null);
    // Two frames: the dialog unmounts, then the board without the card.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        const plot = document.querySelector<HTMLElement>("[data-matrix-board]");
        const others = Array.from(plot?.querySelectorAll<HTMLElement>("[data-card-id]") ?? []).filter(
          (el) => Number(el.dataset.cardId) !== id,
        );
        const centre = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2];
        const [gx, gy] = gone ? centre(gone) : [0, 0];
        const nearest = others
          .map((el) => {
            const [x, y] = centre(el.getBoundingClientRect());
            return { el, d: Math.hypot(x - gx, y - gy) };
          })
          .sort((a, b) => a.d - b.d)[0]?.el;
        (nearest ?? plot)?.focus({ preventScroll: true });
      }),
    );
  };

  // --- Handles ------------------------------------------------------------
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(() => new Set());
  const toggleCategory = (key: string) =>
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Opened from the keyboard, a drawer takes the focus; closing it returns
  // the focus to its handle when it was inside.
  const pencilRef = useRef<HTMLButtonElement>(null);
  const zoomToggleRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const zoomPanelRef = useRef<HTMLDivElement>(null);
  const focusFirstIn = (ref: RefObject<HTMLElement>) =>
    // Two frames: the drawer has rendered and lost `inert`.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() =>
        // The chosen field of the zone picker / the first form field, else
        // the first button.
        (
          ref.current?.querySelector<HTMLElement>("[data-zone][aria-pressed='true'], select, input, textarea") ??
          ref.current?.querySelector<HTMLElement>("button")
        )?.focus({ preventScroll: true }),
      ),
    );
  /** Keyboard close returns the focus to the handle; a mouse close leaves no
   *  button focused (a focused button would swallow a clicker's keys). */
  const closeHandles = (byKeyboard: boolean) => {
    const active = document.activeElement as HTMLElement | null;
    if (drawerOpen && drawerRef.current?.contains(active)) {
      if (byKeyboard) window.requestAnimationFrame(() => pencilRef.current?.focus({ preventScroll: true }));
      else active?.blur();
    } else if (zoomOpen && zoomPanelRef.current?.contains(active)) {
      if (byKeyboard) zoomToggleRef.current?.focus({ preventScroll: true });
      else active?.blur();
    }
    setDrawerOpen(false);
    setZoomOpen(false);
  };

  // Esc closes the dialog / drawer / display controls before the presenter
  // sees it (it would leave the presentation); inside the dialog no
  // presenter shortcut fires at all, and Tab stays in it.
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef(overlayOpen);
  overlayRef.current = overlayOpen;
  // --- Board view: zoom / pan / quadrant focus ---------------------------
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [fitRef, fitWidth] = useFitWidth(viewportRef);
  const reduced = useReducedMotion();
  const bv = useMatrixView({
    viewportRef,
    worldRef,
    worldKey: fitWidth,
    enabled: openId == null && !drawerOpen,
  });
  useEffect(() => {
    if (openId == null && !drawerOpen && !zoomOpen && !bv.zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (openId != null) {
        const dialog = dialogRef.current;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          closeDialog(true);
          return;
        }
        if (e.key === "Tab" && dialog) {
          const items = Array.from(
            dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"),
          );
          if (items.length) {
            const first = items[0];
            const last = items[items.length - 1];
            const inside = dialog.contains(document.activeElement);
            if (e.shiftKey && (document.activeElement === first || !inside)) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
              e.preventDefault();
              first.focus();
            }
          }
        }
        // No presenter shortcuts behind the modal (native activation stays).
        e.stopPropagation();
        return;
      }
      // The "?" help overlay and the presenter's overlays close first.
      if (e.key === "Escape" && (overlayRef.current || document.querySelector("[data-help-overlay]"))) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        // Drawers first; then a zoomed board returns to the overview (Esc
        // must not leave the presentation from there).
        if (drawerOpen || zoomOpen) closeHandles(true);
        else bv.overview();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, drawerOpen, zoomOpen, closeDialog, bv.zoomed]);

  const open = openId != null ? board.cards.find((c) => c.id === openId) : undefined;
  // The opened card went away (deleted, withdrawn): close.
  useEffect(() => {
    if (openId != null && !board.cards.some((c) => c.id === openId)) setOpenId(null);
  }, [openId, board]);

  const zoneName = (zone: string) => matrixZoneName(zone, settings.axes, t);
  const catText = (key: string) => {
    if (settings.category_mode === "off") return "";
    if (!settings.categories.some((c) => c.key === key)) return t("no category");
    const label = categoryLabel(settings.categories, key, settings.category_mode, lang, t);
    return label.name || label.a11y;
  };

  return (
    <>
      <div
        ref={fitRef}
        data-testid="matrix-viewport"
        data-focus={bv.focus ?? undefined}
        onPointerDown={bv.onPointerDown}
        className={`relative mt-3 min-h-0 w-full flex-1 touch-none overflow-hidden ${bv.zoomed ? "cursor-grab" : ""}`}
      >
        {fitWidth != null && (
          <div
            ref={worldRef}
            data-matrix-world=""
            className="absolute left-0 top-0"
            style={{
              width: fitWidth,
              transform: `translate(${bv.view.x}px, ${bv.view.y}px) scale(${bv.view.s})`,
              transformOrigin: "0 0",
              // A focused quadrant: the rest of the board is clipped away.
              clipPath: bv.clip ?? undefined,
              transition: bv.view.smooth && !reduced ? "transform 450ms cubic-bezier(.2,.7,.2,1)" : undefined,
            }}
          >
            <Matrix
              board={board}
              settings={settings}
              mode="present"
              detailed={detailed && settings.descriptions}
              hiddenCategories={hiddenCategories}
              onToggleCategory={toggleCategory}
              legendHelp="mx.legend"
              showHidden={showHidden}
              interactive={{ onMove, onStack, onOpen: onOpenCard }}
              onZoomQuadrant={bv.focusOn}
              quadrantFocused={bv.focus != null}
            />
          </div>
        )}
        {bv.focus && (
          // Focused quadrant: previous / next field and back to the overview.
          <div
            data-matrix-focus-bar=""
            data-testid="matrix-focus-bar"
            className="absolute left-1/2 top-2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-slate-200 bg-white/95 p-1 text-slate-700 shadow-md"
          >
            <button
              type="button"
              data-help="mx.prev-field"
              className={ROUND_BTN}
              onClick={(e) => {
                e.currentTarget.blur();
                bv.step(-1);
              }}
              aria-label={t("Previous field")}
              title={`${t("Previous field")} (, / [)`}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="px-2 text-base font-semibold" aria-live="polite">
              {zoneName(bv.focus)}
            </span>
            <button
              type="button"
              data-help="mx.next-field"
              className={ROUND_BTN}
              onClick={(e) => {
                e.currentTarget.blur();
                bv.step(1);
              }}
              aria-label={t("Next field")}
              title={`${t("Next field")} (. / ])`}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
            <button
              type="button"
              data-help="mx.overview"
              className="ml-1 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
              onClick={(e) => {
                e.currentTarget.blur();
                bv.overview();
              }}
              title={`${t("Overview")} (Esc)`}
            >
              <Maximize2 aria-hidden className="h-4 w-4" />
              {t("Overview")}
            </button>
          </div>
        )}
      </div>
      <p aria-live="polite" className="sr-only" data-testid="matrix-live">
        {announce}
      </p>

      {open && (
        <CardDialog
          dialogRef={dialogRef}
          card={open}
          board={board}
          zoneName={zoneName}
          catText={catText}
          onClose={closeDialog}
          onUnstack={(id) => void call(() => live.matrixUnstack(runId, questionId, id))}
          onHide={(id, hidden) => {
            void call(() => live.matrixHide(runId, questionId, id, hidden));
            // Hiding the opened card takes it off the board: close.
            if (hidden && id === open.id && !showHidden) focusNear(id);
          }}
          onDelete={(id) => {
            void call(() => live.matrixDelete(runId, questionId, id));
            if (id === open.id) focusNear(id);
          }}
        />
      )}

      {toast && (
        <div
          key={toast.n}
          role="status"
          className="ab-fade-in fixed bottom-24 left-1/2 z-50 flex max-w-lg -translate-x-1/2 items-start gap-2 rounded-xl bg-slate-800 px-4 py-2.5 text-sm text-white shadow-lg"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="flex-1">{toast.text}</p>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label={t("Dismiss")}
            className="rounded p-0.5 text-slate-300 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Pencil: add a teacher card, show hidden cards. */}
      <button
        type="button"
        {...{ [drawerAttr]: "" }}
        ref={pencilRef}
        onClick={(e) => {
          const byKeyboard = e.detail === 0;
          e.currentTarget.blur();
          setZoomOpen(false);
          setDrawerOpen((o) => !o);
          if (byKeyboard && !drawerOpen) focusFirstIn(drawerRef);
        }}
        aria-label={t("Add card")}
        title={t("Add card")}
        data-help="handle.mx-edit"
        data-beamer-inset=""
        style={{ top: handleTop }}
        className={`${HANDLE} p-3 ${drawerOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
      >
        <Pencil className="h-5 w-5" />
      </button>
      <AddDrawer
        drawerRef={drawerRef}
        open={drawerOpen}
        drawerAttr={drawerAttr}
        settings={settings}
        zoneName={zoneName}
        showHidden={showHidden}
        onShowHidden={setShowHidden}
        cards={board.cards}
        catText={catText}
        onRestore={(id) => call(() => live.matrixHide(runId, questionId, id, false))}
        onUnstack={(id) => call(() => live.matrixUnstack(runId, questionId, id))}
        onClose={(byKeyboard) => closeHandles(byKeyboard)}
        onAdd={(body) => call(() => live.matrixAdd(runId, questionId, body))}
      />

      {/* Display: compact / detailed, card size. */}
      <div
        {...{ [drawerAttr]: "" }}
        data-beamer-inset=""
        className="fixed right-0 z-30 flex items-center rounded-l-xl border border-r-0 border-slate-200 bg-white/95 text-slate-500 shadow-md"
        style={{ top: handleTop + handleStep }}
      >
        {zoomOpen && (
          <div ref={zoomPanelRef} className="flex items-center pl-1">
            {settings.descriptions && (
              <div className="mr-1 flex items-center rounded-full border border-slate-200 p-0.5">
                {([false, true] as const).map((d) => {
                  const label = d ? t("Detailed") : t("Compact");
                  const Icon = d ? AlignJustify : List;
                  return (
                    <button
                      key={String(d)}
                      type="button"
                      aria-pressed={detailed === d}
                      aria-label={label}
                      title={label}
                      data-testid={d ? "mx-detailed" : "mx-compact"}
                      onClick={(e) => {
                        e.currentTarget.blur();
                        setDetailed(d);
                      }}
                      className={`rounded-full p-1.5 ${
                        detailed === d ? "bg-brand-100 text-brand-800" : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      <Icon aria-hidden className="h-5 w-5" />
                    </button>
                  );
                })}
              </div>
            )}
            {[
              { label: t("Zoom out (−)"), icon: Minus, run: () => bv.zoomCentre(1 / ZOOM_STEP) },
              { label: t("Zoom in (+)"), icon: Plus, run: () => bv.zoomCentre(ZOOM_STEP) },
              { label: t("Fit to screen (0)"), icon: Maximize2, run: () => bv.overview() },
            ].map(({ label, icon: Icon, run }) => (
              <button
                key={label}
                type="button"
                className="rounded-lg p-2 hover:bg-slate-100 hover:text-slate-800"
                onClick={(e) => {
                  e.currentTarget.blur();
                  run();
                }}
                aria-label={label}
                title={label}
              >
                <Icon className="h-5 w-5" />
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          ref={zoomToggleRef}
          className="p-3 hover:text-slate-800"
          onClick={(e) => {
            const byKeyboard = e.detail === 0;
            if (!byKeyboard) e.currentTarget.blur();
            setDrawerOpen(false);
            setZoomOpen((o) => !o);
            if (byKeyboard && !zoomOpen) focusFirstIn(zoomPanelRef);
          }}
          aria-expanded={zoomOpen}
          data-help="handle.mx-zoom"
          aria-label={zoomOpen ? t("Hide display controls") : t("Display")}
          title={zoomOpen ? t("Hide display controls") : t("Display")}
        >
          {zoomOpen ? <ChevronRight className="h-5 w-5" /> : <ZoomIn className="h-5 w-5" />}
        </button>
      </div>
    </>
  );
}

/** The opened card: details, its stack (unstack each), hide/show, delete
 *  teacher cards. Modal; the parent traps Tab and handles Esc. */
function CardDialog({
  dialogRef,
  card,
  board,
  zoneName,
  catText,
  onClose,
  onUnstack,
  onHide,
  onDelete,
}: {
  dialogRef: RefObject<HTMLDivElement>;
  card: MatrixCard;
  board: MatrixBoard;
  zoneName: (zone: string) => string;
  catText: (key: string) => string;
  onClose: (byKeyboard: boolean) => void;
  onUnstack: (id: number) => void;
  onHide: (id: number, hidden: boolean) => void;
  onDelete: (id: number) => void;
}) {
  const { t } = useTranslation();
  const stack = matrixStacks(board.cards).find((s) => s.card.id === card.id);
  const all = stack && stack.members.length > 0 ? [stack.card, ...stack.members] : [];
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  const category = catText(card.category);
  const actions = (c: MatrixCard, inStack: boolean) => (
    <div className="flex flex-wrap gap-2">
      {inStack && (
        <button type="button" className={SMALL_BTN} onClick={() => onUnstack(c.id)} aria-label={t("Unstack {{title}}", { title: c.title })}>
          {t("Unstack")}
        </button>
      )}
      <button
        type="button"
        className={SMALL_BTN}
        onClick={() => onHide(c.id, !c.hidden)}
        aria-label={inStack ? t(c.hidden ? "Show {{title}}" : "Hide {{title}}", { title: c.title }) : undefined}
      >
        {c.hidden ? t("Show") : t("Hide")}
      </button>
      {c.teacher && (
        <button
          type="button"
          className={`${SMALL_BTN} border-red-200 text-red-700 hover:bg-red-50`}
          onClick={() => onDelete(c.id)}
          aria-label={inStack ? t("Delete {{title}}", { title: c.title }) : undefined}
        >
          {t("Delete")}
        </button>
      )}
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6" onClick={() => onClose(false)}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-dialog-title"
        className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-left text-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="matrix-dialog-title" className="text-2xl font-semibold [overflow-wrap:anywhere]">
              {card.title}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {[category, zoneName(card.zone)].filter(Boolean).join(" · ")}
              {card.teacher && ` · ${t("teacher card")}`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={(e) => onClose(e.detail === 0)}
            aria-label={t("Close")}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {card.hidden && (
          <p className="mt-2 flex items-center gap-1 text-sm font-medium text-slate-600">
            <EyeOff aria-hidden className="h-4 w-4" /> {t("hidden")}
          </p>
        )}
        {card.description && (
          <p className="mt-3 whitespace-pre-line text-lg [overflow-wrap:anywhere]">{card.description}</p>
        )}
        <div className="mt-4">{actions(card, false)}</div>
        {all.length > 0 && (
          <section className="mt-5 border-t border-slate-100 pt-4">
            <h3 className="mb-2 font-semibold text-slate-700">
              {t("In this stack ({{count}})", { count: all.length })}
            </h3>
            <ul data-testid="matrix-stack-list" className="space-y-3">
              {all.map((c) => (
                <li
                  key={c.id}
                  className={`rounded-lg border px-3 py-2 ${c.hidden ? "border-dashed border-slate-300 bg-slate-50" : "border-slate-200"}`}
                >
                  <p className="font-semibold [overflow-wrap:anywhere]">
                    {c.title}
                    {c.hidden && <span className="ml-2 text-sm font-normal text-slate-600">({t("hidden")})</span>}
                  </p>
                  {c.description && <p className="text-sm text-slate-600 [overflow-wrap:anywhere]">{c.description}</p>}
                  <div className="mt-2">{actions(c, true)}</div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** Pencil drawer: a teacher card (zone via the participants' axis-cross
 *  picker, category chips, title, description) and the "show hidden cards"
 *  switch. */
function AddDrawer({
  drawerRef,
  open,
  drawerAttr,
  settings,
  zoneName,
  showHidden,
  onShowHidden,
  cards,
  catText,
  onRestore,
  onUnstack,
  onClose,
  onAdd,
}: {
  drawerRef: RefObject<HTMLDivElement>;
  open: boolean;
  drawerAttr: string;
  settings: MatrixSettingsPayload;
  zoneName: (zone: string) => string;
  showHidden: boolean;
  onShowHidden: (v: boolean) => void;
  cards: MatrixCard[];
  catText: (key: string) => string;
  onRestore: (id: number) => Promise<unknown>;
  onUnstack: (id: number) => Promise<MatrixBoard | null>;
  onClose: (byKeyboard: boolean) => void;
  onAdd: (body: { zone: string; title: string; category: string; description: string }) => Promise<MatrixBoard | null>;
}) {
  const { t } = useTranslation();
  const withCategory = settings.category_mode !== "off" && settings.categories.length > 0;
  const [zone, setZone] = useState(settings.zones[0] ?? "q1");
  const [category, setCategory] = useState(withCategory ? settings.categories[0].key : "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"add" | "moderate">("add");
  // Closed (off-screen): out of the tab order and the accessibility tree.
  useEffect(() => {
    if (drawerRef.current) drawerRef.current.inert = !open;
    // Each opening starts at "Add card".
    if (!open) setView("add");
  }, [open]);
  // Settings may change while presenting (edges / categories switched off).
  useEffect(() => {
    if (!settings.zones.includes(zone)) setZone(settings.zones[0] ?? "q1");
    if (withCategory && !settings.categories.some((c) => c.key === category)) setCategory(settings.categories[0].key);
  }, [settings, zone, category, withCategory]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const result = await onAdd({
      zone,
      title: title.trim(),
      category: withCategory ? category : "",
      description: settings.descriptions ? description.trim() : "",
    });
    setBusy(false);
    if (result) {
      setTitle("");
      setDescription("");
    }
  };
  const field =
    "mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600";
  return (
    <div
      {...{ [drawerAttr]: "" }}
      ref={drawerRef}
      data-testid="matrix-drawer"
      className={`fixed right-0 top-0 z-40 flex h-full w-80 flex-col border-l border-slate-200 bg-white text-slate-800 transition-transform duration-300 ${
        open ? "translate-x-0 shadow-2xl" : "translate-x-full"
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 p-3">
        <div
          role="tablist"
          aria-label={t("Card management")}
          data-help="mx.drawer-views"
          className="flex min-w-0 gap-1 rounded-lg bg-slate-100 p-0.5 text-sm font-semibold"
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            const next =
              e.key === "Home" ? "add" : e.key === "End" ? "moderate" : view === "add" ? "moderate" : "add";
            setView(next);
            e.currentTarget.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus();
          }}
        >
          {(["add", "moderate"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              id={`matrix-drawer-tab-${v}`}
              data-view={v}
              aria-selected={view === v}
              aria-controls={view === v ? `matrix-drawer-panel-${v}` : undefined}
              tabIndex={view === v ? 0 : -1}
              onClick={() => setView(v)}
              className={`truncate rounded-md px-2.5 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${
                view === v ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {v === "add" ? t("Add card") : t("Moderate")}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={(e) => onClose(e.detail === 0)}
          aria-label={t("Close")}
          className="shrink-0 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      {view === "add" ? (
      <form
        id="matrix-drawer-panel-add"
        role="tabpanel"
        aria-labelledby="matrix-drawer-tab-add"
        onSubmit={(e) => void submit(e)}
        className="space-y-3 overflow-y-auto p-3 text-left text-sm"
      >
        <MatrixZonePicker settings={settings} value={zone} onChange={setZone} zoneName={zoneName} />
        {withCategory && <MatrixCategoryChips settings={settings} value={category} onChange={setCategory} />}
        <label className="block font-medium text-slate-700">
          {t("Title")}
          <input
            className={field}
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {settings.descriptions && (
          <label className="block font-medium text-slate-700">
            {t("Description")}
            <textarea
              className={field}
              rows={3}
              value={description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        )}
        <button
          type="submit"
          disabled={!title.trim() || busy}
          className="w-full rounded-lg bg-brand-700 px-3 py-2 font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {t("Add card")}
        </button>
      </form>
      ) : (
        <ModerateView
          cards={cards}
          catText={catText}
          showHidden={showHidden}
          onShowHidden={onShowHidden}
          onRestore={onRestore}
          onUnstack={onUnstack}
        />
      )}
    </div>
  );
}

/** Moderate view of the pencil drawer, laid out like the word cloud's
 *  moderation panel: "Hidden" with "Show again", "Stacks" with the members
 *  of each stack (release one, or dissolve the whole stack). Focus never
 *  drops to the page: after an action it moves to the next (else previous)
 *  action button, else the section heading, else the "Moderate" tab. */
function ModerateView({
  cards,
  catText,
  showHidden,
  onShowHidden,
  onRestore,
  onUnstack,
}: {
  cards: MatrixCard[];
  catText: (key: string) => string;
  showHidden: boolean;
  onShowHidden: (v: boolean) => void;
  onRestore: (id: number) => Promise<unknown>;
  onUnstack: (id: number) => Promise<MatrixBoard | null>;
}) {
  const { t } = useTranslation();
  const hidden = cards.filter((c) => c.hidden);
  const stacks = matrixStacks(cards).filter((s) => s.members.length > 0);
  const [dissolving, setDissolving] = useState(false);
  const running = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ key: string | null; heading: string } | null>(null);
  const [tick, setTick] = useState(0);
  // Pick the focus target before the action removes the clicked button.
  const pickTarget = (from: HTMLElement, group: string, heading: string) => {
    const all = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-mod-key]") ?? [])];
    const at = all.indexOf(from);
    const others = (el: HTMLElement) => el !== from && (!group || el.dataset.modGroup !== group);
    const next = all.slice(at + 1).find(others) ?? all.slice(0, at).reverse().find(others);
    return { key: next?.dataset.modKey ?? null, heading };
  };
  const settle = (target: { key: string | null; heading: string }) => {
    pendingFocus.current = target;
    setTick((n) => n + 1);
  };
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const panel = panelRef.current;
    const el =
      (target.key && panel?.querySelector<HTMLElement>(`[data-mod-key="${target.key}"]`)) ||
      panel?.querySelector<HTMLElement>(`#${target.heading}`) ||
      document.getElementById("matrix-drawer-tab-moderate");
    el?.focus({ preventScroll: true });
  }, [tick, cards]);
  const act = async (e: { currentTarget: HTMLElement }, group: string, heading: string, run: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    const target = pickTarget(e.currentTarget, group, heading);
    try {
      await run();
    } finally {
      running.current = false;
      settle(target);
    }
  };
  const dissolve = async (topId: number) => {
    setDissolving(true);
    try {
      // One after the other: each response carries the whole board; the
      // members are re-read from it so already-free cards are skipped.
      let current = cards;
      for (;;) {
        const member = current.find((c) => c.stack === topId);
        if (!member) break;
        const board = await onUnstack(member.id);
        if (!board) break;
        current = board.cards;
      }
    } finally {
      setDissolving(false);
    }
  };
  const BTN = "ml-2 shrink-0 text-brand-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 aria-disabled:opacity-50";
  return (
    <div
      id="matrix-drawer-panel-moderate"
      ref={panelRef}
      role="tabpanel"
      aria-labelledby="matrix-drawer-tab-moderate"
      className="flex min-h-0 flex-1 flex-col text-left text-sm"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {hidden.length === 0 && stacks.length === 0 && <p className="text-slate-500">{t("Nothing moderated yet.")}</p>}
        {hidden.length > 0 && (
          <section aria-labelledby="matrix-mod-hidden" data-testid="matrix-mod-hidden">
            <h3 id="matrix-mod-hidden" tabIndex={-1} className="mb-1 font-semibold text-slate-600 focus:outline-none">{t("Hidden")}</h3>
            <ul>
              {hidden.map((c) => {
                const category = catText(c.category);
                return (
                  <li key={c.id} className="flex items-center justify-between py-0.5">
                    <span className="min-w-0 truncate">
                      {c.title}
                      {category && <span className="ml-1 text-xs text-slate-500">({category})</span>}
                    </span>
                    <button
                      type="button"
                      data-mod-key={`show-${c.id}`}
                      className={BTN}
                      onClick={(e) => void act(e, "", "matrix-mod-hidden", () => onRestore(c.id))}
                      aria-label={t("Show {{title}} on the beamer again", { title: c.title })}
                    >
                      {t("Show card again")}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {stacks.length > 0 && (
          <section aria-labelledby="matrix-mod-stacks" data-testid="matrix-mod-stacks" className={hidden.length > 0 ? "mt-3" : ""}>
            <h3 id="matrix-mod-stacks" tabIndex={-1} className="mb-1 font-semibold text-slate-600 focus:outline-none">{t("Stacks")}</h3>
            {stacks.map((st) => (
              <div key={st.card.id} className="mb-2 rounded-lg border border-slate-200 p-2">
                <div className="flex items-center justify-between">
                  <span className="min-w-0 truncate font-medium">
                    {st.card.title}
                    <span className="ml-1 text-xs font-normal text-slate-500">
                      {t("{{count}} cards", { count: st.members.length + 1 })}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-mod-key={`dissolve-${st.card.id}`}
                    data-mod-group={`stack-${st.card.id}`}
                    className={BTN}
                    aria-disabled={dissolving || undefined}
                    onClick={(e) => void act(e, `stack-${st.card.id}`, "matrix-mod-stacks", () => dissolve(st.card.id))}
                    aria-label={t("Dissolve stack {{title}}", { title: st.card.title })}
                  >
                    {t("Dissolve stack")}
                  </button>
                </div>
                <ul className="mt-1">
                  {st.members.map((m) => (
                    <li key={m.id} className="flex items-center justify-between py-0.5 text-slate-700">
                      <span className="min-w-0 truncate">{m.title}</span>
                      <button
                        type="button"
                        data-mod-key={`unstack-${m.id}`}
                        data-mod-group={st.members.length === 1 ? `stack-${st.card.id}` : undefined}
                        className={BTN}
                        aria-disabled={dissolving || undefined}
                        onClick={(e) => void act(e, st.members.length === 1 ? `stack-${st.card.id}` : "", "matrix-mod-stacks", () => onUnstack(m.id))}
                        aria-label={t("Unstack {{title}}", { title: m.title })}
                      >
                        {t("Unstack")}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </div>
      <div className="border-t border-slate-100 p-3">
        <label className="flex items-center gap-2 font-medium text-slate-700">
          <input type="checkbox" checked={showHidden} onChange={(e) => onShowHidden(e.target.checked)} />
          {t("Show hidden cards")}
        </label>
        <p className="mt-1 text-xs text-slate-500">
          {hidden.length === 0
            ? t("No hidden cards. Open a card to hide it.")
            : t("Hidden: {{count}}", { count: hidden.length })}
        </p>
      </div>
    </div>
  );
}
