// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** AI grouping of matrix cards (beamer, expert mode, AI configured, the
 *  question's AI switch on) — the matrix counterpart of `mindmapAi.tsx`.
 *
 *  The presenter picks how alike cards must be (spelling only / same
 *  content / conceptually similar) and asks for a proposal: groups of cards
 *  within one field, each to be topped by a new summary card (title, and
 *  with descriptions / categories on: description and category, editable
 *  before applying) — or kept under an existing summary card; groups that
 *  no longer fit the board come greyed out with the reason. Hints name the
 *  same content in different fields (display only; "Highlight" rings those
 *  cards on the board). "Apply" sends all ticked groups in one step; "Undo"
 *  reverts exactly that step until the next apply or until the panel
 *  closes (409 when a stack changed meanwhile → the server's reason).
 *  Locked while rating, like manual stacking. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles, Undo2, X } from "lucide-react";
import { live } from "../api";
import type {
  MatrixAiEdit,
  MatrixAiLevel,
  MatrixAiProposal,
  MatrixAiSkipReason,
  MatrixBoard,
  MatrixSettingsPayload,
} from "../api";
import { AI_MARK } from "./MindMap";
import { matrixStacks } from "./Matrix";
import { requestBody, requestDetail } from "./mindmapModeration";

const TITLE_MAX = 60;
/** Drawer width (rem); the board fits beside it (MatrixPanel). */
export const MATRIX_AI_DRAWER_REM = 24;
const DESCRIPTION_MAX = 200;

export const MATRIX_AI_LEVELS: MatrixAiLevel[] = ["spelling", "same", "similar"];

const LEVEL_TEXT: Record<MatrixAiLevel, { name: string; text: string }> = {
  spelling: { name: "Spelling only", text: "Only typos, upper/lower case, singular/plural." },
  same: { name: "Same content", text: "The same content in other words." },
  similar: { name: "Conceptually similar", text: "A shared theme or idea." },
};

/** English source strings of the skip reasons (live.matrix SKIP_*). */
export const SKIP_TEXT: Record<MatrixAiSkipReason, string> = {
  unknown: "A card no longer exists.",
  hidden: "A card is hidden.",
  zones: "The cards lie in different fields.",
  duplicate: "A card is already part of another group.",
  too_few: "Fewer than two cards are left.",
  changed: "A stack has changed since the proposal.",
  limit: "Card limit reached — no room for a summary card.",
};

/** The rating lock (same wording as the stack moderation). */
const RATING_LOCK = "Stacking and deleting are locked while rating.";

interface Proposal extends MatrixAiProposal {
  selected: number[];
  edits: Record<number, MatrixAiEdit>;
}

export function useMatrixAi({
  runId,
  questionId,
  board,
  settings,
  rating,
  showBoard,
  notify,
}: {
  runId: number;
  questionId: number;
  board: MatrixBoard;
  settings: MatrixSettingsPayload;
  /** Rating stage: no grouping (stacks are locked). */
  rating: boolean;
  /** Show the board an apply / undo answered with. */
  showBoard: (board: MatrixBoard) => void;
  /** Short result message (toast). */
  notify: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<MatrixAiLevel>("same");
  const [busy, setBusy] = useState<"propose" | "apply" | "undo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  /** Index of the hint whose cards are highlighted on the board. */
  const [highlight, setHighlight] = useState<number | null>(null);
  const seq = useRef(0);

  const discard = () => {
    seq.current += 1;
    setProposal(null);
    setHighlight(null);
    setError(null);
    setBusy(null);
  };
  // A proposal belongs to the collecting stage.
  useEffect(() => {
    if (rating) discard();
  }, [rating]);

  const tops = matrixStacks(board.cards).filter((s) => !s.card.hidden).length;
  const withCategory = settings.category_mode !== "off" && settings.categories.length > 0;
  /** The category the select shows (and apply sends): the proposal's when it
   *  is one of the question's, else the first. */
  const shownCategory = (key: string | undefined) =>
    !withCategory ? "" : settings.categories.some((c) => c.key === key) ? key! : settings.categories[0].key;
  const blockedReason = rating ? RATING_LOCK : tops < 3 ? "At least 3 cards are needed." : null;

  const propose = async () => {
    if (busy || blockedReason) return;
    const mine = ++seq.current;
    setBusy("propose");
    setError(null);
    setProposal(null);
    setHighlight(null);
    try {
      const res = await live.matrixAiPropose(runId, questionId, level);
      if (mine !== seq.current) return;
      const edits: Record<number, MatrixAiEdit> = {};
      for (const g of res.groups) {
        if (g.status === "ok" && g.top_summary_id == null) {
          edits[g.index] = { title: g.title, description: g.description, category: shownCategory(g.category) };
        }
      }
      setProposal({
        ...res,
        selected: res.groups.filter((g) => g.status === "ok").map((g) => g.index),
        edits,
      });
    } catch (err) {
      if (mine === seq.current) setError(requestDetail(err));
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  };

  const toggle = (index: number) =>
    setProposal((p) =>
      p && {
        ...p,
        selected: p.selected.includes(index) ? p.selected.filter((i) => i !== index) : [...p.selected, index].sort((a, b) => a - b),
      },
    );
  const edit = (index: number, change: Partial<MatrixAiEdit>) =>
    setProposal((p) => p && { ...p, edits: { ...p.edits, [index]: { ...p.edits[index], ...change } } });

  const emptyTitle = !!proposal?.selected.some((i) => proposal.edits[i] && !proposal.edits[i].title.trim());

  const apply = async () => {
    if (!proposal || busy || rating || proposal.selected.length === 0 || emptyTitle) return;
    const mine = ++seq.current;
    setBusy("apply");
    setError(null);
    const edits: Record<number, MatrixAiEdit> = {};
    for (const i of proposal.selected) {
      const e = proposal.edits[i];
      if (!e) continue;
      edits[i] = {
        title: e.title.trim(),
        ...(settings.descriptions ? { description: (e.description ?? "").trim() } : null),
        ...(withCategory && e.category ? { category: e.category } : null),
      };
    }
    try {
      const res = await live.matrixAiApply(runId, questionId, proposal.proposal, proposal.selected, edits);
      if (mine !== seq.current) return;
      showBoard(res.matrix);
      setUndo(res.applied.length > 0 ? res.undo : null);
      // The title as the presenter edited it (else the proposal's).
      const title = (i: number) =>
        proposal.edits[i]?.title.trim() || proposal.groups.find((g) => g.index === i)?.title || "";
      notify(
        [
          res.applied.length > 0
            ? t("{{count}} proposals applied.", { count: res.applied.length })
            : t("Nothing was applied."),
          res.skipped.length > 0
            ? t("Skipped: {{list}}", {
                list: res.skipped.map((s) => `${title(s.index)} – ${t(SKIP_TEXT[s.reason] ?? s.reason)}`).join("; "),
              })
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      setProposal(null);
      setHighlight(null);
    } catch (err) {
      if (mine === seq.current) setError(requestDetail(err));
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  };

  const revert = async () => {
    if (!undo || busy || rating) return;
    const mine = ++seq.current;
    setBusy("undo");
    setError(null);
    try {
      const res = await live.matrixAiUndo(runId, questionId, undo);
      if (mine !== seq.current) return;
      showBoard(res.matrix);
      setUndo(null);
      notify(t("The grouping was undone."));
    } catch (err) {
      if (mine !== seq.current) return;
      setError(requestDetail(err));
      // The server refused (stack changed, expired): this step is gone for
      // good — only a network error leaves "Undo" to try again.
      if (requestBody(err)) setUndo(null);
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  };

  /** Card ids to ring on the board (the shown hint's). */
  const highlightIds = useMemo(() => {
    const hint = highlight != null ? proposal?.hints.find((h) => h.index === highlight) : undefined;
    return hint ? new Set(hint.cards.map((c) => c.id)) : undefined;
  }, [highlight, proposal]);

  return {
    open,
    setOpen,
    /** Closing drops the proposal and the undo step. Closing while an apply
     *  is in flight (`discard` bumps `seq`) ignores its answer: the board
     *  still updates via SSE (the server broadcasts the apply), but the undo
     *  token is dropped with the panel — like any close after an apply. */
    close: () => {
      discard();
      setUndo(null);
      setOpen(false);
    },
    level,
    setLevel,
    busy,
    error,
    proposal,
    undo,
    rating,
    blockedReason,
    emptyTitle,
    withCategory,
    highlight,
    setHighlight,
    highlightIds,
    propose,
    toggle,
    edit,
    apply,
    revert,
    discard,
  };
}

export type MatrixAi = ReturnType<typeof useMatrixAi>;

const FIELD =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-60";
const PRIMARY =
  "inline-flex items-center gap-2 rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed disabled:opacity-50";

/** The slide-out drawer of the ✦ handle. */
export function MatrixAiDrawer({
  ai,
  drawerRef,
  drawerAttr,
  settings,
  zoneName,
  catText,
  categoryName,
}: {
  ai: MatrixAi;
  drawerRef: RefObject<HTMLDivElement>;
  drawerAttr: string;
  settings: MatrixSettingsPayload;
  zoneName: (zone: string) => string;
  /** Category of a card as text ("" when categories are off). */
  catText: (key: string) => string;
  /** Option label of a category key. */
  categoryName: (key: string) => string;
}) {
  const { t } = useTranslation();
  const { busy, proposal } = ai;
  // Closed (off-screen): out of the tab order and the accessibility tree.
  useEffect(() => {
    if (drawerRef.current) drawerRef.current.inert = !ai.open;
  }, [ai.open, drawerRef]);
  const levelKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = MATRIX_AI_LEVELS.indexOf(ai.level);
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? MATRIX_AI_LEVELS[(i + 1) % MATRIX_AI_LEVELS.length]
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? MATRIX_AI_LEVELS[(i + MATRIX_AI_LEVELS.length - 1) % MATRIX_AI_LEVELS.length]
          : null;
    if (!next) return;
    e.preventDefault();
    e.stopPropagation(); // arrows pick the level, they don't navigate questions
    ai.setLevel(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-level="${next}"]`)?.focus();
  };
  const cardList = (cards: { id: number; title: string; category: string }[]) =>
    cards.map((c, i) => {
      const cat = catText(c.category);
      return (
        <span key={c.id}>
          {i > 0 && ", "}
          <span className="font-medium text-slate-800">{c.title}</span>
          {cat && <span className="text-slate-500"> ({cat})</span>}
        </span>
      );
    });
  const disabled = busy !== null || ai.rating;
  // `dropped` counts the skipped groups too; those are listed (greyed out).
  const left = proposal ? proposal.dropped - proposal.groups.filter((g) => g.status !== "ok").length : 0;
  return (
    <div
      {...{ [drawerAttr]: "" }}
      ref={drawerRef}
      data-testid="mx-ai-panel"
      role="region"
      aria-labelledby="mx-ai-title"
      style={{ width: `${MATRIX_AI_DRAWER_REM}rem` }}
      className={`fixed right-0 top-0 z-40 flex h-full max-w-full flex-col border-l border-slate-200 bg-white text-slate-800 transition-transform duration-300 motion-reduce:transition-none ${
        ai.open ? "translate-x-0 shadow-2xl" : "translate-x-full"
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-100 p-3">
        <h2 id="mx-ai-title" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600">
          <Sparkles className="h-4 w-4" aria-hidden />
          {t("AI grouping")}
        </h2>
        <button
          type="button"
          onClick={ai.close}
          aria-label={t("Close")}
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-left text-sm">
        {ai.rating && (
          <p data-testid="mx-ai-locked" className="rounded-lg bg-slate-100 px-2.5 py-2 text-slate-700">
            {t(RATING_LOCK)}
          </p>
        )}
        {ai.undo && !proposal && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 p-2.5" data-testid="mx-ai-applied">
            <p className="flex-1 text-slate-700">{t("Applied. Undo reverts this step as a whole.")}</p>
            <button type="button" className={SECONDARY} onClick={() => void ai.revert()} disabled={disabled}>
              {busy === "undo" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Undo2 className="h-4 w-4" aria-hidden />}
              {t("Undo")}
            </button>
          </div>
        )}
        {!proposal && (
          <>
            <div>
              <p id="mx-ai-level" className="mb-1.5 font-medium text-slate-700">
                {t("What should be grouped?")}
              </p>
              <div
                role="radiogroup"
                aria-labelledby="mx-ai-level"
                onKeyDown={levelKeys}
                className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5 font-semibold"
              >
                {MATRIX_AI_LEVELS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="radio"
                    data-level={l}
                    aria-checked={ai.level === l}
                    tabIndex={ai.level === l ? 0 : -1}
                    disabled={disabled}
                    onClick={() => ai.setLevel(l)}
                    className={`flex-1 rounded-md px-1.5 py-1 text-xs leading-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed ${
                      ai.level === l ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    {t(LEVEL_TEXT[l].name)}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-slate-600" data-testid="mx-ai-level-text">
                {t(LEVEL_TEXT[ai.level].text)}
              </p>
            </div>
            <div>
              <button
                type="button"
                onClick={() => void ai.propose()}
                disabled={disabled || ai.blockedReason !== null}
                className={PRIMARY}
              >
                {busy === "propose" ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="h-4 w-4" aria-hidden />
                )}
                {ai.error ? t("Try again") : t("Get proposal")}
              </button>
              {ai.blockedReason && !ai.rating && (
                <p className="mt-1.5 text-xs text-slate-600">{t(ai.blockedReason)}</p>
              )}
              {busy === "propose" && (
                <p className="mt-2 text-slate-600" role="status">
                  {t("The AI is preparing a proposal … this can take a moment.")}
                </p>
              )}
              <p className="mt-3 text-xs text-slate-600">
                {t(
                  "The question, the axes, the field names and the cards are sent to the AI model — no names or other participant data. Nothing changes until you apply the proposal.",
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
          <div className="space-y-3" data-testid="mx-ai-proposal">
            <div>
              <h3 className="font-semibold text-slate-700">{t("Proposal")}</h3>
              <p className="text-slate-600">
                {proposal.groups.length === 0
                  ? t("The AI found nothing to group.")
                  : t("{{count}} groups proposed — untick what you don't want.", { count: proposal.groups.length })}
              </p>
              {left > 0 && (
                <p className="mt-1 text-xs text-slate-600" data-testid="mx-ai-dropped">
                  {t("{{count}} unsuitable suggestions of the AI were left out.", { count: left })}
                </p>
              )}
            </div>
            {proposal.groups.length > 0 && (
              <ul className="space-y-2" aria-label={t("Proposed groups")}>
                {proposal.groups.map((g) => {
                  const ok = g.status === "ok";
                  const checked = proposal.selected.includes(g.index);
                  const e = proposal.edits[g.index];
                  const titles = g.cards.map((c) => c.title).join(", ");
                  const idBase = `mx-ai-g${g.index}`;
                  return (
                    <li
                      key={g.index}
                      data-testid="mx-ai-group"
                      data-status={g.status}
                      className={`rounded-lg border p-2.5 ${ok ? "border-slate-200" : "border-dashed border-slate-300 bg-slate-50 text-slate-600"}`}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!ok || disabled}
                          onChange={() => ai.toggle(g.index)}
                          aria-label={t("Group: {{titles}}", { titles })}
                          className="mt-0.5 h-4 w-4 flex-none rounded border-slate-300 accent-brand-600"
                        />
                        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                          {g.zone && <p className="text-xs font-semibold text-slate-600">{zoneName(g.zone)}</p>}
                          <p>{cardList(g.cards)}</p>
                          {!ok && g.skip_reason && (
                            <p className="mt-1 text-xs font-medium text-slate-700">
                              {t(SKIP_TEXT[g.skip_reason] ?? g.skip_reason)}
                            </p>
                          )}
                          {ok && g.top_summary_id != null && (
                            <p className="mt-1 flex items-center gap-1 text-xs text-slate-700">
                              <Sparkles className="h-3.5 w-3.5 flex-none" style={{ color: AI_MARK }} aria-hidden />
                              {t("The existing summary card stays: “{{title}}”", { title: g.title })}
                            </p>
                          )}
                          {ok && e && (
                            <div className={`mt-2 space-y-2 ${checked ? "" : "opacity-60"}`}>
                              <label className="block text-xs font-medium text-slate-700" htmlFor={`${idBase}-title`}>
                                {t("Summary card title")}
                              </label>
                              <input
                                id={`${idBase}-title`}
                                className={`${FIELD} !mt-0.5`}
                                value={e.title}
                                maxLength={TITLE_MAX}
                                disabled={!checked || disabled}
                                onChange={(ev) => ai.edit(g.index, { title: ev.target.value })}
                              />
                              {settings.descriptions && (
                                <>
                                  <label className="block text-xs font-medium text-slate-700" htmlFor={`${idBase}-desc`}>
                                    {t("Summary card description")}
                                  </label>
                                  <textarea
                                    id={`${idBase}-desc`}
                                    className={`${FIELD} !mt-0.5`}
                                    rows={2}
                                    value={e.description ?? ""}
                                    maxLength={DESCRIPTION_MAX}
                                    disabled={!checked || disabled}
                                    onChange={(ev) => ai.edit(g.index, { description: ev.target.value })}
                                  />
                                </>
                              )}
                              {ai.withCategory && (
                                <>
                                  <label className="block text-xs font-medium text-slate-700" htmlFor={`${idBase}-cat`}>
                                    {t("Summary card category")}
                                  </label>
                                  <select
                                    id={`${idBase}-cat`}
                                    className={`${FIELD} !mt-0.5`}
                                    value={e.category ?? ""}
                                    disabled={!checked || disabled}
                                    onChange={(ev) => ai.edit(g.index, { category: ev.target.value })}
                                  >
                                    {settings.categories.map((c) => (
                                      <option key={c.key} value={c.key}>
                                        {categoryName(c.key)}
                                      </option>
                                    ))}
                                  </select>
                                </>
                              )}
                            </div>
                          )}
                          {g.reason && <p className="mt-1.5 text-xs italic text-slate-600">{g.reason}</p>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {proposal.hints.length > 0 && (
              <section data-testid="mx-ai-hints" aria-labelledby="mx-ai-hints-title" className="border-t border-slate-100 pt-3">
                <h3 id="mx-ai-hints-title" className="font-semibold text-slate-700">
                  {t("Same content, but placed differently")}
                </h3>
                <ul className="mt-1.5 space-y-2">
                  {proposal.hints.map((h) => {
                    const shown = ai.highlight === h.index;
                    return (
                      <li key={h.index} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2.5">
                        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                          <p>
                            {h.cards.map((c, i) => (
                              <span key={c.id}>
                                {i > 0 && ", "}
                                <span className="font-medium text-slate-800">{c.title}</span>
                                <span className="text-slate-500"> ({zoneName(c.zone)})</span>
                              </span>
                            ))}
                          </p>
                          {h.reason && <p className="mt-1 text-xs italic text-slate-600">{h.reason}</p>}
                        </div>
                        <button
                          type="button"
                          aria-pressed={shown}
                          onClick={() => ai.setHighlight(shown ? null : h.index)}
                          className={`flex-none rounded-lg border px-2 py-1 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${
                            shown ? "border-transparent text-white" : "border-slate-300 text-slate-700 hover:bg-slate-50"
                          }`}
                          style={shown ? { background: AI_MARK } : undefined}
                        >
                          {t("Highlight")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
              <button
                type="button"
                onClick={() => void ai.apply()}
                disabled={disabled || proposal.selected.length === 0 || ai.emptyTitle}
                className={PRIMARY}
              >
                {busy === "apply" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {t("Apply ({{n}})", { n: proposal.selected.length })}
              </button>
              <button type="button" onClick={ai.discard} disabled={busy === "apply"} className={SECONDARY}>
                {t("Discard")}
              </button>
            </div>
            {ai.emptyTitle && <p className="text-xs text-red-700">{t("Every summary card needs a title.")}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
