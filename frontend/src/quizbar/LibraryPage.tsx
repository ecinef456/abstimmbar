// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): the question library page (/library) and the dialogs to
 *  copy library questions into a set. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { CopyPlus, FileDown, Library, Loader2, Pencil, Trash2, Upload } from "lucide-react";
import { localizedText } from "@basicbar/ui";
import {
  api,
  quizbar,
  requestDetail,
  type LibraryEntry,
  type LibraryTag,
  type QuestionSet,
  type Room,
} from "../api";
import { Button, ConfirmDialog, Field, Select } from "../components/ui";
import HomeCrumb from "../components/HomeCrumb";
import { EntryContent, EntryStats, LibraryBrowser, TagInput, UsedIn } from "./Library";
import Modal from "./Modal";
import ExportDialog from "./ExportDialog";
import TagsPanel from "./TagsPanel";

type LibraryData = { entries: LibraryEntry[]; tags: LibraryTag[] };

/** Choose a room and a set, then copy the given entries to its end. */
export function InsertIntoSetDialog({
  entryIds,
  onClose,
  onDone,
}: {
  entryIds: number[];
  onClose: () => void;
  onDone: (message: string, setId: number) => void;
}) {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [sets, setSets] = useState<QuestionSet[]>([]);
  const [setId, setSetId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all([api.listRooms(), api.listArchivedRooms()]).then(([active, archived]) => {
      const all = [...active.results, ...archived.results].sort((a, b) =>
        localizedText(a.title).localeCompare(localizedText(b.title), undefined, { numeric: true }),
      );
      setRooms(all);
    });
  }, []);
  useEffect(() => {
    setSets([]);
    setSetId(null);
    if (roomId === null) return;
    void api.listQuestionSets(roomId).then((page) =>
      setSets(
        [...page.results].sort((a, b) =>
          localizedText(a.title).localeCompare(localizedText(b.title), undefined, { numeric: true }),
        ),
      ),
    );
  }, [roomId]);

  async function insert() {
    if (setId === null) return;
    setBusy(true);
    setError("");
    try {
      const result = await quizbar.insertFromLibrary(setId, entryIds);
      const target = sets.find((s) => s.id === setId);
      let message = t("{{count}} questions copied into “{{set}}”.", {
        count: result.inserted.length,
        set: target ? localizedText(target.title) : "",
      });
      if (result.skipped.length)
        message +=
          " " +
          t("{{count}} skipped: this type of set cannot hold them.", { count: result.skipped.length });
      onDone(message, setId);
    } catch {
      setError(t("Could not copy the questions."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("Copy into a question set")} onClose={onClose}>
      <div className="grid gap-3">
        <Field label={t("Room")}>
          <Select
            value={roomId ?? ""}
            disabled={rooms === null}
            onChange={(event) => setRoomId(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">{rooms === null ? t("Loading …") : t("Choose a room")}</option>
            {rooms?.map((room) => (
              <option key={room.id} value={room.id}>
                {localizedText(room.title)}
                {room.is_archived ? ` (${t("archived")})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("Question set")}>
          <Select
            value={setId ?? ""}
            disabled={roomId === null}
            onChange={(event) => setSetId(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">{t("Choose a question set")}</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {localizedText(s.title)}
              </option>
            ))}
          </Select>
        </Field>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" disabled={setId === null || busy} onClick={() => void insert()}>
            {t("Copy {{count}} questions", { count: entryIds.length })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Set page: pick library questions and copy them to the end of this set. */
export function LibraryPickerDialog({
  setId,
  allowedKinds,
  onClose,
  onInserted,
  onFromRoom,
}: {
  setId: number;
  allowedKinds: string[];
  onClose: () => void;
  onInserted: (message: string) => void;
  /** Switch to copying from another room's set instead. */
  onFromRoom?: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<LibraryData | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void quizbar.library().then(setData);
  }, []);

  async function insert() {
    setBusy(true);
    try {
      const result = await quizbar.insertFromLibrary(setId, chosen);
      onInserted(t("{{count}} questions copied from the library.", { count: result.inserted.length }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t("Copy questions from the library")} onClose={onClose} wide>
      {onFromRoom && <SourceSwitch active="library" onRoom={onFromRoom} />}
      {data === null ? (
        <p className="text-sm text-slate-500">{t("Loading …")}</p>
      ) : (
        <LibraryBrowser
          entries={data.entries}
          tags={data.tags}
          allowedKinds={allowedKinds}
          renderEntry={(entry) => {
            const checked = chosen.includes(entry.id);
            return (
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                  checked
                    ? "border-brand-600 bg-brand-50/60 dark:bg-brand-950/30"
                    : "border-slate-200 dark:border-slate-800"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    setChosen((current) =>
                      event.target.checked ? [...current, entry.id] : current.filter((id) => id !== entry.id),
                    )
                  }
                  className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 accent-brand-600"
                />
                <div className="min-w-0 flex-1">
                  <EntryContent entry={entry} compact />
                  {entry.tags.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1">
                      {entry.tags.map((tag) => (
                        <span
                          key={tag.id}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        >
                          {tag.name}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              </label>
            );
          }}
        />
      )}
      <div className="sticky bottom-0 mt-4 flex justify-end gap-2 bg-white py-2 dark:bg-slate-900">
        <Button variant="ghost" onClick={onClose}>
          {t("Cancel")}
        </Button>
        <Button variant="primary" disabled={!chosen.length || busy} onClick={() => void insert()}>
          {t("Copy {{count}} questions", { count: chosen.length })}
        </Button>
      </div>
    </Modal>
  );
}

/** "From a room | From the library" at the top of both copy dialogs. */
export function SourceSwitch({
  active,
  onRoom,
  onLibrary,
}: {
  active: "room" | "library";
  onRoom?: () => void;
  onLibrary?: () => void;
}) {
  const { t } = useTranslation();
  const tab = (on: boolean) =>
    `rounded-md px-3 py-1 text-sm ${
      on
        ? "bg-white font-semibold text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
        : "text-slate-600 hover:text-slate-900 dark:text-slate-300"
    }`;
  return (
    <div role="tablist" className="mb-4 inline-flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      <button type="button" role="tab" aria-selected={active === "room"} className={tab(active === "room")} onClick={onRoom}>
        {t("From a room")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "library"}
        className={tab(active === "library")}
        onClick={onLibrary}
      >
        {t("From the library")}
      </button>
    </div>
  );
}

/** A card's question and answers, cut at a fixed height (so a long question
 *  does not stretch its whole row), with "Show all" when cut. */
function ClampedContent({ entry }: { entry: LibraryEntry }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    // Math and images change the height after the first paint.
    const observer = new ResizeObserver(measure);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [entry, open]);
  return (
    <div className="min-w-0 flex-1">
      <div ref={box} className={`relative ${open ? "" : "max-h-72 overflow-hidden"}`}>
        <EntryContent entry={entry} />
        {cut && !open && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white dark:from-slate-950" />
        )}
      </div>
      {(cut || open) && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          {open ? t("Show less") : t("Show all")}
        </button>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  selected,
  onSelect,
  suggestions,
  onTags,
  onInsert,
  onRemove,
}: {
  entry: LibraryEntry;
  selected: boolean;
  onSelect: (value: boolean) => void;
  suggestions: string[];
  onTags: (names: string[]) => void;
  onInsert: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article
      className={`flex h-full flex-col gap-3 rounded-2xl border p-4 ${
        selected
          ? "border-brand-600 bg-brand-50/40 dark:bg-brand-950/20"
          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
      }`}
    >
      <div className="-my-1 flex items-center gap-1">
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelect(event.target.checked)}
          aria-label={t("Select")}
          className="h-4 w-4 shrink-0 rounded border-slate-300 accent-brand-600"
        />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {entry.master_set !== null && (
            <Link
              to={`/sets/${entry.master_set}/questions/${entry.master}`}
              aria-label={t("Edit")}
              title={t("Edit")}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            >
              <Pencil aria-hidden className="h-4 w-4" />
            </Link>
          )}
          <Button
            variant="ghost"
            aria-label={t("Copy into a question set")}
            title={t("Copy into a question set")}
            onClick={onInsert}
          >
            <CopyPlus aria-hidden className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            aria-label={t("Remove from the library")}
            title={t("Remove from the library")}
            onClick={onRemove}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <ClampedContent entry={entry} />
      <div className="grid gap-2">
        <TagInput
          idPrefix={`qb-entry-${entry.id}`}
          tags={entry.tags.map((tag) => tag.name)}
          onChange={onTags}
          suggestions={suggestions}
        />
        <EntryStats entry={entry} />
        <UsedIn entry={entry} />
      </div>
    </article>
  );
}

export default function LibraryPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<LibraryData | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [insertIds, setInsertIds] = useState<number[] | null>(null);
  const [onlySelected, setOnlySelected] = useState(false);
  // "Questions" or "Tags" tab; a tag picked on the Tags tab becomes the search.
  const [tab, setTab] = useState<"questions" | "tags">("questions");
  const [preset, setPreset] = useState({ query: "", key: 0 });
  const [exporting, setExporting] = useState<{ entries: number[]; label: string } | null>(null);
  const [removing, setRemoving] = useState<LibraryEntry | null>(null);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ text: string; setId?: number } | null>(null);
  // Bulk import of Typst quizzes (a .zip) straight into the library.
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] = useState<{ text: string; warnings: string[]; error?: boolean } | null>(
    null,
  );
  async function importFiles(files: File[]) {
    setImporting(true);
    setImportReport(null);
    try {
      const result = await quizbar.importLibrary(files);
      setImportReport({
        text: t("Imported into the library: {{quizzes}} quiz(zes), {{questions}} new question(s). Already there (tags added): {{skipped}}.", {
          questions: result.questions,
          quizzes: result.quizzes,
          skipped: result.skipped,
        }),
        warnings: result.warnings,
      });
      await reload();
    } catch (err) {
      const detail = requestDetail(err);
      setImportReport({ text: detail ? t(detail) : t("The import failed."), warnings: [], error: true });
    } finally {
      setImporting(false);
    }
  }

  const reload = () => quizbar.library().then(setData);
  useEffect(() => {
    void reload();
  }, []);

  if (data === null) return <p className="text-sm text-slate-500">{t("Loading …")}</p>;
  const suggestions = data.tags.map((tag) => tag.name);
  const select = (id: number, on: boolean) =>
    setSelected((current) => (on ? [...current, id] : current.filter((x) => x !== id)));

  return (
    <div>
      <nav className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        <HomeCrumb /> / {t("Question library")}
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex flex-1 items-center gap-2 text-2xl font-bold">
          <Library aria-hidden className="h-6 w-6" />
          {t("Question library")}
        </h1>
        <Button
          className="inline-flex items-center gap-1.5"
          disabled={importing}
          onClick={() => importInput.current?.click()}
          title={t("A .zip with your .typ quizzes (name.en.typ, name.de.typ, name.fr.typ) and their figures")}
        >
          {importing ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Upload aria-hidden className="h-4 w-4" />}
          {importing ? t("Importing …") : t("Import Typst quizzes (.zip)")}
        </Button>
        <input
          ref={importInput}
          type="file"
          multiple
          accept=".zip,.typ,image/png,image/jpeg,image/webp,image/gif"
          aria-label={t("Import Typst quizzes (.zip)")}
          tabIndex={-1}
          className="sr-only"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length) void importFiles(files);
            event.target.value = "";
          }}
        />
      </div>
      {importReport && (
        <div
          role="status"
          className={`mt-3 rounded-xl px-4 py-2 text-sm ${
            importReport.error
              ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200"
              : "bg-brand-50 text-brand-900 dark:bg-brand-950/40 dark:text-brand-100"
          }`}
        >
          <p>{importReport.text}</p>
          {importReport.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-amber-800 dark:text-amber-200">
              {importReport.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="mb-6 mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
        {t(
          "Every question you write in your rooms lands here once, however often it is copied. Tag it to find it again; untagged ones wait under “To sort”.",
        )}
      </p>
      <p className="-mt-4 mb-6 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
        {t("Writing quizzes in Typst? Download")}{" "}
        <a href="/quizbar/quizbar.typ" download className="font-medium text-brand-800 underline dark:text-brand-200">
          quizbar.typ
        </a>
        {", "}
        <a href="/quizbar/example.typ" download className="font-medium text-brand-800 underline dark:text-brand-200">
          example.typ
        </a>{" "}
        {t("and its figure")}{" "}
        <a href="/quizbar/figures/wave.png" download className="font-medium text-brand-800 underline dark:text-brand-200">
          wave.png
        </a>
        {" — "}
        {t("then import the quiz in a room: ⋮ → Import Typst quiz.")}{" "}
        {t("Many quizzes at once, straight into the library: Import Typst quizzes (.zip) — each question is tagged with its file name.")}
      </p>
      {notice && (
        <p
          role="status"
          className="mb-4 rounded-xl bg-brand-50 px-4 py-2 text-sm text-brand-900 dark:bg-brand-950/40 dark:text-brand-100"
        >
          {notice.text}{" "}
          {notice.setId && (
            <Link to={`/sets/${notice.setId}`} className="font-semibold underline">
              {t("Open the set")}
            </Link>
          )}
        </p>
      )}
      {/* quizbar (fork): the questions, or all tags with search and replace. */}
      <div role="tablist" className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {(["questions", "tags"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === name
                ? "border-brand-600 text-brand-800 dark:text-brand-200"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            {name === "questions" ? t("Questions") : t("Tags")}
            <span className="ml-1.5 text-xs font-normal text-slate-400">
              {name === "questions" ? data.entries.length : data.tags.length}
            </span>
          </button>
        ))}
      </div>
      {tab === "tags" ? (
        <TagsPanel
          tags={data.tags}
          onChanged={reload}
          onPick={(name) => {
            setPreset((current) => ({ query: name, key: current.key + 1 }));
            setOnlySelected(false);
            setTab("questions");
          }}
        />
      ) : (
        <LibraryBrowser
          key={preset.key}
          initialQuery={preset.query}
          columns
          only={onlySelected && selected.length ? selected : undefined}
          entries={data.entries}
          tags={data.tags}
          onRenameTag={async (tag, name) => {
            await quizbar.renameTag(tag.id, name);
            await reload();
          }}
          onDeleteTag={async (tag) => {
            await quizbar.deleteTag(tag.id);
            await reload();
          }}
          toolbar={(visible, filter) => {
            const visibleIds = visible.map((entry) => entry.id);
            // PDF export: the selection if there is one, else what is shown.
            const exportable = (selected.length ? data.entries.filter((e) => selected.includes(e.id)) : visible).filter(
              (entry) => entry.kind === "single_choice" || entry.kind === "multiple_choice",
            );
            const allChosen = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));
            return (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-800">
                <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={allChosen}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? Array.from(new Set([...current, ...visibleIds]))
                          : current.filter((id) => !visibleIds.includes(id)),
                      )
                    }
                    className="h-4 w-4 rounded border-slate-300 accent-brand-600"
                  />
                  {selected.length
                    ? t("{{count}} selected", { count: selected.length })
                    : t("Select all {{count}} found", { count: visible.length })}
                </label>
                {selected.length > 0 && (
                  <Button
                    variant={onlySelected ? "primary" : "secondary"}
                    aria-pressed={onlySelected}
                    onClick={() => setOnlySelected(!onlySelected)}
                  >
                    {onlySelected ? t("Show all again") : t("Show only the selected")}
                  </Button>
                )}
                {selected.length > 0 && (
                  <>
                    <div className="w-64">
                      <TagInput
                        idPrefix="qb-bulk"
                        tags={bulkTags}
                        onChange={setBulkTags}
                        suggestions={suggestions}
                        placeholder={t("Tags to add …")}
                      />
                    </div>
                    <Button
                      disabled={!bulkTags.length}
                      onClick={() =>
                        void quizbar.bulkTags(selected, bulkTags).then(() => {
                          setBulkTags([]);
                          return reload();
                        })
                      }
                    >
                      {t("Add tags")}
                    </Button>
                    <Button onClick={() => setInsertIds(selected)}>{t("Copy into a question set")}</Button>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setSelected([]);
                        setOnlySelected(false);
                      }}
                    >
                      {t("Clear selection")}
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  className="ml-auto inline-flex items-center gap-1.5"
                  disabled={!exportable.length}
                  title={t("Single- and multiple-choice questions only.")}
                  onClick={() =>
                    setExporting({
                      entries: exportable.map((entry) => entry.id),
                      label: selected.length ? "" : filter,
                    })
                  }
                >
                  <FileDown aria-hidden className="h-4 w-4" />
                  {selected.length ? t("Export selection as PDF") : t("Export shown as PDF")}
                </Button>
              </div>
            );
          }}
          renderEntry={(entry) => (
            <EntryCard
              entry={entry}
              selected={selected.includes(entry.id)}
              onSelect={(on) => select(entry.id, on)}
              suggestions={suggestions}
              onTags={(names) => {
                // Optimistic: show the new chips at once, then reload ids.
                setData((current) =>
                  current && {
                    ...current,
                    entries: current.entries.map((e) =>
                      e.id === entry.id ? { ...e, tags: names.map((name, i) => ({ id: -1 - i, name })) } : e,
                    ),
                  },
                );
                void quizbar.setEntryTags(entry.id, names).then(reload);
              }}
              onInsert={() => setInsertIds([entry.id])}
              onRemove={() => setRemoving(entry)}
            />
          )}
        />
      )}
      {exporting && (
        <ExportDialog
          title={exporting.label ? `${t("Question library")} · ${exporting.label}` : t("Question library")}
          target={{ scope: "library", entries: exporting.entries, label: exporting.label }}
          count={exporting.entries.length}
          onClose={() => setExporting(null)}
        />
      )}
      {insertIds && (
        <InsertIntoSetDialog
          entryIds={insertIds}
          onClose={() => setInsertIds(null)}
          onDone={(text, setId) => {
            setInsertIds(null);
            setSelected([]);
            setNotice({ text, setId });
            void reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          message={t(
            "Remove this question from the library? Its copies in your sets stay where they are.",
          )}
          confirmLabel={t("Remove")}
          onConfirm={() => {
            const id = removing.id;
            setRemoving(null);
            setSelected((current) => current.filter((x) => x !== id));
            void quizbar.removeEntry(id).then(reload);
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
