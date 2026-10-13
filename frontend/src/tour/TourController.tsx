// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Outlet, matchPath, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { driver } from "driver.js";
import type { Driver } from "driver.js";
import "./driverTheme.css";
import {
  PAGE_PATTERNS,
  RESTORE_STEP,
  SECTION_LABELS,
  type AutoPerform,
  type NavigateTarget,
  type TourMode,
  type TourPage,
  type TourStep,
  tourFor,
} from "./steps";
import { api } from "../api";
import type { Question, TourEventPayload } from "../api";
import { emitTourSignal } from "./signals";

/** How long to wait for a step's target element to appear before pausing. */
const TARGET_TIMEOUT_MS = 6000;
/** Polling fallback interval (belt-and-braces alongside the MutationObserver). */
const TARGET_POLL_MS = 200;
/** Optional steps (target only exists with data) are skipped after this. */
const OPTIONAL_TIMEOUT_MS = 1500;

interface TourApi {
  active: boolean;
  startTour: (mode: TourMode, opts?: StartTourOptions) => void;
}

/** Passed in by the entry points (WelcomeDialog via App, HelpMenu) — the
 *  provider sits above <App/> and can't read App's whoami. */
export interface StartTourOptions {
  aiEnabled?: boolean;
  /** whoami.example_room_id / example_set_id; null (or undefined) = missing →
   *  the tour starts with RESTORE_STEP. */
  exampleRoomId?: number | null;
  exampleSetId?: number | null;
  /** Where the tour was started from — for the usage statistics. */
  source?: "welcome" | "help";
}

export const TourContext = createContext<TourApi | null>(null);

export function useTour(): TourApi {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used within a <TourProvider>");
  return ctx;
}

/** Which tour page a pathname is on, or null for unknown routes. */
function pageFor(pathname: string): TourPage | null {
  for (const [page, pattern] of Object.entries(PAGE_PATTERNS) as [TourPage, string][]) {
    if (matchPath(pattern, pathname)) return page;
  }
  return null;
}

/** First step index for the page a pathname is on, or -1. */
function entryIndexFor(steps: TourStep[], pathname: string): number {
  const page = pageFor(pathname);
  if (!page) return -1;
  return steps.findIndex((s) => s.page === page);
}

/** Route pattern of a `navigateTo` target (the object form keys by its kind). */
function destPattern(target: NavigateTarget): string {
  if (typeof target === "object") return "/sets/:id/questions/:qid"; // exampleQuestion
  switch (target) {
    case "roomsHome":
      return "/";
    case "exampleRoom":
      return "/rooms/:id";
    case "exampleSet":
      return "/sets/:id";
    case "exampleSetPresent":
      return "/sets/:id/present";
    case "exampleSetResults":
      return "/sets/:id/results";
  }
}

/** Already on exactly `route`? The pattern alone isn't enough: consecutive
 *  exampleQuestion steps (and a context start on some other set) share a
 *  pattern but not the ids, so compare the concrete route's PATHNAME (its query,
 *  e.g. the present step's `?resume=continue`, is stripped — `pathname` never
 *  carries one). `matchPath` with the literal path tolerates a trailing slash. */
function isAt(target: NavigateTarget, route: string, pathname: string): boolean {
  const routePath = route.split("?")[0];
  return matchPath(destPattern(target), pathname) != null && matchPath(routePath, pathname) != null;
}

/** Widgets with their own ←/→ behaviour (tabs, sliders, listboxes, radio
 *  groups, dnd-kit drag handles, …). */
const ARROW_WIDGETS =
  '[role="tab"], [role="tablist"], [role="slider"], [role="listbox"], [role="option"], ' +
  '[role="combobox"], [role="spinbutton"], [role="radiogroup"], [role="radio"], ' +
  '[role="menu"], [role="menuitem"], [role="grid"], [role="tree"], [role="treeitem"], ' +
  '[aria-roledescription="sortable"]';

/** Ignore ←/→ while typing (inputs, selects, the rich-text editor) or while
 *  focus is on a widget that uses the arrow keys itself. */
function ownsArrowKeys(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (el as HTMLElement).isContentEditable ||
    el.closest(ARROW_WIDGETS) != null
  );
}

/** An app menu/dialog is open (outside the tour popover): Esc and ←/→ belong
 *  to it, not to the tour. */
function appPopupOpen(): boolean {
  return Array.from(
    document.querySelectorAll('[role="menu"], [role="dialog"], [role="alertdialog"], [role="note"]'),
  ).some((el) => !el.closest(".driver-popover"));
}

function matchesMilestone(step: TourStep, pathname: string): boolean {
  if (step.kind !== "action" || !step.milestone) return false;
  const m = step.milestone;
  if (m.type === "element") return false; // DOM-based; handled by its own effect
  const pattern = m.type === "present" ? "/sets/:setId/present" : m.pattern;
  return matchPath(pattern, pathname) != null;
}

export function TourProvider({
  children,
  onEnd,
}: {
  children: ReactNode;
  /** Called once when the tour ends (Task 5 wires `api.markTourSeen`). */
  onEnd?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  // Current pathname for async callbacks (startTour, autoPerform, Effect A).
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  const [active, setActive] = useState(false);
  // Live `active` for async callbacks: an autoPerform resolving after the user
  // ended the tour must not re-sync/navigate. Also set synchronously in
  // startTour/end so it's correct before the next render.
  const activeRef = useRef(active);
  activeRef.current = active;
  // Current step for end(): an abort records the step it happened on.
  const stepRef = useRef<TourStep | undefined>(undefined);
  const [mode, setMode] = useState<TourMode>("pro");
  const [aiEnabled, setAiEnabled] = useState(false);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Non-null while the run carries a synthetic RESTORE_STEP in front of the
  // regular steps (example room missing); dropped after a successful restore.
  const [stepsOverride, setStepsOverride] = useState<TourStep[] | null>(null);

  const steps = useMemo(
    () => stepsOverride ?? tourFor(mode, { aiEnabled }),
    [stepsOverride, mode, aiEnabled],
  );
  const step: TourStep | undefined = active ? steps[index] : undefined;
  stepRef.current = step;

  const driverRef = useRef<Driver | null>(null);
  // Re-measures the spotlight when the highlighted element resizes: consecutive
  // exampleQuestion steps reuse the mounted QuestionPage, so the target is found
  // immediately and then re-renders with the next question's (differently
  // sized) editor once it has loaded.
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  // True while an action step's autoPerform is in flight — a second Next click
  // must not fire a second restore request.
  const autoBusyRef = useRef(false);
  // The example room/set ids for this run (from whoami, or from a restore).
  const exampleRef = useRef<{ room: number | null; set: number | null }>({ room: null, set: null });
  // The example set's questions, fetched once per run by the first
  // exampleQuestion step and reused by the others (undefined = not fetched).
  const questionsRef = useRef<Question[] | undefined>(undefined);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  // Steps actually shown in this run, with the URL they were shown on — Back
  // pops this stack, so it returns to the right page and never lands on a
  // step that was skipped going forward (missing kind, absent optional
  // target, skipped section).
  const historyRef = useRef<{ index: number; path: string }[]>([]);
  // The popover's Next/Back handlers, for the ←/→ keys.
  const keyNavRef = useRef<{ next: () => void; back: (() => void) | null } | null>(null);

  /** Usage statistics (anonymous) — best-effort, never affects the tour. */
  const track = useCallback((event: TourEventPayload) => {
    api.trackTourEvent(event).catch(() => {});
  }, []);

  const destroyDriver = useCallback(() => {
    resizeObsRef.current?.disconnect();
    resizeObsRef.current = null;
    try {
      driverRef.current?.destroy();
    } catch {
      /* driver already torn down */
    }
    driverRef.current = null;
    keyNavRef.current = null; // no ←/→ without a visible popover
    // Single source of truth for the action-step interactivity class: always
    // cleared on teardown so it can never leak across a step change, pause,
    // end (Esc/✕), or unmount. highlight() re-adds it only for action steps.
    document.body.classList.remove("tour-action");
  }, []);

  const startTour = useCallback((m: TourMode, opts: StartTourOptions = {}) => {
    setStepsOverride(null);
    setMode(m);
    // TourProvider sits above <App/> (TourHost), so it can't read App's whoami
    // context — the entry points (WelcomeDialog/HelpMenu) pass the flags in.
    setAiEnabled(!!opts.aiEnabled);
    const room = opts.exampleRoomId ?? null;
    const set = opts.exampleSetId ?? null;
    exampleRef.current = { room, set };
    questionsRef.current = undefined; // fresh question lookup per run
    historyRef.current = [];
    // Built from the arguments (the `steps` memo still reflects the old
    // mode/override); `tourFor` is the same function the memo uses.
    const list = tourFor(m, { aiEnabled: !!opts.aiEnabled });
    if (room == null || set == null) {
      // Example missing → always begin with the restore step on the overview,
      // whatever page the tour was started from.
      setStepsOverride([RESTORE_STEP, ...list]);
      if (pageFor(pathRef.current) !== "rooms") navigate("/");
      setIndex(0);
    } else {
      // Start in context: jump to the first step of the page the user is on.
      const entry = entryIndexFor(list, pathRef.current);
      if (entry < 0) navigate("/"); // unknown page → start from the overview
      setIndex(entry < 0 ? 0 : entry);
    }
    setPaused(false);
    setToast(null);
    activeRef.current = true;
    setActive(true);
    track({ kind: "started", mode: m, source: opts.source ?? "help" });
  }, [navigate, track]);

  const end = useCallback((reason: "completed" | "aborted" = "aborted") => {
    // Guard: the last step's Next calls end() from inside a state updater,
    // which StrictMode may invoke twice — record (and tear down) only once.
    if (!activeRef.current) return;
    if (reason === "completed") track({ kind: "completed", mode });
    else track({ kind: "aborted", mode, step: stepRef.current?.id ?? "unknown" });
    destroyDriver();
    activeRef.current = false;
    setActive(false);
    setPaused(false);
    onEndRef.current?.();
    setToast(t("You can restart the tour anytime from the ? in the header."));
    window.setTimeout(() => setToast(null), 6000);
  }, [destroyDriver, t, track, mode]);

  const advance = useCallback(() => {
    setIndex((i) => {
      if (i >= steps.length - 1) {
        // Last step's Next acts as Done.
        end("completed");
        return i;
      }
      return i + 1;
    });
  }, [steps.length, end]);

  /** Resolve a `navigateTo` target to a concrete route from the run's example
   *  ids. Returns null when the target can't be resolved (example ids missing,
   *  or the example set has no question of the requested kind) — Effect A then
   *  skips the step. */
  const resolveRoute = useCallback(async (target: NavigateTarget): Promise<string | null> => {
    if (target === "roomsHome") return "/";
    const { room, set } = exampleRef.current;
    if (target === "exampleRoom") return room == null ? null : `/rooms/${room}`;
    if (set == null) return null;
    if (typeof target === "object") {
      // exampleQuestion: first question of that kind in the example set.
      if (questionsRef.current === undefined) {
        try {
          questionsRef.current = (await api.listQuestions(set)).results;
        } catch {
          return null; // not cached → the next kind step retries the fetch
        }
      }
      const question = questionsRef.current.find((qq) => qq.kind === target.questionKind);
      return question ? `/sets/${set}/questions/${question.id}` : null;
    }
    switch (target) {
      case "exampleSet":
        return `/sets/${set}`;
      case "exampleSetPresent":
        // resume=archive pre-answers PresentPage's "there are already results"
        // dialog: the example runs stay untouched as archive and the tour's
        // own (empty, never listed) run is used. Without it the dialog would
        // hide the lobby and pause the tour.
        return `/sets/${set}/present?resume=archive`;
      case "exampleSetResults":
        return `/sets/${set}/results`;
    }
  }, []);

  /** Perform a step's action through the app's APIs (never simulated clicks)
   *  and return the destination path. Throws on failure. */
  const runAutoPerform = useCallback(async (ap: AutoPerform): Promise<string> => {
    switch (ap.kind) {
      case "restoreExample": {
        const ids = await api.ensureExampleRoom();
        exampleRef.current = { room: ids.example_room_id, set: ids.example_set_id };
        questionsRef.current = undefined; // new set → fetch its questions afresh
        return "/";
      }
    }
  }, []);

  /** "Next" on an action step: perform its action, then continue with the
   *  regular tour. Failure → paused pill + toast (the step stays, so
   *  Resume/Next retries). */
  const handleAuto = useCallback(
    async (s: TourStep) => {
      if (!s.autoPerform) return advance();
      if (autoBusyRef.current) return; // already performing — ignore repeat clicks
      autoBusyRef.current = true;
      // Visual cue: grey out the popover's Next while busy. The popover is torn
      // down on both success (step change) and failure (destroyDriver), so this
      // never needs undoing.
      const nextBtn = driverRef.current?.getState("popover")?.nextButton as
        | HTMLButtonElement
        | undefined;
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.classList.add("driver-popover-btn-disabled");
      }
      try {
        const dest = await runAutoPerform(s.autoPerform);
        if (!activeRef.current) return; // tour ended meanwhile — stay put
        // restoreExample: drop the synthetic step and begin the regular tour
        // at its first (rooms-page) step.
        setStepsOverride(null);
        setIndex(0);
        historyRef.current = []; // indices shift once the restore step is gone
        if (pageFor(pathRef.current) !== pageFor(dest)) navigate(dest);
      } catch {
        if (!activeRef.current) return; // tour ended meanwhile — nothing to pause
        destroyDriver(); // no stale overlay behind the pill
        setPaused(true);
        setToast(t("Couldn’t do that automatically — try it yourself, or skip the step."));
        window.setTimeout(() => setToast(null), 6000);
      } finally {
        // Always release, so a failed attempt can be retried after Resume.
        autoBusyRef.current = false;
      }
    },
    [advance, runAutoPerform, navigate, destroyDriver, t],
  );

  /** Kind steps whose example question is known to be missing (the example
   *  set's questions were fetched) are skipped — leave them out of the count. */
  const knownSkipped = useCallback((s: TourStep): boolean => {
    const nav = s.navigateTo;
    if (typeof nav !== "object" || questionsRef.current === undefined) return false;
    return !questionsRef.current.some((qq) => qq.kind === nav.questionKind);
  }, []);

  /** "Skip section": first step of the next section (the final step when
   *  this is the last section). */
  const skipSection = useCallback(() => {
    const section = steps[index]?.section;
    if (!section) return advance();
    const next = steps.findIndex((s, i) => i > index && s.section !== section);
    if (next < 0) return end("completed");
    setPaused(false);
    setIndex(next);
  }, [steps, index, advance, end]);

  /** Route of the page step `i` lives on, for Back without history (context
   *  start): the nearest `navigateTo` at or before it on the same page. */
  const routeForStep = useCallback(
    async (i: number): Promise<string | null> => {
      const page = steps[i]?.page;
      if (page === "rooms") return "/";
      for (let j = i; j >= 0 && steps[j].page === page; j--) {
        const nav = steps[j].navigateTo;
        if (!nav) continue;
        const route = await resolveRoute(nav);
        // A missing example question (e.g. no mind map) doesn't say where
        // the page is — keep walking back to an earlier step on it.
        if (route !== null) return route;
      }
      return null;
    },
    [steps, resolveRoute],
  );

  /** Back: return to the previously shown step on the page (URL) it was shown
   *  on; its own signal (Effect A) restores the page state. Without history
   *  (context start), step back through the list instead. */
  const goBack = useCallback(async () => {
    const history = historyRef.current;
    if (history.length && history[history.length - 1].index === index) history.pop();
    const prev = history.pop();
    let target = prev?.index ?? -1;
    let path = prev?.path ?? null;
    if (!prev) {
      for (let i = index - 1; i >= 0; i--) {
        if (steps[i].kind === "action") continue;
        const route = await routeForStep(i);
        if (route !== null || !steps[i].page) {
          target = i;
          path = route;
          break;
        }
      }
      if (!activeRef.current) return;
    }
    if (target < 0) return;
    if (path !== null && path !== pathRef.current + window.location.search) navigate(path);
    setPaused(false);
    setIndex(target);
  }, [index, steps, routeForStep, navigate]);

  /** Build + show the driver popover for the current step against `element`
   *  (undefined → centered, element-less popover). */
  const highlight = useCallback(
    (s: TourStep, element: Element | undefined) => {
      destroyDriver();
      const isLast = index === steps.length - 1;
      const isAction = s.kind === "action";

      // Record the shown step (Back returns here, on this URL).
      const history = historyRef.current;
      if (history[history.length - 1]?.index !== index) {
        history.push({ index, path: window.location.pathname + window.location.search });
      }
      // Back from the second step on; never on the restore step (it is the
      // first step of its run anyway).
      const canBack = !isAction && (history.length >= 2 || index > 0);
      const showButtons: ("previous" | "next" | "close")[] = canBack
        ? ["previous", "next", "close"]
        : ["next", "close"];

      // Section header "<Section> · n of m" over the steps of this section in
      // this run (mode/AI already filtered; known-missing kinds left out).
      let sectionHead: string | null = null;
      if (s.section) {
        const inSection = steps.filter((x) => x.section === s.section && (x.id === s.id || !knownSkipped(x)));
        sectionHead = t("{{section}} · {{current}} of {{total}}", {
          section: t(SECTION_LABELS[s.section]),
          current: inSection.findIndex((x) => x.id === s.id) + 1,
          total: inSection.length,
        });
      }

      let description = t(s.bodyKey);
      for (const extra of s.bodyExtras ?? []) {
        if (extra.modes && !extra.modes.includes(mode)) continue;
        if (extra.requiresAi && !aiEnabled) continue;
        description += ` ${t(extra.key)}`;
      }
      // The "do it yourself" hint only makes sense when the user CAN do the
      // step themselves, i.e. it has a milestone (the restore step has none).
      if (isAction && s.milestone) {
        // Inline-styled so we don't depend on classes outside driverTheme.css.
        description += `<div style="margin-top:0.5rem;font-size:0.75rem;opacity:0.7">${t(
          "Do this yourself — or click Next and we’ll do it for you.",
        )}</div>`;
      }

      const d = driver({
        animate: true,
        allowClose: true,
        allowKeyboardControl: false, // we own Esc (see the keydown effect)
        // Prevent an accidental overlay click from tearing the tour down; the
        // user ends it via the ✕ / End controls.
        overlayClickBehavior: () => {},
        stagePadding: 6,
        stageRadius: 8,
      });
      driverRef.current = d;

      // Action steps: the user must reach elements OUTSIDE the spotlight (e.g. an
      // inline form the trigger opens, whose submit button sits in the dimmed
      // area). driver.js otherwise inerts the whole page (`.driver-active *` →
      // pointer-events:none) and its overlay <svg> mask captures clicks. This
      // class (see driverTheme.css) re-enables the page and lets the overlay pass
      // clicks through, while the popover stays clickable and the spotlight stays
      // visible. destroyDriver() removes it; info steps keep the blocking modal —
      // except `interactive` ones, whose copy invites a click that opens a menu
      // outside the spotlight (the menu items must be clickable).
      if (isAction || s.interactive) document.body.classList.add("tour-action");

      d.highlight({
        element,
        // Action steps must keep their target clickable (it's the thing the
        // user acts on); driver leaves the spotlighted element interactive.
        disableActiveInteraction: false,
        popover: {
          title: t(s.titleKey),
          description,
          side: s.side,
          showButtons,
          // Next is always enabled. On action steps it performs the step's
          // action for the user (handleAuto). If the user does the step
          // themselves while the tour is running, its milestone advances it
          // (Effect B for routes, B2 for elements). While paused, B2 is off;
          // a navigation then re-syncs the tour to the new page (Effect C).
          disableButtons: [],
          nextBtnText: isLast ? t("Finish") : t("Next"),
          prevBtnText: t("Back"),
          onNextClick: () => (isAction ? void handleAuto(s) : advance()),
          onPrevClick: () => void goBack(),
          onCloseClick: () => end(),
          // Section header above the title + "Skip section" link in the footer
          // (driver.js has no slots for either; its progress text stays off).
          onPopoverRender: (popover) => {
            if (!sectionHead) return;
            const head = document.createElement("div");
            head.className = "tour-section-head";
            head.textContent = sectionHead;
            popover.wrapper.insertBefore(head, popover.title);
            const skip = document.createElement("button");
            skip.type = "button";
            skip.className = "tour-skip-section";
            skip.textContent = t("Skip section");
            skip.addEventListener("click", () => skipSection());
            popover.footer.insertBefore(skip, popover.footer.firstChild);
          },
        },
      });
      keyNavRef.current = {
        next: () => (isAction ? void handleAuto(s) : advance()),
        back: canBack ? () => void goBack() : null,
      };
      if (element && typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => driverRef.current?.refresh());
        ro.observe(element);
        resizeObsRef.current = ro;
      }
    },
    [destroyDriver, index, steps, t, advance, handleAuto, end, mode, aiEnabled, knownSkipped, goBack, skipSection],
  );

  // --- Effect A: present the current step (navigate → wait for target → show).
  useEffect(() => {
    if (!active || paused || !step) return;
    const current = step;
    let cancelled = false;
    let observer: MutationObserver | null = null;
    let pollTimer: number | undefined;
    let timeoutTimer: number | undefined;

    const clearWaiters = () => {
      observer?.disconnect();
      observer = null;
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
      pollTimer = undefined;
      timeoutTimer = undefined;
    };

    const run = async () => {
      // Emitted BEFORE navigating: e.g. "present-lobby" must still reach the
      // presenter page the tour is about to leave.
      if (current.signal) emitTourSignal(current.signal);

      if (current.navigateTo) {
        const route = await resolveRoute(current.navigateTo);
        if (cancelled) return;
        if (route === null) {
          // Unresolvable (example missing / no question of this kind) → skip
          // the step silently: no highlight, no pause.
          advance();
          return;
        }
        // Already there (e.g. tour started in context) → don't navigate again.
        if (!isAt(current.navigateTo, route, pathRef.current)) {
          navigate(route);
          // Let the router commit + the destination mount before we hunt for
          // the target (which usually lives on that new page).
          await new Promise((r) => window.setTimeout(r, 0));
          if (cancelled) return;
        }
      }

      if (current.target === null) {
        if (cancelled) return;
        highlight(current, undefined);
        return;
      }

      const selector = `[data-tour="${current.target}"]`;
      const found = (el: Element) => {
        if (cancelled) return;
        clearWaiters();
        // Re-send the signal now that the page is mounted: the one emitted
        // before navigating may have been lost (e.g. Back from the results
        // into the presenter, whose footer target also exists in the lobby,
        // so the wait loop never re-sent it). Handlers are idempotent; the
        // deferred copy covers listeners that subscribe right after mount.
        if (current.signal) {
          const signal = current.signal;
          emitTourSignal(signal);
          window.setTimeout(() => {
            if (!cancelled) emitTourSignal(signal);
          }, 150);
        }
        highlight(current, el);
      };

      const existing = document.querySelector(selector);
      if (existing) {
        found(existing);
        return;
      }

      observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) found(el);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      pollTimer = window.setInterval(() => {
        const el = document.querySelector(selector);
        if (el) found(el);
        else if (current.signal) emitTourSignal(current.signal); // page may have mounted late
      }, TARGET_POLL_MS);
      timeoutTimer = window.setTimeout(() => {
        if (cancelled) return;
        clearWaiters();
        destroyDriver(); // no stale overlay behind the paused pill
        if (current.optional) advance(); // data-dependent target absent → skip
        else setPaused(true);
      }, current.optional ? OPTIONAL_TIMEOUT_MS : TARGET_TIMEOUT_MS);
    };

    void run();

    return () => {
      cancelled = true;
      clearWaiters();
      // Tear down THIS step's driver overlay before the next step's run() begins
      // its (possibly async) navigate/target-wait, so a stale dark backdrop +
      // popover (pointing at a now-unmounted element) never lingers over a wait
      // or the paused pill. driver.js appends to <body> outside React, so
      // nothing else removes it.
      destroyDriver();
    };
  }, [active, paused, step, navigate, resolveRoute, highlight, destroyDriver, advance]);

  // --- Effect B: auto-advance an action step when its ROUTE milestone matches.
  useEffect(() => {
    if (!active || !step) return;
    if (matchesMilestone(step, location.pathname)) advance();
  }, [active, step, location.pathname, advance]);

  // --- Effect B2: auto-advance an action step with an ELEMENT milestone when a
  // `[data-tour="<anchor>"]` element appears (e.g. clicking ‘New room’ opens the
  // inline form → its ‘Create’ button mounts). Mirrors the target-wait watcher
  // (MutationObserver + poll), but waits indefinitely like a route milestone (no
  // timeout/pause). Cleaned up on step change / pause / end / unmount.
  useEffect(() => {
    if (!active || paused || !step) return;
    const milestone = step.milestone;
    if (step.kind !== "action" || milestone?.type !== "element") return;
    const selector = `[data-tour="${milestone.anchor}"]`;

    let advanced = false;
    const tryAdvance = () => {
      if (advanced) return;
      if (document.querySelector(selector)) {
        advanced = true;
        advance();
      }
    };

    tryAdvance(); // already present → advance right away
    if (advanced) return;

    const observer = new MutationObserver(tryAdvance);
    observer.observe(document.body, { childList: true, subtree: true });
    const poll = window.setInterval(tryAdvance, TARGET_POLL_MS);
    return () => {
      observer.disconnect();
      window.clearInterval(poll);
    };
  }, [active, paused, step, advance]);

  // --- Effect C: the user left the step's page on their own (e.g. picked a type
  // in the ‘New question’ menu → the new-question form, or followed a link) →
  // pause instead of leaving a popover pointing at an unmounted element. Never
  // fights the tour's own navigation: a navigateTo step always lands on its own
  // `page`, so `offPage` is false for it. Steps without a `page` (final) never
  // pause. Resume (below) re-syncs to the first step of the page they're on.
  useEffect(() => {
    if (!active || paused || !step?.page) return;
    if (step.page !== pageFor(location.pathname)) {
      destroyDriver(); // no stale overlay behind the pill
      setPaused(true);
    }
    // Only react to path changes; the rest is read from this render's closure
    // (current when the effect runs) so that pausing/unpausing or a step change
    // never re-triggers this check on an unchanged path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  /** Resume from the paused pill: if the user is on another page meanwhile,
   *  continue with the next step on the page they're on (the first step of
   *  that page after the current one — the tour keeps moving forward),
   *  falling back to that page's entry step only if no later step is on it,
   *  instead of re-waiting for a target that isn't there. Unknown page →
   *  re-attempt the current step. */
  const resume = useCallback(() => {
    const page = pageFor(pathRef.current);
    if (step?.page && page && step.page !== page) {
      const later = steps.findIndex((s, i) => i > index && s.page === page);
      const entry = later >= 0 ? later : entryIndexFor(steps, pathRef.current);
      if (entry >= 0) setIndex(entry);
    }
    setPaused(false);
  }, [step, steps, index]);

  // --- Esc ends the tour (driver's own keyboard control is disabled) — unless
  // an app menu/dialog is open: then Esc belongs to it (the ‘New question’ menu,
  // MoreMenu, HelpMenu, InfoHint, ConfirmDialog all close on Esc), and ending
  // the tour on that same keypress made it look like the tour had crashed.
  // ←/→ = Back/Next under the same rule, and not while typing. Not on the
  // presenter page: there ←/→ switch questions (the tour's step text says so).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (appPopupOpen()) return;
        end();
        return;
      }
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const nav = keyNavRef.current;
      if (!nav || appPopupOpen() || ownsArrowKeys(document.activeElement)) return;
      if (pageFor(pathRef.current) === "present") return;
      e.preventDefault();
      if (e.key === "ArrowRight") nav.next();
      else nav.back?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, end]);

  // --- Tear the driver down when the tour deactivates or the provider unmounts.
  useEffect(() => {
    if (!active) destroyDriver();
    return () => destroyDriver();
  }, [active, destroyDriver]);

  const value = useMemo<TourApi>(() => ({ active, startTour }), [active, startTour]);

  return (
    <TourContext.Provider value={value}>
      {children}
      {active && paused && (
        <div
          className="fixed inset-x-0 bottom-4 z-[10000] flex justify-center px-4"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 shadow-lg sm:rounded-full dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <span>{t("Tour paused")}</span>
            <button
              type="button"
              className="font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
              onClick={resume}
            >
              {t("Resume")}
            </button>
            {/* Safety net: always advance past an unexpectedly missing target so
                the tour can never dead-end before the final step. Clear paused so
                Effect A presents the next step (its guard returns while paused). */}
            <button
              type="button"
              className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              onClick={() => {
                setPaused(false);
                advance();
              }}
            >
              {t("Skip step")}
            </button>
            {step?.section && (
              <button
                type="button"
                className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                onClick={skipSection}
              >
                {t("Skip section")}
              </button>
            )}
            <button
              type="button"
              className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              onClick={() => end()}
            >
              {t("End")}
            </button>
          </div>
        </div>
      )}
      {toast && (
        <div
          // Stack above the paused pill (also bottom-4) so it never covers
          // the pill's Resume / Skip step / End buttons.
          className={`fixed inset-x-0 ${active && paused ? "bottom-20" : "bottom-4"} z-[10000] flex justify-center px-4`}
          role="status"
          aria-live="polite"
        >
          <div className="max-w-sm rounded-lg border border-slate-300 bg-white px-4 py-2 text-center text-sm text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            {toast}
          </div>
        </div>
      )}
    </TourContext.Provider>
  );
}

/** Pathless layout route: keeps the TourProvider (tour state + driver overlay)
 *  mounted across the app-shell ↔ present/quiz boundary. */
export function TourHost() {
  return (
    <TourProvider>
      <Outlet />
    </TourProvider>
  );
}
