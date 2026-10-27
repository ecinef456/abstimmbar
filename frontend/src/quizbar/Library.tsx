// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): the question library — shared pieces.
 *
 *  TagInput      — chips + free typing with suggestions.
 *  LibraryField  — the question editor's "In my library" + tags.
 *  LibraryBrowser — search / tag / kind filters over the entries, used by
 *                   the library page (manage) and the set page's picker. */
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Check, Pencil, Search, Tag, Trash2, X } from "lucide-react";
import { localizedText, RichText, stripHtml } from "@basicbar/ui";
import type { LibraryEntry, LibraryTag } from "../api";
import { Button, ConfirmDialog, Select, TextInput } from "../components/ui";
import { mathHtml, MathText } from "../math";

export const KIND_LABEL_KEYS: Record<string, string> = {
  single_choice: "Single Choice",
  multiple_choice: "Multiple Choice",
  word_cloud: "Word cloud",
  likert: "Likert scale",
  open_text: "Free text",
  priorities: "Priorities",
  ordering: "Ordering",
  mindmap: "Mind map",
  matrix: "Four-field matrix",
};

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600";
const CHIP_ON =
  "border-brand-600 bg-brand-50 font-semibold text-brand-800 dark:bg-brand-950/40 dark:text-brand-200";
const CHIP_OFF =
  "border-slate-300 text-slate-600 hover:border-brand-500 hover:text-brand-700 dark:border-slate-700 dark:text-slate-300";
const TAG_PILL =
  "inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200";

function sortTags<T extends { name: string }>(tags: T[]): T[] {
  return [...tags].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/** Tag chips with a text box: Enter or comma adds, Backspace on an empty box
 *  removes the last one. Suggestions come from the teacher's existing tags. */
export function TagInput({
  tags,
  onChange,
  suggestions,
  disabled = false,
  placeholder,
  idPrefix = "qb-tags",
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  disabled?: boolean;
  placeholder?: string;
  idPrefix?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const listId = `${idPrefix}-suggestions`;

  function add(raw: string) {
    const name = raw.replace(/,/g, " ").split(/\s+/).filter(Boolean).join(" ").slice(0, 60);
    setDraft("");
    if (!name || tags.some((tag) => tag.toLowerCase() === name.toLowerCase())) return;
    // Reuse the existing spelling of a known tag.
    const known = suggestions.find((s) => s.toLowerCase() === name.toLowerCase());
    onChange([...tags, known ?? name]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add(draft);
    } else if (event.key === "Backspace" && !draft && tags.length) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 rounded-lg border border-field bg-white px-2 py-1.5 dark:bg-slate-900 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      {tags.map((tag) => (
        <span key={tag} className={TAG_PILL}>
          {tag}
          {!disabled && (
            <button
              type="button"
              aria-label={t("Remove tag {{tag}}", { tag })}
              onClick={() => onChange(tags.filter((x) => x !== tag))}
              className="rounded-full text-slate-500 hover:text-slate-900 dark:hover:text-white"
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      <input
        list={listId}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value;
          // Picking a suggestion from the list adds it straight away.
          if (suggestions.includes(value)) add(value);
          else setDraft(value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={tags.length ? "" : (placeholder ?? t("Add a tag …"))}
        aria-label={t("Add a tag")}
        className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none dark:text-slate-100"
      />
      <datalist id={listId}>
        {suggestions
          .filter((s) => !tags.some((tag) => tag.toLowerCase() === s.toLowerCase()))
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  );
}

/** The question editor's library box. */
export function LibraryField({
  inLibrary,
  onInLibrary,
  tags,
  onTags,
  suggestions,
  copies,
}: {
  inLibrary: boolean;
  onInLibrary: (value: boolean) => void;
  tags: string[];
  onTags: (tags: string[]) => void;
  suggestions: string[];
  copies?: number;
}) {
  const { t } = useTranslation();
  return (
    <section className="grid gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={inLibrary}
          onChange={(event) => onInLibrary(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-700"
        />
        {t("Keep this question in my library")}
      </label>
      {inLibrary && (
        <>
          <TagInput tags={tags} onChange={onTags} suggestions={suggestions} />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {copies && copies > 1
              ? t("Tags belong to the library entry and are shared by its {{count}} copies.", {
                  count: copies,
                })
              : t("Without a tag, the question is listed under “To sort”.")}
          </p>
        </>
      )}
    </section>
  );
}

export type TagFilter = "all" | "untagged" | number;

export function entryMatches(entry: LibraryEntry, query: string): boolean {
  if (!query) return true;
  const haystack = [
    stripHtml(localizedText(entry.text)),
    ...entry.options.map((o) => localizedText(o.text)),
    ...entry.tags.map((tag) => tag.name),
  ]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Filters (search, tag chips, kind) and the filtered list. `renderEntry`
 *  draws each entry; selection is the caller's. */
export function LibraryBrowser({
  entries,
  tags,
  renderEntry,
  toolbar,
  onRenameTag,
  onDeleteTag,
  allowedKinds,
}: {
  entries: LibraryEntry[];
  tags: LibraryTag[];
  renderEntry: (entry: LibraryEntry) => ReactNode;
  /** Shown under the filters, given the visible entries (e.g. bulk actions). */
  toolbar?: (visible: LibraryEntry[]) => ReactNode;
  onRenameTag?: (tag: LibraryTag, name: string) => Promise<void>;
  onDeleteTag?: (tag: LibraryTag) => Promise<void>;
  /** Picker: entries of other kinds are hidden. */
  allowedKinds?: string[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<TagFilter>("all");
  const [kind, setKind] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const usable = useMemo(
    () => (allowedKinds ? entries.filter((e) => allowedKinds.includes(e.kind)) : entries),
    [entries, allowedKinds],
  );
  const counts = useMemo(() => {
    const byTag = new Map<number, number>();
    let untagged = 0;
    for (const entry of usable) {
      if (!entry.tags.length) untagged += 1;
      for (const tag of entry.tags) byTag.set(tag.id, (byTag.get(tag.id) ?? 0) + 1);
    }
    return { byTag, untagged };
  }, [usable]);
  const kinds = useMemo(() => Array.from(new Set(usable.map((e) => e.kind))), [usable]);
  const visible = usable.filter(
    (entry) =>
      (tagFilter === "all" ||
        (tagFilter === "untagged" ? !entry.tags.length : entry.tags.some((tag) => tag.id === tagFilter))) &&
      (!kind || entry.kind === kind) &&
      entryMatches(entry, query.trim()),
  );
  const currentTag = typeof tagFilter === "number" ? tags.find((tag) => tag.id === tagFilter) : undefined;
  useEffect(() => {
    // A deleted or merged tag falls back to "All".
    if (typeof tagFilter === "number" && !tags.some((tag) => tag.id === tagFilter)) setTagFilter("all");
  }, [tags, tagFilter]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search questions, answers and tags")}
            aria-label={t("Search questions, answers and tags")}
            className="!pl-9"
          />
        </div>
        {kinds.length > 1 && (
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            aria-label={t("Question type")}
            className="!w-auto"
          >
            <option value="">{t("All types")}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL_KEYS[k] ?? k)}
              </option>
            ))}
          </Select>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2" aria-label={t("Tags")}>
        <button
          type="button"
          aria-pressed={tagFilter === "all"}
          onClick={() => setTagFilter("all")}
          className={`${CHIP} ${tagFilter === "all" ? CHIP_ON : CHIP_OFF}`}
        >
          {t("All questions")} <span className="tabular-nums opacity-70">{usable.length}</span>
        </button>
        <button
          type="button"
          aria-pressed={tagFilter === "untagged"}
          onClick={() => setTagFilter("untagged")}
          className={`${CHIP} ${tagFilter === "untagged" ? CHIP_ON : CHIP_OFF}`}
        >
          {t("To sort")} <span className="tabular-nums opacity-70">{counts.untagged}</span>
        </button>
        {sortTags(tags)
          .filter((tag) => counts.byTag.has(tag.id) || tagFilter === tag.id)
          .map((tag) => (
            <button
              key={tag.id}
              type="button"
              aria-pressed={tagFilter === tag.id}
              onClick={() => setTagFilter(tag.id)}
              className={`${CHIP} ${tagFilter === tag.id ? CHIP_ON : CHIP_OFF}`}
            >
              <Tag aria-hidden className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{tag.name}</span>
              <span className="tabular-nums opacity-70">{counts.byTag.get(tag.id) ?? 0}</span>
            </button>
          ))}
      </div>

      {currentTag && (onRenameTag || onDeleteTag) && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/50">
          {renaming !== null ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!renaming.trim() || !onRenameTag) return;
                void onRenameTag(currentTag, renaming.trim()).then(() => setRenaming(null));
              }}
            >
              <TextInput
                autoFocus
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
                aria-label={t("Tag name")}
                className="!w-56"
              />
              <Button type="submit" variant="primary">
                {t("Save")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                {t("Cancel")}
              </Button>
            </form>
          ) : (
            <>
              <span className="font-semibold text-slate-800 dark:text-slate-100">{currentTag.name}</span>
              {onRenameTag && (
                <Button
                  variant="ghost"
                  aria-label={t("Rename tag")}
                  title={t("Rename tag")}
                  onClick={() => setRenaming(currentTag.name)}
                >
                  <Pencil aria-hidden className="h-4 w-4" />
                </Button>
              )}
            </>
          )}
          {onDeleteTag && (
            <Button
              variant="danger"
              className="ml-auto inline-flex items-center gap-1.5"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 aria-hidden className="h-4 w-4" />
              {t("Delete tag")}
            </Button>
          )}
          {confirmDelete && onDeleteTag && (
            <ConfirmDialog
              message={t("Delete tag {{tag}}? The questions stay in the library.", {
                tag: currentTag.name,
              })}
              onConfirm={() => {
                setConfirmDelete(false);
                void onDeleteTag(currentTag).then(() => setTagFilter("all"));
              }}
              onCancel={() => setConfirmDelete(false)}
            />
          )}
        </div>
      )}

      {toolbar?.(visible)}

      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          {usable.length === 0
            ? t("The library is empty. Questions you write in your rooms land here.")
            : t("No question matches.")}
        </p>
      ) : (
        <ul className="grid gap-3">
          {visible.map((entry) => (
            <li key={entry.id}>{renderEntry(entry)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Question text and answers, math rendered. */
export function EntryContent({ entry, compact = false }: { entry: LibraryEntry; compact?: boolean }) {
  const { t } = useTranslation();
  const html = localizedText(entry.text);
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {t(KIND_LABEL_KEYS[entry.kind] ?? entry.kind)}
      </p>
      <div className={`text-slate-800 dark:text-slate-100 ${compact ? "line-clamp-3" : ""}`}>
        {stripHtml(html) || html.includes("<img") ? (
          <RichText html={mathHtml(html)} />
        ) : (
          <p className="italic text-slate-400">{t("No question text")}</p>
        )}
      </div>
      {!compact && entry.options.length > 0 && (
        <ul className="mt-2 grid gap-1 text-sm">
          {entry.options.map((option, index) => (
            <li key={index} className="flex items-start gap-2">
              {option.is_correct ? (
                <Check aria-label={t("Correct")} className="mt-0.5 h-4 w-4 shrink-0 text-brand-700" />
              ) : (
                <X aria-label={t("Wrong")} className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
              )}
              <span className="text-slate-700 dark:text-slate-300">
                <MathText text={localizedText(option.text)} />
                {option.justification && (
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    <MathText text={option.justification} />
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Used in: Week 1 – Quiz 1 (HS26 …), …" with links. */
export function UsedIn({ entry }: { entry: LibraryEntry }) {
  const { t } = useTranslation();
  if (!entry.used_in.length)
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {t("Kept only in the library (its sets were deleted).")}
      </p>
    );
  return (
    <p className="text-xs text-slate-500 dark:text-slate-400">
      {t("Used in")}:{" "}
      {entry.used_in.map((use, index) => (
        <span key={use.question}>
          {index > 0 && " · "}
          <Link to={`/sets/${use.set}`} className="underline-offset-2 hover:underline">
            {localizedText(use.set_title)}
          </Link>{" "}
          <span className="opacity-70">({localizedText(use.room_title)})</span>
        </span>
      ))}
    </p>
  );
}
