// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Presenter moderation of a live mind map with undo/redo (stage 2).
 *
 * Every action is sent to the server; its inverse is derived from the
 * response (merge/rename: an opaque undo blob for `unmerge`, move: the old
 * parent, add: delete the added term, hide: unhide). Actions run strictly one
 * after another (a promise queue) and the stacks are only touched inside the
 * queue, so quick Ctrl+Z presses can't race an action still in flight.
 * Redoing an add creates the term anew under a new id — later entries are
 * remapped to it. Stacks are kept per run + question.
 *
 * An applied AI optimisation is one entry ("ai"): undo reverts the whole
 * batch on the server; it can't be redone (and undoing it drops the redo
 * stack, whose entries were made on top of the optimised map).
 *
 * Merge, move, rename and AI entries remember their moderation-log entry
 * (`logId`, #201): undoing them marks that entry reset on the server, and
 * resetting an entry from the drawer's list (`resetLog`) drops the matching
 * undo/redo entries, so a later Ctrl+Z doesn't try to undo it again. */
import { useRef, useState } from "react";
import { errorDetail, live, requestBody } from "../api";
import type { MindmapAiUndo } from "../api";

type Entry =
  | { kind: "add"; parent: number | null; text: string; description?: string; node: number }
  | { kind: "merge"; source: number; target: number; undo: string; logId?: number | null }
  | { kind: "move"; node: number; from: number | null; to: number | null; logId?: number | null }
  | { kind: "rename"; node: number; text: string; undo: string; logId?: number | null }
  | { kind: "hide"; node: number; hidden: boolean }
  | { kind: "ai"; undo: MindmapAiUndo; logId?: number | null };

interface Stacks {
  undo: Entry[];
  redo: Entry[];
}

function remap(entry: Entry, from: number, to: number): Entry {
  const r = (id: number) => (id === from ? to : id);
  const rp = (id: number | null) => (id === null ? null : r(id));
  switch (entry.kind) {
    case "add":
      return { ...entry, parent: rp(entry.parent), node: r(entry.node) };
    case "merge":
      return { ...entry, source: r(entry.source), target: r(entry.target) };
    case "move":
      return { ...entry, node: r(entry.node), from: rp(entry.from), to: rp(entry.to) };
    case "rename":
    case "hide":
      return { ...entry, node: r(entry.node) };
    case "ai":
      return entry;
  }
}

export function useMindmapModeration(
  runId: number | null | undefined,
  questionId: number | null | undefined,
  {
    onError,
    onInfo,
    onAction,
    onHiddenConflict,
  }: {
    /** A request failed (`detail` from the server, untranslated). */
    onError: (detail: string) => void;
    /** Something worth telling that isn't an error (untranslated key). */
    onInfo?: (message: string) => void;
    /** Any moderation action was taken (e.g. to dismiss the hint). */
    onAction?: () => void;
    /** An add hit an existing but hidden term (`node`) at that place. */
    onHiddenConflict?: (node: number) => void;
  },
) {
  const all = useRef(new Map<string, Stacks>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [, setTick] = useState(0);
  const cbs = useRef({ onError, onInfo, onAction, onHiddenConflict });
  cbs.current = { onError, onInfo, onAction, onHiddenConflict };

  const key = runId != null && questionId != null ? `${runId}:${questionId}` : null;
  const stacksFor = (k: string) => {
    let s = all.current.get(k);
    if (!s) {
      s = { undo: [], redo: [] };
      all.current.set(k, s);
    }
    return s;
  };

  /** Runs `task` after everything queued before it. */
  const enqueue = (task: (rid: number, qid: number, stacks: Stacks) => Promise<void>) => {
    if (runId == null || questionId == null || key === null) return;
    const rid = runId;
    const qid = questionId;
    const stacks = stacksFor(key);
    queue.current = queue.current
      .then(() => task(rid, qid, stacks))
      .catch((err) => {
        // 409 {hidden: true, conflict}: the term exists there but is hidden
        // — offered to be shown again instead of a plain error.
        const body = requestBody(err);
        if (body?.hidden === true && typeof body.conflict === "number" && cbs.current.onHiddenConflict)
          cbs.current.onHiddenConflict(body.conflict);
        else cbs.current.onError(errorDetail(err));
      })
      .finally(() => setTick((n) => n + 1));
  };

  /** Performs an entry (first time or redo); returns the entry as it now
   *  stands (new undo blob / new id), or null when nothing happened. */
  const perform = async (rid: number, qid: number, e: Entry, stacks: Stacks): Promise<Entry | null> => {
    switch (e.kind) {
      case "add": {
        const res = await live.mindmapAdd(rid, qid, {
          parent: e.parent,
          text: e.text,
          ...(e.description ? { description: e.description } : {}),
        });
        // Redo: later entries still name the old id — point them at the
        // term as it exists now (also when it came back `merged`).
        if (res.node_id !== e.node && e.node > 0) {
          stacks.undo = stacks.undo.map((x) => remap(x, e.node, res.node_id));
          stacks.redo = stacks.redo.map((x) => remap(x, e.node, res.node_id));
        }
        if (res.merged) {
          // Someone else's (or an existing) term: nothing to undo.
          cbs.current.onInfo?.("This term already exists there.");
          return null;
        }
        return { ...e, node: res.node_id };
      }
      case "merge": {
        const res = await live.mindmapMerge(rid, qid, e.source, e.target);
        return { ...e, undo: res.undo, logId: res.log_id };
      }
      case "move": {
        // The server's old parent is authoritative (the client tree may lag).
        const res = await live.mindmapMove(rid, qid, e.node, e.to);
        return { ...e, from: res.undo.parent, logId: res.log_id };
      }
      case "rename": {
        const res = await live.mindmapRename(rid, qid, e.node, e.text);
        return { ...e, undo: res.undo, logId: res.log_id };
      }
      case "hide":
        await live.mindmapHide(rid, qid, e.node, e.hidden);
        return e;
      case "ai":
        // Not redoable (a fresh proposal is one click away).
        return null;
    }
  };

  const revert = async (rid: number, qid: number, e: Entry) => {
    switch (e.kind) {
      case "add":
        await live.mindmapDelete(rid, qid, e.node);
        return;
      case "merge":
      case "rename":
        await live.mindmapUnmerge(rid, qid, e.undo);
        return;
      case "move":
        await live.mindmapMove(rid, qid, e.node, e.from);
        return;
      case "hide":
        await live.mindmapHide(rid, qid, e.node, !e.hidden);
        return;
      case "ai":
        await live.mindmapAiUndo(rid, qid, e.undo);
        return;
    }
  };

  const act = (entry: Entry) => {
    cbs.current.onAction?.();
    enqueue(async (rid, qid, stacks) => {
      const done = await perform(rid, qid, entry, stacks);
      if (!done) return;
      stacks.undo.push(done);
      stacks.redo = [];
    });
  };

  /** During the rating phase only hiding may be undone/redone (`onlyHide`):
   *  any other entry on top stays put and an info explains why. */
  const blocked = (e: Entry | undefined, onlyHide: boolean) => {
    if (!onlyHide || !e || e.kind === "hide") return false;
    cbs.current.onInfo?.("During the rating, only hiding and showing terms can be undone.");
    return true;
  };

  const undo = (onlyHide = false) =>
    enqueue(async (rid, qid, stacks) => {
      if (blocked(stacks.undo[stacks.undo.length - 1], onlyHide)) return;
      const e = stacks.undo.pop();
      if (!e) return;
      // A failed undo (the map changed in between) is dropped: its detail
      // goes to the toast and the entry can't be redone either.
      await revert(rid, qid, e);
      if (e.kind === "ai") stacks.redo = [];
      else stacks.redo.push(e);
    });

  const redo = (onlyHide = false) =>
    enqueue(async (rid, qid, stacks) => {
      if (blocked(stacks.redo[stacks.redo.length - 1], onlyHide)) return;
      const e = stacks.redo.pop();
      if (!e) return;
      const done = await perform(rid, qid, e, stacks);
      if (done) stacks.undo.push(done);
    });

  /** Applies the selected entries of an AI proposal as one batch (queued
   *  like any action) → one undo entry. Resolves with the server's counts,
   *  or null when the request failed (the error went to `onError`). */
  const applyAi = (proposal: string, selected: number[]) =>
    new Promise<{ applied: number; skipped: number } | null>((resolve) => {
      if (runId == null || questionId == null) return resolve(null);
      cbs.current.onAction?.();
      let result: { applied: number; skipped: number } | null = null;
      enqueue(async (rid, qid, stacks) => {
        const res = await live.mindmapAiApply(rid, qid, proposal, selected);
        result = { applied: res.applied, skipped: res.skipped };
        if (res.undo.length > 0) {
          stacks.undo.push({ kind: "ai", undo: res.undo, logId: res.log_id });
          stacks.redo = [];
        }
      });
      void queue.current.then(() => resolve(result));
    });

  /** Resets one moderation-log entry (queued like any action). Resolves
   *  with null on success — the undo/redo entries of that step are dropped
   *  — or with the server's (untranslated) `detail` when it is refused
   *  (shown inline by the caller, not as a toast). */
  const resetLog = (entryId: number) =>
    new Promise<string | null>((resolve) => {
      // No run/question (yet): nothing was reset — say so instead of
      // reporting success.
      if (runId == null || questionId == null || key === null) return resolve("Not possible right now.");
      const rid = runId;
      const qid = questionId;
      const stacks = stacksFor(key);
      queue.current = queue.current
        .then(async () => {
          try {
            await live.mindmapLogReset(rid, qid, entryId);
          } catch (err) {
            resolve(errorDetail(err));
            return;
          }
          const keep = (e: Entry) => !("logId" in e) || e.logId !== entryId;
          stacks.undo = stacks.undo.filter(keep);
          stacks.redo = stacks.redo.filter(keep);
          resolve(null);
        })
        .finally(() => setTick((n) => n + 1));
    });

  const current = key ? all.current.get(key) : undefined;
  return {
    applyAi,
    resetLog,
    add: (parent: number | null, text: string, description?: string) =>
      act({ kind: "add", parent, text, description, node: 0 }),
    merge: (source: number, target: number) => act({ kind: "merge", source, target, undo: "" }),
    move: (node: number, to: number | null, from: number | null) => {
      if (to !== from) act({ kind: "move", node, from, to });
    },
    rename: (node: number, text: string) => act({ kind: "rename", node, text, undo: "" }),
    hide: (node: number, hidden: boolean) => act({ kind: "hide", node, hidden }),
    undo,
    redo,
    canUndo: (current?.undo.length ?? 0) > 0,
    canRedo: (current?.redo.length ?? 0) > 0,
  };
}
