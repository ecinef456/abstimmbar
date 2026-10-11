// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Archive, ChartColumnDecreasing, ChevronDown, Crown, DoorOpen, Heart, Layers, Play, Search, SearchX, Settings, Trash2, Upload, Users, X } from "lucide-react";
import { useEasyMode } from "../App";
import {
  api,
  results,
  type Collaborator,
  type PresentationCorner,
  type QuestionSet,
  type Room,
  type RoomOwner,
} from "../api";
import { Pager } from "../components/Pager";
import {
  Button,
  ConfirmDialog,
  ConfirmInline,
  EmptyState,
  Field,
  InfoHint,
  MenuItem,
  MoreMenu,
  SegmentedControl,
  Select,
  TextInput,
} from "../components/ui";
import HomeCrumb from "../components/HomeCrumb";
import TranslatableField from "../components/TranslatableField";
import { localizedText, type LocalizedText, RichText, TranslationControlsSlot } from "@basicbar/ui";
import { SetSettingsForm, type SetSettings } from "./SetPage";
import { CREATABLE_SET_TYPES, SET_TYPES, type SetType } from "../setTypes";

/** #75: pick the set type up front — like "+ New question" for questions.
 * The menu lists the creatable types; picking one opens the create form with
 * that type preset. In easy mode only Live poll is creatable, so there's
 * nothing to pick and it collapses to a plain button. */
function NewSetMenu({
  easyMode,
  onPick,
}: {
  easyMode: boolean;
  onPick: (type: SetType) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const types = easyMode
    ? CREATABLE_SET_TYPES.filter((st) => st === "live_poll")
    : CREATABLE_SET_TYPES;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Only one creatable type: no menu to choose from — a plain button.
  if (types.length < 2) {
    const only = types[0] ?? "live_poll";
    return (
      <Button variant="primary" onClick={() => onPick(only)}>
        + {t("New question set")}
      </Button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="primary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2"
      >
        <span className="text-base leading-none">+</span>
        {t("New question set")}
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg shadow-slate-900/5 dark:border-slate-700 dark:bg-slate-900"
        >
          {types.map((st) => {
            const Icon = SET_TYPES[st].icon;
            return (
              <button
                key={st}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPick(st);
                }}
                className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {t(SET_TYPES[st].label)}
                  </span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {t(SET_TYPES[st].description)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const NEW_SET_DEFAULTS: SetSettings = {
  type: "live_poll",
  title: "",
  description: "",
  reveal_answers: "immediately",
  open_on_show: true,
  quiz_time_limit: null,
  show_results_to_participants: true,
  present_results_after: true,
  allow_back_navigation: true,
  shuffle_questions: false,
  reveal_only_in_summary: false,
};

type SortKey = "updated" | "created" | "title" | "questions";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Last edited" },
  { value: "created", label: "Last created" },
  { value: "title", label: "A–Z" },
  { value: "questions", label: "Most questions" },
];

function sortSets(list: QuestionSet[], key: SortKey): QuestionSet[] {
  return [...list].sort((a, b) => {
    if (key === "title") {
      return localizedText(a.title).localeCompare(localizedText(b.title), "de");
    }
    if (key === "created") return b.created_at.localeCompare(a.created_at);
    if (key === "questions") return b.question_count - a.question_count;
    return b.updated_at.localeCompare(a.updated_at); // "updated"
  });
}

function fieldError(err: unknown): string {
  try {
    const data = JSON.parse((err as Error).message);
    const value = data.detail ?? Object.values(data)[0];
    return Array.isArray(value) ? value[0] : String(value);
  } catch {
    return String(err);
  }
}

/** Room identity + features, edited when creating a room (RoomsPage) and
 * behind the ⋮ „Einstellungen" here (#2). Controlled: the parent owns the
 * draft and the Save/Cancel. */
export interface RoomSettings {
  title: LocalizedText;
  description: LocalizedText;
  show_logo_in_presentation: boolean;
  show_qr_in_presentation: boolean;
  show_code_in_presentation: boolean;
  presentation_corner: PresentationCorner;
  closing_info: LocalizedText;
}

export const NEW_ROOM_DEFAULTS: RoomSettings = {
  title: "",
  description: "",
  show_logo_in_presentation: true,
  show_qr_in_presentation: false,
  show_code_in_presentation: false,
  presentation_corner: "bottom-right",
  closing_info: "",
};

const CORNER_OPTIONS: { value: PresentationCorner; label: string }[] = [
  { value: "top-left", label: "top left" },
  { value: "top-right", label: "top right" },
  { value: "bottom-left", label: "bottom left" },
  { value: "bottom-right", label: "bottom right" },
];

export function RoomSettingsForm({
  draft,
  onChange,
  titlePlaceholder,
  titleAnchor,
  easyMode = false,
}: {
  draft: RoomSettings;
  onChange: (patch: Partial<RoomSettings>) => void;
  titlePlaceholder?: string;
  /** Optional `data-tour` value wrapped around the Name field (guided tour):
   *  only the new-room create form sets it, so the anchor is scoped to that. */
  titleAnchor?: string;
  /** Easy mode (#52): only title + description; hide presentation features
   * and the participant closing info. Existing values stay stored. */
  easyMode?: boolean;
}) {
  const { t } = useTranslation();
  const titleField = (
    <TranslatableField
      label={t("Name")}
      value={draft.title}
      onChange={(title) => onChange({ title })}
      placeholder={titlePlaceholder ?? t("Room title")}
    />
  );
  return (
    <div className="grid max-w-2xl gap-8">
      {/* Phones: the translation controls dock here instead of floating. */}
      <TranslationControlsSlot />
      {titleAnchor ? <div data-tour={titleAnchor}>{titleField}</div> : titleField}
      <TranslatableField
        variant="rich"
        label={t("Description")}
        value={draft.description}
        onChange={(description) => onChange({ description })}
      />
      {!easyMode && (
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-300">
          {t("Room features")}
        </legend>
        <div className="grid gap-2">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.show_logo_in_presentation}
              onChange={(event) =>
                onChange({ show_logo_in_presentation: event.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
            />
            {t("Show logo in presentation mode")}
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.show_qr_in_presentation}
              onChange={(event) =>
                onChange({ show_qr_in_presentation: event.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
            />
            {t("Always show QR code")}
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={draft.show_code_in_presentation}
              onChange={(event) =>
                onChange({ show_code_in_presentation: event.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 accent-brand-600"
            />
            {t("Always show room code")}
          </label>
          {(draft.show_qr_in_presentation || draft.show_code_in_presentation) && (
            <div className="ml-6">
              <Field label={t("Corner:")}>
                <Select
                  value={draft.presentation_corner}
                  onChange={(event) =>
                    onChange({
                      presentation_corner: event.target.value as PresentationCorner,
                    })
                  }
                >
                  {CORNER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        </div>
      </fieldset>
      )}

      {/* Info shown to participants after a vote ends (#24). */}
      {!easyMode && (
      <TranslatableField
        variant="rich"
        label={t("Closing info for participants")}
        value={draft.closing_info}
        onChange={(closing_info) => onChange({ closing_info })}
        placeholder={t(
          "Shown after a vote ends — e.g. further links, literature, contact. Appears below the site-wide info.",
        )}
      />
      )}
    </div>
  );
}

/** Shared editing (v2): every owner has full rights on the room. Rendered as
 * an expandable panel; the trigger lives in the room's ⋮ menu. */
function OwnersPanel({ roomId }: { roomId: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [owners, setOwners] = useState<RoomOwner[]>([]);
  // Known collaborators (#55): people I already share a room with, offered as
  // quick re-add suggestions so I don't have to retype an e-mail.
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api.listRoomOwners(roomId).then((data) => setOwners(data.owners));
    void api
      .listCollaborators()
      .then((data) => setCollaborators(data.collaborators))
      .catch(() => setCollaborators([]));
  }, [roomId]);

  async function addOwner(user: string) {
    const trimmed = user.trim();
    if (!trimmed) return;
    setError("");
    try {
      const data = await api.addRoomOwner(roomId, trimmed);
      setOwners(data.owners);
      setValue("");
    } catch (err) {
      setError(fieldError(err));
    }
  }

  async function handleAdd() {
    await addOwner(value);
  }

  async function handleRemove(owner: RoomOwner) {
    setError("");
    try {
      const data = await api.removeRoomOwner(roomId, owner.id);
      if (owner.is_self) {
        navigate("/"); // left the room — it disappears from "Meine Räume"
        return;
      }
      setOwners(data.owners);
    } catch (err) {
      setError(fieldError(err));
    }
  }

  async function handleTransfer(owner: RoomOwner) {
    setError("");
    try {
      const data = await api.transferRoomOwner(roomId, owner.id);
      setOwners(data.owners);
    } catch (err) {
      setError(fieldError(err));
    }
  }

  const iAmOwner = owners.some((o) => o.is_self && o.is_owner);
  // Suggest only known collaborators who aren't already on this room; chips
  // show a handful (most-frequent first, server-ordered), the datalist all.
  const ownerIds = new Set(owners.map((owner) => owner.id));
  const suggestions = collaborators.filter((person) => !ownerIds.has(person.id));
  const listId = `known-collaborators-${roomId}`;

  return (
    <div className="mb-6 grid max-w-xl gap-3 rounded-2xl border border-slate-200 p-4 text-sm dark:border-slate-800">
      <p className="font-medium text-slate-700 dark:text-slate-200"><Users aria-hidden className="inline h-4 w-4" /> {t("Collaborative editing")}</p>
      <ul className="flex flex-wrap gap-2">
        {owners.map((owner) => (
          <li
            key={owner.id}
            className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 py-1 pl-3 pr-1.5 dark:bg-slate-800"
          >
            <span>
              {owner.name}
              {owner.is_self && <span className="text-slate-400"> {t("(you)")}</span>}
            </span>
            {owner.is_owner && (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-950 dark:text-brand-200">
                <Crown aria-hidden className="h-3 w-3" /> {t("Owner")}
              </span>
            )}
            {/* The owner may hand the room over to any co-owner (#26). */}
            {iAmOwner && !owner.is_owner && (
              <button
                type="button"
                aria-label={t("Make {{name}} owner", { name: owner.name })}
                title={t("Make owner")}
                onClick={() => void handleTransfer(owner)}
                className="rounded-full px-1.5 text-slate-400 hover:bg-slate-200 hover:text-brand-700 dark:hover:bg-slate-700 dark:hover:text-brand-300"
              >
                <Crown aria-hidden className="h-4 w-4" />
              </button>
            )}
            {owners.length > 1 && !owner.is_owner && (
              <button
                type="button"
                aria-label={
                  owner.is_self ? t("Leave room") : t("Remove {{name}}", { name: owner.name })
                }
                title={owner.is_self ? t("Leave room") : t("Remove")}
                onClick={() => void handleRemove(owner)}
                className="rounded-full px-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleAdd();
          }}
          placeholder={t("Username or email address")}
          aria-label={t("Add person")}
          className="!w-72"
          list={listId}
        />
        <datalist id={listId}>
          {suggestions.map((person) => (
            <option key={person.id} value={person.username}>
              {person.name}
            </option>
          ))}
        </datalist>
        <Button onClick={() => void handleAdd()}>{t("Add")}</Button>
      </div>
      {/* Quick re-add of people I already share a room with (#55). */}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {suggestions.slice(0, 6).map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => void addOwner(person.username)}
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-3 py-1 text-slate-600 transition-colors hover:border-brand-500 hover:text-brand-700 dark:border-slate-700 dark:text-slate-300 dark:hover:text-brand-300"
            >
              + {person.name}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-400">
        {t(
          "Suggestions only include people you have already added once by e-mail address; add new people via their e-mail.",
        )}
      </p>
      {error && <p className="text-red-600">{error}</p>}
      <p className="text-xs text-slate-400">
        {t(
          "Everyone listed here can fully edit and present the room and its question sets. The person must have signed in at least once.",
        )}
      </p>
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Room page: header with editable title/description, provenance, and a
 * question-set card grid with a sort dropdown (concept §5.1). */
export default function RoomPage() {
  const { t } = useTranslation();
  const { roomId } = useParams();
  const id = Number(roomId);
  const navigate = useNavigate();
  const easyMode = useEasyMode();
  const [room, setRoom] = useState<Room | null>(null);
  const [sets, setSets] = useState<QuestionSet[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  // #75: filter the room's sets by type (like the archive filter on the rooms list).
  const [typeFilter, setTypeFilter] = useState<"all" | SetType>("all");
  const [search, setSearch] = useState("");
  const [setsPage, setSetsPage] = useState(1);
  const [setsPageSize, setSetsPageSize] = useState(20);
  const [importError, setImportError] = useState("");
  const [ownersOpen, setOwnersOpen] = useState(false);
  const [newSet, setNewSet] = useState<SetSettings | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  // Room settings (title / description / features), behind the ⋮ menu (#2).
  const [settingsDraft, setSettingsDraft] = useState<RoomSettings | null>(null);
  const [settingsError, setSettingsError] = useState("");

  // #21: settings and new-set panels are mutually exclusive; switching away
  // from one with unsaved edits asks first. The triggers live in different
  // places (⋮ menu top-right, "+ New question set" mid-page), so scroll the
  // warning into view and focus it — otherwise it can appear off-screen.
  const [pendingSwitch, setPendingSwitch] = useState<"settings" | "newSet" | null>(null);
  // #75: which type the pending "new set" should be created as (chosen in the
  // menu before the dirty-guard may defer opening the form).
  const [pendingNewSetType, setPendingNewSetType] = useState<SetType>("live_poll");
  const pendingSwitchRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pendingSwitch) return;
    pendingSwitchRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    pendingSwitchRef.current?.focus();
  }, [pendingSwitch]);

  const reload = (term = search) =>
    Promise.all([api.getRoom(id), api.listQuestionSets(id, term)]).then(
      ([roomData, page]) => {
        setRoom(roomData);
        setSets(page.results);
      },
    );
  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), search ? 250 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, search]);

  function openSettings() {
    if (!room) return;
    setSettingsError("");
    setSettingsDraft({
      title: room.title,
      description: room.description,
      show_logo_in_presentation: room.show_logo_in_presentation,
      show_qr_in_presentation: room.show_qr_in_presentation,
      show_code_in_presentation: room.show_code_in_presentation,
      presentation_corner: room.presentation_corner,
      closing_info: room.closing_info,
    });
  }

  async function saveSettings() {
    if (!room || !settingsDraft) return;
    setSettingsError("");
    try {
      const updated = await api.updateRoom(id, settingsDraft);
      setRoom(updated);
      setSettingsDraft(null);
      setPendingSwitch(null);
    } catch (err) {
      setSettingsError(fieldError(err));
    }
  }

  const newSetDirty =
    newSet !== null &&
    JSON.stringify(newSet) !==
      JSON.stringify({ ...NEW_SET_DEFAULTS, type: newSet.type });
  const settingsDirty =
    settingsDraft !== null &&
    room !== null &&
    JSON.stringify(settingsDraft) !==
      JSON.stringify({
        title: room.title,
        description: room.description,
        show_logo_in_presentation: room.show_logo_in_presentation,
        show_qr_in_presentation: room.show_qr_in_presentation,
        show_code_in_presentation: room.show_code_in_presentation,
        presentation_corner: room.presentation_corner,
        closing_info: room.closing_info,
      });

  function requestOpenSettings() {
    if (pendingSwitch) return;
    if (newSetDirty) {
      setPendingSwitch("settings");
      return;
    }
    setNewSet(null);
    openSettings();
  }
  function requestOpenNewSet(type: SetType) {
    if (pendingSwitch) return;
    setPendingNewSetType(type);
    if (settingsDirty) {
      setPendingSwitch("newSet");
      return;
    }
    setSettingsDraft(null);
    setNewSet({ ...NEW_SET_DEFAULTS, type });
  }
  function performSwitch() {
    if (pendingSwitch === "settings") {
      setNewSet(null);
      openSettings();
    } else if (pendingSwitch === "newSet") {
      setSettingsDraft(null);
      setNewSet({ ...NEW_SET_DEFAULTS, type: pendingNewSetType });
    }
    setPendingSwitch(null);
  }

  async function handleImportFile(file: File) {
    setImportError("");
    try {
      const data = JSON.parse(await file.text());
      await api.importQuestionSet(id, data);
      await reload();
    } catch (error) {
      setImportError(t("Import failed: {{error}}", { error: String(error) }));
    }
  }

  const sorted = useMemo(() => (sets ? sortSets(sets, sortKey) : null), [sets, sortKey]);

  async function toggleArchive() {
    if (!room) return;
    const updated = await api.toggleRoomArchive(id, !room.is_archived);
    setRoom(updated);
    // Archiving takes the room out of the overview — jump back there.
    if (updated.is_archived) navigate("/");
  }

  async function handleCreate() {
    if (!newSet) return;
    // A blank title is fine — the backend fills a dated default.
    const created = await api.createQuestionSet({ room: id, ...newSet });
    navigate(`/sets/${created.id}`);
  }

  async function handleDelete(setId: number) {
    await api.deleteQuestionSet(setId);
    setConfirmDelete(null);
    await reload();
  }

  async function handleArchive(setId: number) {
    await results.archive(setId);
    setConfirmArchive(null);
    await reload();
  }

  if (!room || !sorted) return null;

  const filtered =
    typeFilter === "all" ? sorted : sorted.filter((set) => set.type === typeFilter);
  const setsTotalPages = Math.max(1, Math.ceil(filtered.length / setsPageSize));
  const setsCurrent = Math.min(setsPage, setsTotalPages);
  const pagedSets = filtered.slice(
    (setsCurrent - 1) * setsPageSize,
    setsCurrent * setsPageSize,
  );

  return (
    <div>
      <nav className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        <HomeCrumb /> / {localizedText(room.title)}
      </nav>

      {/* Stack on mobile so the (often long) room title gets the full width
          instead of colliding with the favorite/actions (#81); side-by-side
          from sm up. */}
      <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1.5 text-2xl font-bold">
            {localizedText(room.title)}
            {room.is_lti && (
              <span
                title={t("Created from an LMS via LTI")}
                className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              >
                {t("From LMS")}
              </span>
            )}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
            <span
              title={t("Room code")}
              className="inline-flex max-w-full items-center gap-1.5 break-words rounded-lg bg-brand-50 px-2.5 py-1 font-mono text-base font-semibold tracking-tight text-brand-700 dark:bg-brand-950/50 dark:text-brand-300"
            >
              <DoorOpen aria-hidden className="h-4 w-4 shrink-0 opacity-70" />
              {room.code}
            </span>
            <span>{t("— stays the same across all sessions.")}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
          <button
            type="button"
            aria-pressed={room.is_favorite}
            onClick={() =>
              void api
                .toggleRoomFavorite(id, !room.is_favorite)
                .then(setRoom)
            }
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
              room.is_favorite
                ? "border-brand-200 text-brand-700 hover:bg-brand-50 dark:border-brand-900 dark:text-brand-300 dark:hover:bg-brand-950/40"
                : "border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900/60"
            }`}
          >
            <Heart
              aria-hidden
              fill={room.is_favorite ? "currentColor" : "none"}
              className="h-4 w-4"
            />
            {room.is_favorite ? t("Favorite") : t("Mark as favorite")}
          </button>
          <MoreMenu label={t("Room actions")}>
            <MenuItem onClick={requestOpenSettings}>
              <Settings aria-hidden className="h-4 w-4" />{t("Settings")}
            </MenuItem>
            {/* Easy mode (#52): hide collaboration + JSON import. */}
            {!easyMode && (
              <MenuItem onClick={() => setOwnersOpen((v) => !v)}>
                <Users aria-hidden className="h-4 w-4" />{t("Collaborative editing")}
              </MenuItem>
            )}
            <MenuItem onClick={() => void toggleArchive()}>
              <Archive aria-hidden className="h-4 w-4" />
              {room.is_archived ? t("Restore room") : t("Archive room")}
            </MenuItem>
            {!easyMode && (
              <MenuItem onClick={() => importInput.current?.click()}>
                <Upload aria-hidden className="h-4 w-4" />{t("Import question set (JSON)")}
              </MenuItem>
            )}
          </MoreMenu>
        </div>
        <input
          ref={importInput}
          type="file"
          accept="application/json,.json"
          aria-label={t("Import question set (JSON)")}
          tabIndex={-1}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleImportFile(file);
            event.target.value = "";
          }}
        />
      </div>

      {/* Description (read-only; edit via ⋮ → Einstellungen, #2). Rendered as
          rich HTML from the WYSIWYG editor (#49). Nothing shown when empty —
          the "No description" placeholder was just noise (#78). */}
      {localizedText(room.description) && (
        <div className="mb-4 max-w-2xl text-sm">
          <RichText html={localizedText(room.description)} />
        </div>
      )}

      {/* Created/changed metadata: kept in Pro mode (useful when several
          people co-edit a room), hidden in the decluttered Simple mode (#78). */}
      {!easyMode && (
        <p className="mb-3 text-xs text-slate-400">
          {room.created_by_name
            ? t("Created on {{date}} by {{name}}", {
                date: formatDateTime(room.created_at),
                name: room.created_by_name,
              })
            : t("Created on {{date}}", { date: formatDateTime(room.created_at) })}
          {" · "}
          {room.updated_by_name
            ? t("Last changed on {{date}} by {{name}}", {
                date: formatDateTime(room.updated_at),
                name: room.updated_by_name,
              })
            : t("Last changed on {{date}}", { date: formatDateTime(room.updated_at) })}
        </p>
      )}

      {pendingSwitch && (
        <div
          ref={pendingSwitchRef}
          role="alert"
          tabIndex={-1}
          className="mb-4 max-w-2xl scroll-mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 outline-none dark:border-amber-900 dark:bg-amber-950/40"
        >
          <ConfirmInline
            message={t("Discard unsaved changes?")}
            confirmLabel={t("Discard")}
            confirmVariant="danger"
            onConfirm={performSwitch}
            onCancel={() => setPendingSwitch(null)}
          />
        </div>
      )}

      {/* Room settings (#2): title / description / features. */}
      {settingsDraft && (
        <div className="mb-6 max-w-2xl rounded-2xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-900 dark:bg-brand-950/40">
          <h2 className="mb-3 font-semibold">{t("Room settings")}</h2>
          <RoomSettingsForm
            draft={settingsDraft}
            onChange={(patch) => setSettingsDraft({ ...settingsDraft, ...patch })}
            easyMode={easyMode}
          />
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void saveSettings()}>
              {t("Save")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setSettingsDraft(null);
                setPendingSwitch(null);
              }}
            >
              {t("Cancel")}
            </Button>
          </div>
          {settingsError && (
            <p className="mt-1 text-sm text-red-600">{settingsError}</p>
          )}
        </div>
      )}

      {ownersOpen && <OwnersPanel roomId={id} />}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="relative w-64 max-w-full">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          />
          <TextInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("Search (also in questions/answers)…")}
            aria-label={t("Search question sets")}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <InfoHint
            text={t("A question set is a single quiz — e.g. for one lecture session.")}
          />
          <div data-tour="room.new-set">
            <NewSetMenu easyMode={easyMode} onPick={requestOpenNewSet} />
          </div>
        </div>
      </div>
      {importError && <p className="mb-4 text-sm text-red-600">{importError}</p>}

      {newSet && (
        <div className="mb-6 max-w-2xl rounded-2xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-900 dark:bg-brand-950/40">
          <h2 className="mb-3 font-semibold">{t("New question set")}</h2>
          <SetSettingsForm
            draft={newSet}
            onChange={(patch) => setNewSet({ ...newSet, ...patch })}
            titleAnchor="set.title"
            easyMode={easyMode}
          />
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void handleCreate()}>
              {t("Save")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setNewSet(null);
                setPendingSwitch(null);
              }}
            >
              {t("Cancel")}
            </Button>
          </div>
        </div>
      )}

      {confirmDelete !== null && (
        <ConfirmDialog
          message={t("Delete question set?")}
          onConfirm={() => void handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {confirmArchive !== null && (
        <ConfirmDialog
          message={t("Archive results? The next presentation starts fresh.")}
          confirmLabel={t("Archive results")}
          confirmVariant="primary"
          onConfirm={() => void handleArchive(confirmArchive)}
          onCancel={() => setConfirmArchive(null)}
        />
      )}

      {sorted.length === 0 && search ? (
        <EmptyState icon={SearchX} title={t("No results")}>
          {t("No question set matches “{{query}}”.", { query: search })}
        </EmptyState>
      ) : sorted.length === 0 ? (
        <EmptyState icon={Layers} title={t("No question sets yet")}>
          {t("A question set is a single quiz — e.g. for one lecture session.")}
        </EmptyState>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 className="font-semibold">{t("Question sets")}</h2>
            <label className="flex min-w-0 max-w-full items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <span className="shrink-0">{t("Sort by:")}</span>
              <select
                value={sortKey}
                onChange={(event) => {
                  setSortKey(event.target.value as SortKey);
                  setSetsPage(1);
                }}
                className="min-w-0 max-w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 focus:border-brand-600 focus:outline-none dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.label)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {/* #75: filter the sets by type — same control as the rooms-list
              archive filter. */}
          {/* Phones (#179): the labels don't all fit — they are cut with
              an ellipsis (SegmentedControl) rather than scrolled. */}
          <SegmentedControl
            className="mb-4 sm:w-max"
            ariaLabel={t("Filter by set type")}
            value={typeFilter}
            onChange={(value) => {
              setTypeFilter(value);
              setSetsPage(1);
            }}
            options={[
              { value: "all", label: t("All types") },
              { value: "live_poll", label: t(SET_TYPES.live_poll.label) },
              { value: "self_paced", label: t(SET_TYPES.self_paced.label) },
              { value: "self_check", label: t(SET_TYPES.self_check.label) },
            ]}
          />
          {filtered.length === 0 && (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("No question set of this type.")}
            </p>
          )}
          <ul className="grid gap-3 sm:grid-cols-2">
            {pagedSets.map((set) => (
              <li
                key={set.id}
                className="relative min-w-0 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 hover:border-brand-600 dark:border-slate-800 dark:bg-slate-900/40"
              >
                <div className="flex items-start gap-3">
                  {(() => {
                    const Icon = SET_TYPES[set.type].icon;
                    return (
                      <span
                        role="img"
                        title={t(SET_TYPES[set.type].label)}
                        aria-label={t(SET_TYPES[set.type].label)}
                        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${SET_TYPES[set.type].accent.iconBox}`}
                      >
                        <Icon aria-hidden className="h-5 w-5" />
                      </span>
                    );
                  })()}
                  <Link
                    to={`/sets/${set.id}`}
                    className="min-w-0 flex-1 after:absolute after:inset-0 after:rounded-2xl"
                  >
                    <h3 className="truncate font-semibold text-slate-900 dark:text-slate-100">
                      {localizedText(set.title)}
                    </h3>
                    <p className="mt-1 text-xs font-medium text-slate-400 dark:text-slate-500">
                      {t(SET_TYPES[set.type].label)}
                    </p>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {set.question_count} {t("question", { count: set.question_count })}
                      {/* "Last edited" date is decluttered away in simple mode (#78). */}
                      {!easyMode && (
                        <>
                          {" · "}
                          {t("Last edited")} {formatDate(set.updated_at)}
                        </>
                      )}
                    </p>
                  </Link>
                </div>
                <div data-tour="room.set-actions" className="relative z-10 mt-3 flex items-center justify-end gap-1 border-t border-slate-100 pt-2 dark:border-slate-800">
                  {set.has_results && (
                    <Link
                      to={`/sets/${set.id}/results`}
                      aria-label={t("View results of {{title}}", { title: localizedText(set.title) })}
                      title={t("View results")}
                      className="inline-flex items-center rounded-lg px-2 py-1.5 text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-950"
                    >
                      <ChartColumnDecreasing aria-hidden className="h-4 w-4" />
                    </Link>
                  )}
                  {set.question_count > 0 && SET_TYPES[set.type].runAction !== "self_check" && (
                    <Link
                      to={`/sets/${set.id}/present`}
                      aria-label={t("Present {{title}}", { title: localizedText(set.title) })}
                      title={t("Present")}
                      className="inline-flex items-center rounded-lg px-2 py-1.5 text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-950"
                    >
                      <Play aria-hidden className="h-4 w-4" />
                    </Link>
                  )}
                  {/* Archive current results & prepare a fresh run (#27) —
                      only when there is something to archive. Easy mode
                      (#52) hides it; MR1's auto-archive replaces it. */}
                  {!easyMode && set.has_results && (
                    <Button
                      variant="ghost"
                      aria-label={t("Archive results of {{title}}", { title: localizedText(set.title) })}
                      title={t("Archive results")}
                      className="inline-flex items-center"
                      onClick={() => setConfirmArchive(set.id)}
                    >
                      <Archive aria-hidden className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    aria-label={t("Delete question set {{title}}", { title: localizedText(set.title) })}
                    title={t("Delete")}
                    className="inline-flex items-center"
                    onClick={() => setConfirmDelete(set.id)}
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {!search && (
        <Pager
          page={setsCurrent}
          pageSize={setsPageSize}
          count={filtered.length}
          onPage={setSetsPage}
          onPageSize={(size) => {
            setSetsPageSize(size);
            setSetsPage(1);
          }}
        />
      )}
    </div>
  );
}
