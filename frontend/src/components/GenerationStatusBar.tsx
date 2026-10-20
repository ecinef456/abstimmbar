// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** App-wide status bar for the current user's question-generation job: shown
 * under the AI notice on every page while a run is in flight or a finished run
 * still needs review. It is the entry point back to the set's review panel.
 * On the generating set's own page it hides — the set's inline review hint is
 * the richer display there. */
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { api, type GenerationJob } from "../api";
import { Button } from "./ui";

export default function GenerationStatusBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [job, setJob] = useState<GenerationJob | null>(null);

  useEffect(() => {
    let stopped = false;
    async function refresh() {
      try {
        const active = await api.aiGenerateActiveForUser();
        if (!stopped) setJob("id" in active ? (active as GenerationJob) : null);
      } catch {
        // Transient error — keep the last state, try again next tick.
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (!job || !job.set_id) return null;
  // On the generating set's own page the inline review hint takes over.
  if (location.pathname === `/sets/${job.set_id}`) return null;

  const running = job.status === "pending" || job.status === "running";

  async function review() {
    navigate(`/sets/${job!.set_id}`, { state: { openReview: true } });
  }

  async function dismiss() {
    try {
      await api.aiGenerateReviewed(job!.set_id!, job!.id);
    } catch {
      // Best effort.
    }
    setJob(null);
  }

  return (
    <div className="border-b border-brand-200 bg-brand-50/70 dark:border-brand-900 dark:bg-brand-950/30">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <div className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200">
          {running ? (
            <span>
              {t("Questions are being generated …")}
              {job.total_chunks > 0 && (
                <>
                  {" "}
                  {t("{{percent}} % done", {
                    percent: Math.round((job.done_chunks / job.total_chunks) * 100),
                  })}
                  {" · "}
                  {t("{{n}} questions so far", { n: job.drafts.length })}
                </>
              )}
            </span>
          ) : job.status === "failed" ? (
            <span>{t("Question generation failed.")}</span>
          ) : (
            <span>
              {t("{{n}} questions for “{{title}}” generated — review now.", {
                n: job.drafts.length,
                title: job.set_title ?? "",
              })}
            </span>
          )}
          {running && job.total_chunks > 0 && (
            <div className="mt-1 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <div
                className="h-full rounded-full bg-brand-600 transition-all duration-500"
                style={{
                  width: `${Math.round((job.done_chunks / job.total_chunks) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" onClick={() => void review()}>
            {running || job.status === "failed" ? t("To the set") : t("Review")}
          </Button>
          {!running && (
            <button
              type="button"
              aria-label={t("Dismiss")}
              onClick={() => void dismiss()}
              className="-mr-1 shrink-0 rounded-lg p-1 text-slate-500 transition-colors hover:bg-brand-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-brand-900/50"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
