// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** First-login welcome modal offering the guided tour. Mirrors ConfirmDialog's
 *  modal chrome (components/ui.tsx: centered, dim backdrop, Escape-to-close)
 *  so it looks native to the app; phone-width safe, theme-aware. */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/ui";

export default function WelcomeDialog({
  onStart,
  onSkip,
}: {
  onStart: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onSkip();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onSkip]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-dialog-title"
      onClick={onSkip}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="welcome-dialog-title"
          className="text-lg font-bold text-slate-900 dark:text-slate-100"
        >
          {t("Welcome to Abstimmbar 🎉")}
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {t("Run live quizzes and polls in your class — this 2-minute tour shows you how.")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onSkip}>
            {t("Skip")}
          </Button>
          <Button variant="primary" onClick={onStart}>
            {t("Start tour")}
          </Button>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          {t("You can restart it anytime from the ? in the header.")}
        </p>
      </div>
    </div>
  );
}
