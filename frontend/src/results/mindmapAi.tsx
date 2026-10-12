// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** "Optimise mind map" (AI, beamer, expert mode): the presenter asks the AI
 * for a proposal (merge duplicates, unify the language, restructure), sees
 * the optimised tree as a **preview** with marks on every changed term plus a
 * checklist of the proposed changes, and applies the selected ones as one
 * batch — a single entry in the moderation undo stack (Ctrl/Cmd+Z reverts
 * the whole batch).
 *
 * Unchecking a change also unchecks everything built on it (`requires`:
 * the new parent terms an entry needs, transitively); checking one re-checks
 * what it needs. Every selection change re-simulates on the server
 * (`ai-preview`, no LLM call), so the preview always matches what "Apply"
 * would do. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderPlus, Languages, Loader2, Merge, MoveRight, Sparkles, X } from "lucide-react";
import { live } from "../api";
import type { LiveMindmap, LiveMindmapNode, MindmapAiOp, MindmapAiSettings } from "../api";
import { AI_MARK } from "./MindMap";
import { requestDetail } from "./mindmapModeration";

interface Proposal {
  proposal: string;
  ops: MindmapAiOp[];
  dropped: number;
  preview: LiveMindmap;
  active: number[];
  selected: number[];
}

const DEFAULT_SETTINGS: MindmapAiSettings = {
  merge: true,
  translate: true,
  target_lang: "de",
  restructure: true,
};

function countVisible(nodes: LiveMindmapNode[]): number {
  return nodes.reduce((sum, n) => (n.hidden ? sum : sum + 1 + countVisible(n.children)), 0);
}

/** Selection after toggling `index`: off → its dependants go too; on → what
 *  it requires comes along. */
export function toggleSelection(ops: MindmapAiOp[], selected: number[], index: number): number[] {
  const set = new Set(selected);
  if (set.has(index)) {
    set.delete(index);
    for (const op of ops) if (op.requires.includes(index)) set.delete(op.index);
  } else {
    set.add(index);
    for (const need of ops.find((o) => o.index === index)?.requires ?? []) set.add(need);
  }
  return ops.map((o) => o.index).filter((i) => set.has(i));
}

export function useMindmapAi({
  runId,
  questionId,
  mindmap,
  settings,
  rating,
  applyBatch,
  onApplied,
}: {
  runId: number | null | undefined;
  questionId: number | null | undefined;
  /** The live tree (presenter form), for the "at least 3 terms" check. */
  mindmap: LiveMindmap | undefined;
  /** The question's saved settings (presenter payload). */
  settings: MindmapAiSettings | undefined;
  /** Rating phase: no optimisation. */
  rating: boolean;
  /** Queued batch apply (moderation hook) → counts, null on failure. */
  applyBatch: (
    proposal: string,
    selected: number[],
  ) => Promise<{ applied: number; skipped: number } | null>;
  onApplied: (res: { applied: number; skipped: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<MindmapAiSettings>(settings ?? DEFAULT_SETTINGS);
  const [busy, setBusy] = useState<"optimize" | "preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const seq = useRef(0);

  // Settings follow the question (and a save from another beamer tab).
  const settingsKey = JSON.stringify(settings ?? null);
  useEffect(() => {
    if (settings) setDraft(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId, settingsKey]);

  // A proposal belongs to one question and the collecting stage.
  const discard = () => {
    seq.current += 1;
    setProposal(null);
    setError(null);
    setBusy(null);
  };
  useEffect(() => {
    discard();
    setOpen(false);
  }, [runId, questionId]);
  useEffect(() => {
    if (rating) discard();
  }, [rating]);

  const terms = mindmap ? countVisible(mindmap.nodes) : 0;
  const nothingChosen = !draft.merge && !draft.translate && !draft.restructure;
  const blockedReason = rating
    ? "Not possible while rating is in progress."
    : terms < 3
      ? "At least 3 terms are needed."
      : nothingChosen
        ? "Select at least one optimisation."
        : null;

  const optimize = async () => {
    if (runId == null || questionId == null || busy || blockedReason) return;
    const mine = ++seq.current;
    setBusy("optimize");
    setError(null);
    setProposal(null);
    try {
      const res = await live.mindmapAiOptimize(runId, questionId, draft);
      if (mine !== seq.current) return;
      setProposal({
        proposal: res.proposal,
        ops: res.ops,
        dropped: res.dropped,
        preview: res.preview,
        active: res.active,
        selected: res.ops.map((o) => o.index),
      });
    } catch (err) {
      if (mine === seq.current) setError(requestDetail(err));
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  };

  const toggle = async (index: number) => {
    if (!proposal || runId == null || questionId == null || busy === "apply") return;
    const selected = toggleSelection(proposal.ops, proposal.selected, index);
    setProposal({ ...proposal, selected });
    const mine = ++seq.current;
    setBusy("preview");
    try {
      const res = await live.mindmapAiPreview(runId, questionId, proposal.proposal, selected);
      if (mine !== seq.current) return;
      setProposal((p) => (p ? { ...p, preview: res.preview, active: res.active } : p));
    } catch (err) {
      if (mine === seq.current) setError(requestDetail(err));
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  };

  const apply = async () => {
    if (!proposal || busy || proposal.selected.length === 0) return;
    setBusy("apply");
    const res = await applyBatch(proposal.proposal, proposal.selected);
    setBusy(null);
    if (!res) return; // the toast says why; the preview stays
    onApplied(res);
    discard();
    setOpen(false);
  };

  return {
    open,
    setOpen,
    close: () => {
      discard();
      setOpen(false);
    },
    draft,
    setDraft,
    busy,
    error,
    proposal,
    blockedReason,
    optimize,
    toggle,
    apply,
    discard,
  };
}

export type MindmapAi = ReturnType<typeof useMindmapAi>;

const OP_ICONS = { merge: Merge, rename: Languages, move: MoveRight, add: FolderPlus } as const;

/** The slide-out drawer: settings + "Optimise mind map", then the proposal
 *  checklist with Apply / Discard. `drawerAttr` marks it for the beamer's
 *  key handling (Enter/Space stay with the focused control). */
export function MindmapAiDrawer({
  ai,
  drawerAttr,
  onClick,
}: {
  ai: MindmapAi;
  drawerAttr: string;
  onClick?: (e: { target: EventTarget }) => void;
}) {
  const { t } = useTranslation();
  const { draft, setDraft, busy, proposal } = ai;
  const disabled = busy !== null;
  const activeSet = new Set(proposal?.active ?? []);
  const switches = [
    ["merge", t("Merge duplicates and synonyms")],
    ["translate", t("Unify the language")],
    ["restructure", t("Restructure (move terms, new parent terms)")],
  ] as const;
  return (
    <div
      {...{ [drawerAttr]: "" }}
      onClick={onClick}
      data-testid="mm-ai-panel"
      className={`fixed right-0 top-0 z-40 flex h-full w-96 max-w-full flex-col border-l border-slate-200 bg-white text-slate-800 transition-transform duration-300 ${
        ai.open ? "translate-x-0 shadow-2xl" : "translate-x-full"
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-100 p-3">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600">
          <Sparkles className="h-4 w-4" aria-hidden />
          {t("AI mind map")}
        </span>
        <button
          type="button"
          onClick={ai.close}
          aria-label={t("Close")}
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-left text-sm">
        {!proposal && (
          <>
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 font-medium text-slate-700">{t("The AI may:")}</legend>
              {switches.map(([key, label]) => (
                <div key={key}>
                  <label className="flex items-start gap-2 text-slate-700">
                    <input
                      type="checkbox"
                      checked={draft[key]}
                      disabled={disabled}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setDraft((d) => ({ ...d, [key]: checked }));
                      }}
                      className="mt-0.5 h-4 w-4 flex-none rounded border-slate-300 accent-brand-600"
                    />
                    {label}
                  </label>
                  {key === "translate" && draft.translate && (
                    <label className="ml-6 mt-1 flex items-center gap-2 text-slate-600">
                      {t("Target language")}
                      <select
                        value={draft.target_lang || "de"}
                        disabled={disabled}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, target_lang: e.target.value as "de" | "en" }))
                        }
                        className="rounded-lg border border-field bg-white px-2 py-1 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                      >
                        <option value="de">{t("German")}</option>
                        <option value="en">{t("English")}</option>
                      </select>
                    </label>
                  )}
                </div>
              ))}
              <p className="text-xs text-slate-400">{t("Saved on the question.")}</p>
            </fieldset>
            <div>
              <button
                type="button"
                onClick={() => void ai.optimize()}
                disabled={disabled || ai.blockedReason !== null}
                title={ai.blockedReason ? t(ai.blockedReason) : undefined}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {busy === "optimize" ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="h-4 w-4" aria-hidden />
                )}
                {ai.error ? t("Try again") : t("Optimise mind map")}
              </button>
              {ai.blockedReason && !disabled && (
                <p className="mt-1.5 text-xs text-slate-500">{t(ai.blockedReason)}</p>
              )}
              {busy === "optimize" && (
                <p className="mt-2 text-slate-600" role="status">
                  {t("The AI is preparing a proposal … this can take a moment.")}
                </p>
              )}
              <p className="mt-3 text-xs text-slate-500">
                {t(
                  "The question, the terms and their descriptions are sent to the AI model — no names or other participant data. Nothing changes until you apply the proposal.",
                )}
              </p>
            </div>
          </>
        )}
        {ai.error && (
          <p className="text-red-700" role="alert">
            {t(ai.error)}
          </p>
        )}
        {proposal && (
          <div className="space-y-3" data-testid="mm-ai-proposal">
            <div>
              <h3 className="font-semibold text-slate-700">{t("Proposal")}</h3>
              <p className="text-slate-600">
                {proposal.ops.length === 0
                  ? t("The AI found nothing to improve.")
                  : t("{{count}} changes proposed — the map shows the result. Untick what you don't want.", {
                      count: proposal.ops.length,
                    })}
              </p>
              {proposal.dropped > 0 && (
                <p className="mt-1 text-xs text-slate-500" data-testid="mm-ai-dropped">
                  {t("{{count}} unsuitable suggestions of the AI were left out.", {
                    count: proposal.dropped,
                  })}
                </p>
              )}
            </div>
            {proposal.ops.length > 0 && (
              <ul className="space-y-1" aria-label={t("Proposed changes")}>
                {proposal.ops.map((op) => {
                  const Icon = OP_ICONS[op.type];
                  const checked = proposal.selected.includes(op.index);
                  const stale = checked && busy !== "preview" && !activeSet.has(op.index);
                  return (
                    <li key={op.index}>
                      <label
                        className={`flex items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-slate-50 ${
                          checked ? "" : "text-slate-400"
                        }`}
                        data-mm-op={op.index}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy === "apply"}
                          onChange={() => void ai.toggle(op.index)}
                          className="mt-0.5 h-4 w-4 flex-none rounded border-slate-300 accent-brand-600"
                        />
                        <Icon className="mt-0.5 h-4 w-4 flex-none" style={{ color: AI_MARK }} aria-hidden />
                        <span className="min-w-0">
                          <span className="block font-medium">{op.label}</span>
                          {op.reason && (
                            <span className="block text-xs text-slate-500">{op.reason}</span>
                          )}
                          {stale && (
                            <span className="block text-xs text-amber-700">
                              {t("Doesn't fit the map with this selection.")}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => void ai.apply()}
                disabled={busy !== null || proposal.selected.length === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {(busy === "apply" || busy === "preview") && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                )}
                {t("Apply")}
              </button>
              <button
                type="button"
                onClick={ai.discard}
                disabled={busy === "apply"}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                {t("Discard")}
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {t("Ctrl/Cmd+Z undoes the applied changes as a whole.")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
