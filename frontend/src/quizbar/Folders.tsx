// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): folders of question sets inside a room.
 *
 *  FolderBar — pick "All", a folder or "Not in a folder"; create, rename,
 *  number (ordered) or delete folders. MoveToFolder — the per-set action.
 *  The room page keeps the set grid; these only drive which sets it shows. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Folder, FolderInput, FolderPlus, ListOrdered, Pencil, Trash2 } from "lucide-react";
import type { SetFolder } from "../api";
import { Button, ConfirmDialog, TextInput, ToggleSwitch } from "../components/ui";

/** "all" = every set, "none" = sets not in any folder, or a folder id. */
export type FolderSelection = "all" | "none" | number;

export function parseFolderSelection(value: string | null): FolderSelection {
  if (value === "none") return "none";
  const id = Number(value);
  return value && Number.isInteger(id) && id > 0 ? id : "all";
}

/** Folders sorted by name, numbers naturally (Woche 2 before Woche 10). */
export function sortFolders(folders: SetFolder[]): SetFolder[] {
  return [...folders].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }),
  );
}

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600";
const CHIP_ON =
  "border-brand-600 bg-brand-50 font-semibold text-brand-800 dark:bg-brand-950/40 dark:text-brand-200";
const CHIP_OFF =
  "border-slate-300 text-slate-600 hover:border-brand-500 hover:text-brand-700 dark:border-slate-700 dark:text-slate-300";

export function FolderBar({
  folders,
  setIds,
  selected,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
}: {
  folders: SetFolder[];
  /** Ids of all sets in the room (to count the ones not in a folder). */
  setIds: number[];
  selected: FolderSelection;
  onSelect: (selection: FolderSelection) => void;
  onCreate: (title: string, ordered: boolean) => Promise<void>;
  onUpdate: (id: number, patch: { title?: string; ordered?: boolean }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newOrdered, setNewOrdered] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const filed = new Set(folders.flatMap((f) => f.sets));
  const unfiledCount = setIds.filter((id) => !filed.has(id)).length;
  const current = typeof selected === "number" ? folders.find((f) => f.id === selected) : undefined;

  useEffect(() => {
    setRenaming(false);
    setConfirmDelete(false);
  }, [selected]);

  async function create() {
    if (!newTitle.trim()) return;
    await onCreate(newTitle.trim(), newOrdered);
    setCreating(false);
    setNewTitle("");
    setNewOrdered(true);
  }

  return (
    <section aria-label={t("Folders")} className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={selected === "all"}
          onClick={() => onSelect("all")}
          className={`${CHIP} ${selected === "all" ? CHIP_ON : CHIP_OFF}`}
        >
          {t("All sets")} <span className="tabular-nums opacity-70">{setIds.length}</span>
        </button>
        {sortFolders(folders).map((folder) => (
          <button
            key={folder.id}
            type="button"
            aria-pressed={selected === folder.id}
            onClick={() => onSelect(folder.id)}
            className={`${CHIP} ${selected === folder.id ? CHIP_ON : CHIP_OFF}`}
          >
            {folder.ordered ? (
              <ListOrdered aria-hidden className="h-4 w-4 shrink-0" />
            ) : (
              <Folder aria-hidden className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{folder.title}</span>
            <span className="tabular-nums opacity-70">{folder.sets.length}</span>
          </button>
        ))}
        {folders.length > 0 && (
          <button
            type="button"
            aria-pressed={selected === "none"}
            onClick={() => onSelect("none")}
            className={`${CHIP} ${selected === "none" ? CHIP_ON : CHIP_OFF}`}
          >
            {t("Not in a folder")} <span className="tabular-nums opacity-70">{unfiledCount}</span>
          </button>
        )}
        {!creating && (
          <Button variant="ghost" onClick={() => setCreating(true)} className="inline-flex items-center gap-1.5">
            <FolderPlus aria-hidden className="h-4 w-4" />
            {t("New folder")}
          </Button>
        )}
      </div>

      {creating && (
        <form
          className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-3 dark:border-slate-800"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <TextInput
            autoFocus
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder={t("e.g. Week 5")}
            aria-label={t("Folder name")}
            className="!w-56"
          />
          <ToggleSwitch checked={newOrdered} onChange={setNewOrdered} label={t("Numbered order")} />
          <Button type="submit" variant="primary" disabled={!newTitle.trim()}>
            {t("Create")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
            {t("Cancel")}
          </Button>
        </form>
      )}

      {current && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/50">
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!renameTitle.trim()) return;
                void onUpdate(current.id, { title: renameTitle.trim() }).then(() => setRenaming(false));
              }}
            >
              <TextInput
                autoFocus
                value={renameTitle}
                onChange={(event) => setRenameTitle(event.target.value)}
                aria-label={t("Folder name")}
                className="!w-56"
              />
              <Button type="submit" variant="primary">
                {t("Save")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                {t("Cancel")}
              </Button>
            </form>
          ) : (
            <>
              <span className="font-semibold text-slate-800 dark:text-slate-100">{current.title}</span>
              <Button
                variant="ghost"
                aria-label={t("Rename folder")}
                title={t("Rename folder")}
                onClick={() => {
                  setRenameTitle(current.title);
                  setRenaming(true);
                }}
              >
                <Pencil aria-hidden className="h-4 w-4" />
              </Button>
            </>
          )}
          <ToggleSwitch
            checked={current.ordered}
            onChange={(ordered) => void onUpdate(current.id, { ordered })}
            label={t("Numbered order")}
          />
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {current.ordered
              ? t("Sets keep a fixed order; “Next quiz” follows it.")
              : t("Sets are listed with the normal sort.")}
          </span>
          <Button
            variant="danger"
            className="ml-auto inline-flex items-center gap-1.5"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 aria-hidden className="h-4 w-4" />
            {t("Delete folder")}
          </Button>
        </div>
      )}
      {current && confirmDelete && (
        <ConfirmDialog
          message={t("Delete folder {{title}}? The question sets stay in the room.", {
            title: current.title,
          })}
          onConfirm={() => {
            setConfirmDelete(false);
            void onDelete(current.id);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </section>
  );
}

/** Per-set action: move the set into a folder (at its end) or out of all. */
export function MoveToFolder({
  folders,
  currentFolder,
  onMove,
}: {
  folders: SetFolder[];
  currentFolder: number | null;
  onMove: (folder: number | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (folders.length === 0) return null;
  const options: { id: number | null; label: string }[] = [
    ...sortFolders(folders).map((f) => ({ id: f.id, label: f.title })),
    { id: null, label: t("Not in a folder") },
  ];
  return (
    <div className="relative" ref={ref}>
      <Button
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("Move to folder")}
        title={t("Move to folder")}
        className="inline-flex items-center"
        onClick={() => setOpen((v) => !v)}
      >
        <FolderInput aria-hidden className="h-4 w-4" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {options.map((option) => (
            <button
              key={option.id ?? "none"}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === currentFolder}
              onClick={() => {
                setOpen(false);
                if (option.id !== currentFolder) onMove(option.id);
              }}
              className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span className="truncate">{option.label}</span>
              {option.id === currentFolder && <Check aria-hidden className="h-4 w-4 text-brand-700" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
