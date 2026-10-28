// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): the library's "Tags" tab — every tag A–Z with its number
 *  of questions, and a search-and-replace tool for tag names (replacing a
 *  whole tag by nothing deletes it). */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Replace, Search, Tag } from "lucide-react";
import { quizbar, requestDetail, type LibraryTag } from "../api";
import { Button, ConfirmDialog, TextInput } from "../components/ui";

type Change = { id: number; name: string; new: string | null; questions: number };

export default function TagsPanel({
  tags,
  onPick,
  onChanged,
}: {
  tags: LibraryTag[];
  /** Show the questions with this tag. */
  onPick: (name: string) => void;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [whole, setWhole] = useState(false);
  const [changes, setChanges] = useState<Change[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");

  const sorted = useMemo(
    () =>
      [...tags]
        .filter((tag) => tag.name.includes(filter.trim().toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    [tags, filter],
  );

  // Live preview of what "Replace" would do.
  useEffect(() => {
    if (!find.trim()) {
      setChanges([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void quizbar.replaceTags({ find, replace, whole, apply: false }).then(
        (result) => setChanges(result.changes),
        () => setChanges([]),
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [find, replace, whole, tags]);

  const deletions = changes.filter((c) => c.new === null).length;

  async function apply() {
    setBusy(true);
    setMessage("");
    try {
      const result = await quizbar.replaceTags({ find, replace, whole, apply: true });
      setMessage(t("{{count}} tags changed.", { count: result.changes.length }));
      setFind("");
      setReplace("");
      await onChanged();
    } catch (err) {
      setMessage(requestDetail(err) ?? t("That did not work."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5">
      <section className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <Replace aria-hidden className="h-4 w-4" />
          {t("Search and replace in tags")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <TextInput
            value={find}
            onChange={(event) => setFind(event.target.value)}
            placeholder={t("Find, e.g. electro-")}
            aria-label={t("Find")}
            className="!w-56"
          />
          <span className="text-slate-400">→</span>
          <TextInput
            value={replace}
            onChange={(event) => setReplace(event.target.value)}
            placeholder={t("Replace with (empty = delete)")}
            aria-label={t("Replace with")}
            className="!w-64"
          />
          <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={whole}
              onChange={(event) => setWhole(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 accent-brand-600"
            />
            {t("Whole tag only")}
          </label>
          <Button
            variant={deletions ? "danger" : "primary"}
            disabled={!changes.length || busy}
            onClick={() => (deletions ? setConfirm(true) : void apply())}
          >
            {deletions && deletions === changes.length
              ? t("Delete {{count}} tags", { count: deletions })
              : t("Change {{count}} tags", { count: changes.length })}
          </Button>
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {t(
            "Without “Whole tag only”, the text is replaced inside every tag that contains it. A tag that becomes empty is deleted (its questions keep their other tags); a tag that becomes an existing one is merged into it.",
          )}
        </p>
        {find.trim() && (
          <ul className="mt-3 grid gap-1 text-sm">
            {changes.length === 0 ? (
              <li className="text-slate-400">{t("No tag matches.")}</li>
            ) : (
              changes.map((change) => (
                <li key={change.id} className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700 line-through decoration-slate-400 dark:bg-slate-800 dark:text-slate-200">
                    {change.name}
                  </span>
                  <span className="text-slate-400">→</span>
                  {change.new === null ? (
                    <span className="text-red-700 dark:text-red-400">{t("deleted")}</span>
                  ) : (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-800 dark:bg-brand-950/40 dark:text-brand-200">
                      {change.new}
                    </span>
                  )}
                  <span className="text-xs text-slate-400">{t("{{count}} questions", { count: change.questions })}</span>
                </li>
              ))
            )}
          </ul>
        )}
        {message && (
          <p role="status" className="mt-2 text-sm text-brand-800 dark:text-brand-200">
            {message}
          </p>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {t("All tags")} <span className="font-normal text-slate-500">{tags.length}</span>
          </h2>
          <div className="relative ml-auto w-64">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <TextInput
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("Filter tags …")}
              aria-label={t("Filter tags …")}
              className="pl-8"
            />
          </div>
        </div>
        {sorted.length === 0 ? (
          <p className="text-sm text-slate-500">{t("No tags yet.")}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {sorted.map((tag) => (
              <li
                key={tag.id}
                className="group flex min-w-0 items-center gap-1 rounded-lg border border-slate-200 bg-white pl-2 dark:border-slate-800 dark:bg-slate-950"
              >
                <button
                  type="button"
                  onClick={() => onPick(tag.name)}
                  title={t("Show its questions")}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm text-slate-700 hover:text-brand-800 dark:text-slate-200"
                >
                  <Tag aria-hidden className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="truncate">{tag.name}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-xs text-slate-400">{tag.count ?? ""}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFind(tag.name);
                    setReplace(tag.name);
                    setWhole(true);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  aria-label={t("Rename or delete {{name}}", { name: tag.name })}
                  title={t("Rename or delete")}
                  className="rounded-md p-1.5 text-slate-400 opacity-60 hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 dark:hover:bg-slate-800"
                >
                  <Pencil aria-hidden className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {confirm && (
        <ConfirmDialog
          message={t("Delete {{count}} tags from all their questions? The questions stay in the library.", {
            count: deletions,
          })}
          onConfirm={() => {
            setConfirm(false);
            void apply();
          }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
