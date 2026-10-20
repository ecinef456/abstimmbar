// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Body of the mind map's pencil drawer (#201), laid out like the word
 *  cloud's moderation panel and the matrix "Moderieren" view: "Hidden" with
 *  "Show again", then the moderation log — "Merged", "Moved", "Renamed",
 *  "AI changes" (only non-empty sections, newest first) — each entry with
 *  "Reset". A refused reset (409) says why inline and leaves the entry; a
 *  successful one hides it at once (the next payload drops it). Resetting is
 *  locked while rating (showing hidden terms stays possible). Focus never
 *  drops to the page: after an action it moves to the next (else previous)
 *  action button, else the section heading, else the drawer's close button. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import { localizedText } from "@basicbar/ui";
import type { MindmapLogEntry, MindmapLogTerm } from "../api";

export interface HiddenMindmapTerm {
  id: number;
  text: string;
  path: string[];
  below: number;
}

const SECTIONS = [
  { kind: "merge", heading: "Merged terms" },
  { kind: "move", heading: "Moved terms" },
  { kind: "rename", heading: "Renamed terms" },
  { kind: "ai", heading: "AI changes" },
] as const;

const BTN =
  "shrink-0 text-brand-700 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:text-slate-500 disabled:no-underline";
const HEADING = "mb-1 font-semibold text-slate-600 focus:outline-none";

export default function MindmapModerationList({
  hidden,
  log,
  rating,
  onShow,
  onReset,
  fallbackFocusId,
}: {
  hidden: HiddenMindmapTerm[];
  log: MindmapLogEntry[];
  /** Rating stage: resetting is locked (hint shown). */
  rating: boolean;
  onShow: (id: number) => void;
  /** Resolves with null on success, else the server's untranslated detail. */
  onReset: (id: number) => Promise<string | null>;
  /** Focused when the drawer has no action left. */
  fallbackFocusId: string;
}) {
  const { t, i18n } = useTranslation();
  const term = (x: MindmapLogTerm | null) =>
    x === null ? t("Main branch") : (x.text_i18n && localizedText(x.text_i18n)) || x.text;
  const label = (e: MindmapLogEntry): string => {
    switch (e.kind) {
      case "merge":
        return t("“{{source}}” merged into “{{target}}”", { source: term(e.label.source), target: term(e.label.target) });
      case "move":
        return t("“{{node}}” moved: {{from}} → {{to}}", {
          node: term(e.label.node),
          from: term(e.label.from),
          to: term(e.label.to),
        });
      case "rename":
        return t("“{{old}}” → “{{new}}” renamed", { old: term(e.label.old), new: term(e.label.new) });
      case "ai":
        return t("AI: {{count}} changes", { count: e.label.count });
    }
  };
  // In the UI language; with the date when it isn't from today.
  const time = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const today = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(i18n.language, {
      ...(today ? {} : { day: "2-digit", month: "2-digit", year: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Reset successfully: hidden right away (the next payload drops them).
  const [done, setDone] = useState<Set<number>>(() => new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const running = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ key: string | null; heading: string } | null>(null);
  const [tick, setTick] = useState(0);
  // The last refusal, for screen readers (one live region that is always
  // there; inserting a fresh role=status is not reliably announced).
  const [announce, setAnnounce] = useState("");
  // A refusal is about the list as it was: once entries come or go, the
  // inline reasons are stale.
  const logIds = log.map((e) => e.id).join(",");
  useEffect(() => {
    setErrors({});
    setAnnounce("");
  }, [logIds]);

  const entries = log.filter((e) => !done.has(e.id));
  const sections = SECTIONS.map((s) => ({ ...s, items: entries.filter((e) => e.kind === s.kind) })).filter(
    (s) => s.items.length > 0,
  );

  // Pick the focus target before the action removes the clicked button.
  const pickTarget = (from: HTMLElement, heading: string) => {
    const all = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-mod-key]:not(:disabled)") ?? [])];
    const at = all.indexOf(from);
    const next = at < 0 ? undefined : (all[at + 1] ?? all[at - 1]);
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
      document.getElementById(fallbackFocusId);
    el?.focus({ preventScroll: true });
  }, [tick, hidden, log, fallbackFocusId]);

  const show = (e: { currentTarget: HTMLElement }, id: number) => {
    settle(pickTarget(e.currentTarget, "mm-mod-hidden"));
    onShow(id);
  };
  const reset = async (e: { currentTarget: HTMLElement }, id: number, heading: string) => {
    if (running.current) return;
    running.current = true;
    const self = e.currentTarget.dataset.modKey ?? null;
    const target = pickTarget(e.currentTarget, heading);
    setBusy(id);
    setErrors((x) => (id in x ? Object.fromEntries(Object.entries(x).filter(([k]) => Number(k) !== id)) : x));
    setAnnounce("");
    try {
      const detail = await onReset(id);
      if (detail === null) {
        setDone((s) => new Set(s).add(id));
        settle(target);
      } else {
        setErrors((x) => ({ ...x, [id]: detail }));
        setAnnounce(t("No longer possible: {{reason}}", { reason: t(detail) }));
        settle({ key: self, heading });
      }
    } finally {
      running.current = false;
      setBusy(null);
    }
  };

  const live = (
    <p role="status" aria-live="polite" className="sr-only" data-testid="mm-mod-announce">
      {announce}
    </p>
  );
  if (hidden.length === 0 && sections.length === 0) {
    return (
      <div ref={panelRef} className="text-left text-sm">
        {live}
        <p className="text-slate-500">
          {t(
            "Nothing moderated yet. × on a term hides it together with everything below it; your merges, moves, renames and AI changes appear here to be reset one by one.",
          )}
        </p>
      </div>
    );
  }
  return (
    <div ref={panelRef} className="text-left text-sm">
      {live}
      <div className="space-y-3">
        {hidden.length > 0 && (
          <section aria-labelledby="mm-mod-hidden" data-testid="mm-mod-hidden">
            <h3 id="mm-mod-hidden" tabIndex={-1} className={HEADING}>
              {t("Hidden")}
            </h3>
            <ul>
              {hidden.map((h) => (
                <li key={h.id} className="flex items-start justify-between gap-2 py-1">
                  <div className="min-w-0">
                    <p className="truncate">{h.text}</p>
                    {(h.path.length > 0 || h.below > 0) && (
                      <p className="truncate text-xs text-slate-500">
                        {[h.path.join(" › "), h.below > 0 ? t("+{{count}} below", { count: h.below }) : ""]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    data-mod-key={`show-${h.id}`}
                    className={BTN}
                    onClick={(e) => show(e, h.id)}
                    title={t("Show this entry on the beamer again")}
                    aria-label={t("Show again: {{word}}", { word: h.text })}
                  >
                    {t("Show again")}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {sections.length > 0 && rating && (
          <p
            data-testid="mm-mod-rating-lock"
            className="flex items-start gap-1.5 rounded-lg bg-slate-100 px-2.5 py-2 text-slate-700"
          >
            <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            {t("Not possible while rating is in progress.")}
          </p>
        )}
        {sections.map((s) => {
          const headingId = `mm-mod-${s.kind}`;
          return (
            <section key={s.kind} aria-labelledby={headingId} data-testid={headingId}>
              <h3 id={headingId} tabIndex={-1} className={HEADING}>
                {t(s.heading)}
              </h3>
              <ul>
                {s.items.map((e) => {
                  const text = label(e);
                  const error = errors[e.id];
                  const errorId = `mm-mod-error-${e.id}`;
                  return (
                    <li key={e.id} className="py-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="[overflow-wrap:anywhere]">{text}</p>
                          <p className="text-xs text-slate-500">{time(e.created_at)}</p>
                        </div>
                        <button
                          type="button"
                          data-mod-key={`reset-${e.id}`}
                          className={BTN}
                          disabled={rating}
                          aria-disabled={busy === e.id || undefined}
                          aria-describedby={error ? errorId : undefined}
                          onClick={(ev) => void reset(ev, e.id, headingId)}
                          aria-label={t("Reset: {{label}}", { label: text })}
                        >
                          {t("Reset")}
                        </button>
                      </div>
                      {error && (
                        <p id={errorId} className="mt-0.5 text-xs text-red-700">
                          {t("No longer possible: {{reason}}", { reason: t(error) })}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
