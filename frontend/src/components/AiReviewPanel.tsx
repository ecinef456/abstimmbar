// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Review the drafts of an async question-generation run. Opened from the
 * set's review hint or the app-wide status bar (NOT from the "from document"
 * button, which only starts runs). Attaches to the set's latest un-reviewed
 * job, shows live progress while it runs, then a selectable draft list to
 * import or discard. Importing or discarding marks the job reviewed, so the
 * hint and status bar stop surfacing it. */
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type GeneratedQuestion, type GenerationJob } from "../api";
import AiAssistPanel from "./AiAssistPanel";
import { Button } from "./ui";

const KIND_LABEL: Record<string, string> = {
  single_choice: "Single Choice",
  multiple_choice: "Multiple Choice",
  open_text: "Free text",
};

function aiErrorText(err: unknown): string {
  try {
    return JSON.parse((err as Error).message).detail ?? String(err);
  } catch {
    return String(err);
  }
}

function isActive(job: GenerationJob | null): boolean {
  return !!job && (job.status === "pending" || job.status === "running");
}

export default function AiReviewPanel({
  setId,
  onClose,
  onImported,
}: {
  setId: number;
  onClose: () => void;
  onImported: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");

  // Attach to the set's latest un-reviewed job on open.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const active = await api.aiGenerateActive(setId);
        if (!cancelled && active && "id" in active) {
          setJob(active as GenerationJob);
        }
      } catch {
        // Nothing to review (or a transient error) — the empty state closes.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setId]);

  // Poll while running; stop on done/failed/cancelled.
  useEffect(() => {
    if (!isActive(job)) return;
    const jobId = job!.id;
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await api.aiGenerateJob(setId, jobId);
          if (stopped) return;
          setJob(fresh);
          setPollError("");
        } catch (err) {
          if (!stopped) setPollError(aiErrorText(err));
        }
      })();
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status, setId]);

  // Start with nothing selected — the teacher picks what to keep (so the
  // "Select all" action is meaningful and imports are deliberate).

  function toggleSelected(index: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleAll(drafts: GeneratedQuestion[]) {
    setSelected((current) =>
      current.size === drafts.length
        ? new Set()
        : new Set(drafts.map((_, index) => index)),
    );
  }

  async function markReviewed() {
    if (job) {
      try {
        await api.aiGenerateReviewed(setId, job.id);
      } catch {
        // Best effort — closing is what the teacher asked for.
      }
    }
  }

  async function cancelRun() {
    if (!job) return;
    try {
      await api.aiGenerateCancel(setId, job.id);
    } catch (err) {
      setError(aiErrorText(err));
      return;
    }
    await markReviewed();
    onClose();
  }

  async function discard() {
    await markReviewed();
    onClose();
  }

  async function importSelected() {
    const drafts = job?.drafts ?? [];
    setImporting(true);
    setError("");
    try {
      for (let index = 0; index < drafts.length; index++) {
        if (!selected.has(index)) continue;
        const draft = drafts[index];
        await api.createQuestion({
          question_set: setId,
          kind: draft.kind,
          text: draft.text,
          binary_choice: draft.binary_choice ?? false,
          options: draft.options.map((option) => ({
            text: option.text,
            is_correct: option.is_correct,
          })),
          model_solution: draft.model_solution ?? "",
          ai_evaluate: draft.kind === "open_text" && !!draft.model_solution,
        });
      }
      await markReviewed();
      await onImported();
      onClose();
    } catch (err) {
      setError(aiErrorText(err));
      setImporting(false);
    }
  }

  function draftBody(draft: GeneratedQuestion) {
    return (
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wide text-slate-400">
          {KIND_LABEL[draft.kind] ? t(KIND_LABEL[draft.kind]) : draft.kind}
        </div>
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {draft.text}
        </div>
        {draft.options.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-sm text-slate-600 dark:text-slate-300">
            {draft.options.map((option, oi) => (
              <li key={oi} className="flex items-center gap-1.5">
                {option.is_correct ? (
                  <Check aria-hidden className="h-4 w-4 text-brand-600" />
                ) : (
                  <span aria-hidden className="inline-block h-4 w-4" />
                )}
                <span
                  className={
                    option.is_correct ? "text-brand-700 dark:text-brand-300" : ""
                  }
                >
                  {option.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        {draft.kind === "open_text" && draft.model_solution && (
          <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            <span className="text-slate-400">{t("Model solution")}: </span>
            {draft.model_solution}
          </div>
        )}
      </div>
    );
  }

  function truncationBanner() {
    if (!job?.truncated) return null;
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
        {job.notice ||
          t("The document is long — only its first sections were used for generation.")}
      </div>
    );
  }

  function renderBody() {
    if (!job) {
      return (
        <div className="space-y-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("Nothing to review.")}
          </p>
          <Button variant="ghost" onClick={onClose}>
            {t("Close")}
          </Button>
        </div>
      );
    }

    if (job.status === "failed") {
      return (
        <div className="space-y-3">
          <p className="text-sm text-danger">{job.error || t("Generation failed.")}</p>
          <Button variant="ghost" onClick={() => void discard()}>
            {t("Discard")}
          </Button>
        </div>
      );
    }

    if (job.status === "cancelled") {
      return (
        <div className="space-y-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("Generation was cancelled.")}
          </p>
          <Button variant="ghost" onClick={() => void discard()}>
            {t("Discard")}
          </Button>
        </div>
      );
    }

    if (isActive(job)) {
      const total = job.total_chunks;
      const done = job.done_chunks;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      return (
        <div className="space-y-3">
          {truncationBanner()}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-sm text-slate-600 dark:text-slate-300">
              <span>
                {total > 0 ? t("{{percent}} % done", { percent: pct }) : t("Preparing …")}
              </span>
              <span>{t("{{n}} questions so far", { n: job.drafts.length })}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <div
                className="h-full rounded-full bg-brand-600 transition-all duration-500"
                style={{ width: total > 0 ? `${pct}%` : "15%" }}
              />
            </div>
          </div>
          {job.drafts.length > 0 && (
            <ul className="space-y-2">
              {job.drafts.map((draft, index) => (
                <li
                  key={index}
                  className="rounded-lg border border-slate-200 bg-white/60 p-3 dark:border-slate-700 dark:bg-slate-900/40"
                >
                  {draftBody(draft)}
                </li>
              ))}
            </ul>
          )}
          <Button variant="ghost" onClick={() => void cancelRun()}>
            {t("Cancel generation")}
          </Button>
        </div>
      );
    }

    // Done → selectable drafts + import.
    const drafts = job.drafts;
    if (drafts.length === 0) {
      return (
        <div className="space-y-3">
          {truncationBanner()}
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {job.truncated
              ? t("No questions generated.")
              : job.notice || t("No questions generated.")}
          </p>
          <Button variant="ghost" onClick={() => void discard()}>
            {t("Discard")}
          </Button>
        </div>
      );
    }
    const allSelected = selected.size === drafts.length;
    return (
      <div className="space-y-2">
        {truncationBanner()}
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("{{selected}} of {{total}} selected — review the drafts and use them.", {
              selected: selected.size,
              total: drafts.length,
            })}
          </p>
          <button
            type="button"
            onClick={() => toggleAll(drafts)}
            className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            {allSelected ? t("Deselect all") : t("Select all")}
          </button>
        </div>
        <ul className="space-y-2">
          {drafts.map((draft, index) => (
            <li
              key={index}
              className="rounded-lg border border-slate-200 bg-white/60 p-3 dark:border-slate-700 dark:bg-slate-900/40"
            >
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(index)}
                  onChange={() => toggleSelected(index)}
                  className="mt-1 h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-700"
                />
                {draftBody(draft)}
              </label>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant="primary"
            disabled={importing || selected.size === 0}
            onClick={() => void importSelected()}
          >
            {importing
              ? t("Applying …")
              : t("Use selected ({{count}})", { count: selected.size })}
          </Button>
          <Button variant="ghost" onClick={() => void discard()}>
            {t("Discard")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <AiAssistPanel title={t("Review generated questions")}>
        {renderBody()}
        {(error || pollError) && (
          <p className="mt-2 text-sm text-danger">{error || pollError}</p>
        )}
      </AiAssistPanel>
    </div>
  );
}
