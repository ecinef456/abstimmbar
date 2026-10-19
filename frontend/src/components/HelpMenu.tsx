// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Header "?" menu: entry point into the guided tour. Mirrors UserMenu's
 *  open/close + outside-click pattern (App.tsx) and is styled like the
 *  neighboring Settings link. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, HelpCircle } from "lucide-react";
import type { TourMode } from "../tour/steps";

/** The guide on the project website, in the UI language (German at the
 *  site root, English under /en/). Build-time overrides: VITE_GUIDE_URL
 *  (German UI) and VITE_GUIDE_URL_EN (English UI). */
const GUIDE_URL = {
  de: import.meta.env.VITE_GUIDE_URL || "https://virtuos.github.io/abstimmbar/anleitung/",
  en: import.meta.env.VITE_GUIDE_URL_EN || "https://virtuos.github.io/abstimmbar/en/guide/",
};

export default function HelpMenu({
  easyMode,
  onStartTour,
}: {
  easyMode: boolean;
  /** Starts the tour (App refetches whoami for fresh example-room ids). */
  onStartTour: (mode: TourMode) => void;
}) {
  const { t, i18n } = useTranslation();
  const guideUrl = i18n.language?.startsWith("de") ? GUIDE_URL.de : GUIDE_URL.en;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-tour="header.help"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Help")}
        title={t("Help")}
        className="rounded-full p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <HelpCircle aria-hidden className="h-5 w-5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-30 mt-2 w-56 max-w-[calc(100vw-2rem)] overflow-hidden sm:left-auto sm:right-0 rounded-xl border border-slate-200 bg-white py-1 shadow-lg shadow-slate-900/5 dark:border-slate-700 dark:bg-slate-900"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onStartTour(easyMode ? "easy" : "pro");
              setOpen(false);
            }}
            className="block w-full px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {t("Start tour")}
          </button>
          <a
            role="menuitem"
            href={guideUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            aria-label={t("Guide (opens in a new tab)")}
            className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {t("Guide")}
            <ExternalLink aria-hidden className="h-4 w-4 text-slate-400" />
          </a>
        </div>
      )}
    </div>
  );
}
