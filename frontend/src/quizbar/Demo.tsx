// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): demo present — the presenter runs exactly as usual, but the
 *  run is a test: nothing is saved. This hook shows a "Demo" badge on the
 *  beamer (whatever the presenter is showing) and deletes the demo run when
 *  the page is closed or reloaded; leaving through the app ends it too. */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { quizbar } from "../api";

export function useDemo(demo: boolean, runId: number | null) {
  const { t } = useTranslation();
  const label = t("Demo — nothing is saved");
  useEffect(() => {
    if (!demo) return;
    const badge = document.createElement("div");
    badge.setAttribute("role", "status");
    badge.className =
      "pointer-events-none fixed left-1/2 top-2 z-[60] -translate-x-1/2 rounded-full border border-amber-300 bg-amber-100/95 px-3 py-1 text-xs font-semibold text-amber-900 shadow-sm dark:border-amber-700 dark:bg-amber-950/90 dark:text-amber-100";
    badge.textContent = label;
    document.body.appendChild(badge);
    return () => badge.remove();
  }, [demo, label]);
  useEffect(() => {
    if (!demo || runId === null) return;
    const end = () => void quizbar.demoEnd(runId).catch(() => {});
    window.addEventListener("pagehide", end);
    return () => window.removeEventListener("pagehide", end);
  }, [demo, runId]);
}

/** Leave a demo (fire and forget; a later start would remove it anyway). */
export function endDemo(demo: boolean, runId: number | null) {
  if (demo && runId !== null) void quizbar.demoEnd(runId).catch(() => {});
}
