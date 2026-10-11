// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { Archive, ArchiveRestore, DoorOpen, Heart as HeartIcon, LogOut, Search, SearchX, Trash2, Users } from "lucide-react";
import { useApp, useEasyMode } from "../App";
import { api, type Room, type SearchResults } from "../api";
import { SET_TYPES, CREATABLE_SET_TYPES, type SetType } from "../setTypes";
import { localizedText, stripHtml } from "@basicbar/ui";
import JoinByCode from "../components/JoinByCode";
import { Pager } from "../components/Pager";
import { Button, ConfirmDialog, EmptyState, InfoHint, SegmentedControl, TextInput } from "../components/ui";
import { RoomSettingsForm, NEW_ROOM_DEFAULTS, type RoomSettings } from "./RoomPage";

type SortKey = "title" | "last_used" | "created";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "last_used", label: "Last used" },
  { value: "created", label: "Last created" },
  { value: "title", label: "A–Z" },
];

/** Plain-text preview of a rich-HTML field for the compact room card — the
 * description is authored as HTML (TipTap) and must not show raw tags here. */
function sortRooms(list: Room[], key: SortKey): Room[] {
  return [...list].sort((a, b) => {
    if (key === "title") {
      return localizedText(a.title).localeCompare(localizedText(b.title), "de");
    }
    if (key === "created") return b.created_at.localeCompare(a.created_at);
    // last_used: most recent run first, rooms never used go last.
    const av = a.last_used_at ?? "";
    const bv = b.last_used_at ?? "";
    if (av && bv) return bv.localeCompare(av);
    if (av !== bv) return av ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
}

function Heart({ filled }: { filled: boolean }) {
  return (
    <HeartIcon
      aria-hidden
      fill={filled ? "currentColor" : "none"}
      className="h-4 w-4"
    />
  );
}

// Count-aware, pluralized tooltip per set type (#75), e.g. "5 Live-Umfragen".
// English source strings are the i18next keys (with _one/_other plurals).
const SET_TYPE_COUNT_LABEL: Record<SetType, string> = {
  live_poll: "{{count}} live poll",
  self_paced: "{{count}} self-paced quiz",
  self_check: "{{count}} self-check",
};

/** Per-type set counts on a room card (#75): one colored icon badge per set
 *  type present, in the canonical order, each with a count-aware tooltip. The
 *  row sits above the card's full-card click overlay (`relative z-10`) so the
 *  native title tooltips are not swallowed by it; the badges stay inside the
 *  link, so a click still opens the room. An empty room says so quietly. */
function RoomSetTypeBreakdown({ room }: { room: Room }) {
  const { t } = useTranslation();
  const counts = room.set_type_counts;
  const present = CREATABLE_SET_TYPES.filter((type) => (counts?.[type] ?? 0) > 0);
  if (!present.length) {
    return (
      <p className="mt-1.5 text-sm text-slate-400">
        {t("No question sets yet")}
      </p>
    );
  }
  return (
    <div className="relative z-10 mt-1.5 flex flex-wrap items-center gap-1.5">
      {present.map((type) => {
        const info = SET_TYPES[type];
        const Icon = info.icon;
        const count = counts[type];
        const label = t(SET_TYPE_COUNT_LABEL[type], { count });
        return (
          <span
            key={type}
            title={label}
            aria-label={label}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${info.accent.badge}`}
          >
            <Icon aria-hidden className="h-3.5 w-3.5" />
            {count}
          </span>
        );
      })}
    </div>
  );
}

function RoomCard({
  room,
  onToggleFavorite,
  onArchive,
  onRestore,
  setConfirmDelete,
  setConfirmLeave,
}: {
  room: Room;
  onToggleFavorite: (room: Room) => void;
  onArchive: (room: Room) => void;
  onRestore: (room: Room) => void;
  setConfirmDelete: (id: number | null) => void;
  setConfirmLeave: (id: number | null) => void;
}) {
  const { t } = useTranslation();
  const sharedByMe = room.is_owner && room.owner_count > 1;
  const favoriteLabel = room.is_favorite
    ? t("Remove favorite")
    : t("Mark as favorite");
  // One square icon-button style for every card action (#29), so favorite,
  // archive/restore, leave and delete share size, padding and a focus ring.
  const iconBtn =
    "rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 dark:hover:bg-slate-800";
  const description = stripHtml(localizedText(room.description));
  return (
    <li className="relative min-w-0 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 hover:border-brand-600">
      {/* On mobile the actions drop to their own row so the title/content gets
          the full card width (#81); from sm they sit beside it as before. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-2">
        <Link
          to={`/rooms/${room.id}`}
          className="min-w-0 flex-1 after:absolute after:inset-0 after:rounded-2xl"
        >
          <h2 className="flex items-start gap-1.5 font-semibold text-slate-900 dark:text-slate-100">
            <span className="line-clamp-2">{localizedText(room.title)}</span>
            {sharedByMe && (
              <span
                title={t("Shared with {{count}} other people", {
                  count: room.owner_count - 1,
                })}
                className="inline-flex items-center text-brand-600 dark:text-brand-400"
              >
                <Users aria-label={t("shared")} className="h-4 w-4" />
              </span>
            )}
            {room.is_lti && (
              <span
                title={t("Created from an LMS via LTI")}
                className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              >
                {t("From LMS")}
              </span>
            )}
            {room.is_archived && (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                {t("Archived")}
              </span>
            )}
          </h2>
          <span
            title={t("Code")}
            className="mt-2 inline-flex max-w-full items-center gap-1.5 break-words rounded-lg bg-brand-50 px-2 py-1 font-mono text-sm font-semibold tracking-tight text-brand-700 dark:bg-brand-950/50 dark:text-brand-300"
          >
            <DoorOpen aria-hidden className="h-4 w-4 shrink-0 opacity-70" />
            {room.code}
          </span>
          <RoomSetTypeBreakdown room={room} />

          {!room.is_owner && room.owner_name && (
            <p className="mt-0.5 text-xs text-slate-400">
              {room.is_member
                ? t("shared by {{name}}", { name: room.owner_name })
                : t("Owner: {{name}}", { name: room.owner_name })}
            </p>
          )}
          {description && (
            <p className="mt-1 line-clamp-2 text-sm text-slate-400">
              {description}
            </p>
          )}
        </Link>
        <div className="relative z-10 flex shrink-0 items-center gap-1 self-end sm:self-auto">
          {/* A foreign admin room (visible only via the staff "show all"
           * toggle) is view-only: no favorite/archive/leave/delete. */}
          {(room.is_owner || room.is_member) && (
            <>
              <button
                type="button"
                aria-label={favoriteLabel}
                aria-pressed={room.is_favorite}
                title={favoriteLabel}
                onClick={() => onToggleFavorite(room)}
                className={`rounded-lg p-1.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${
                  room.is_favorite
                    ? "text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950/40"
                    : "text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
                }`}
              >
                <Heart filled={room.is_favorite} />
              </button>
              {room.is_archived ? (
                <button
                  type="button"
                  aria-label={t("Restore room {{title}}", { title: localizedText(room.title) })}
                  title={t("Restore")}
                  onClick={() => onRestore(room)}
                  className={iconBtn}
                >
                  <ArchiveRestore aria-hidden className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={t("Archive room")}
                  title={t("Archive room")}
                  onClick={() => onArchive(room)}
                  className={iconBtn}
                >
                  <Archive aria-hidden className="h-4 w-4" />
                </button>
              )}
            </>
          )}
          {/* A room shared with me can only be left, not deleted (#26). */}
          {!room.is_owner && room.is_member ? (
            <button
              type="button"
              aria-label={t("Leave room {{title}}", { title: localizedText(room.title) })}
              title={t("Leave this shared room")}
              onClick={() => setConfirmLeave(room.id)}
              className={iconBtn}
            >
              <LogOut aria-hidden className="h-4 w-4" />
            </button>
          ) : room.is_owner ? (
            <button
              type="button"
              aria-label={t("Delete room {{title}}", { title: localizedText(room.title) })}
              title={t("Delete room")}
              onClick={() => setConfirmDelete(room.id)}
              className={iconBtn}
            >
              <Trash2 aria-hidden className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** Room overview: favourites on top, the rest sortable + paged, plus create
 * and a keyword search across rooms, sets and questions. */
export default function RoomsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { whoami } = useApp();
  const isStaff = !!whoami?.is_staff;
  const easyMode = useEasyMode();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [newRoom, setNewRoom] = useState<RoomSettings | null>(null);
  const [createError, setCreateError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [confirmLeave, setConfirmLeave] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("last_used");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [showAll, setShowAll] = useState(false);
  const [roomFilter, setRoomFilter] = useState<"active" | "archived" | "all">("active");

  const reload = async () => {
    if (roomFilter === "archived") {
      setRooms((await api.listArchivedRooms()).results);
    } else if (roomFilter === "all") {
      const [act, arch] = await Promise.all([
        api.listRooms(showAll),
        api.listArchivedRooms(),
      ]);
      setRooms([...act.results, ...arch.results]);
    } else {
      setRooms((await api.listRooms(showAll)).results);
    }
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll, roomFilter]);

  const term = query.trim();
  useEffect(() => {
    if (term.length < 2) {
      setResults(null);
      return;
    }
    const handle = window.setTimeout(() => {
      void api.search(term).then(setResults);
    }, 250);
    return () => window.clearTimeout(handle);
  }, [term]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!newRoom) return;
    setCreateError("");
    try {
      // A blank title is fine — the backend fills a dated default.
      const created = await api.createRoom(newRoom);
      setNewRoom(null);
      navigate(`/rooms/${created.id}`);
    } catch (err) {
      try {
        const data = JSON.parse((err as Error).message);
        const value = data.detail ?? Object.values(data)[0];
        setCreateError(Array.isArray(value) ? value[0] : String(value));
      } catch {
        setCreateError(String(err));
      }
    }
  }

  async function handleDelete(id: number) {
    await api.deleteRoom(id);
    setConfirmDelete(null);
    await reload();
  }

  async function handleLeave(id: number) {
    await api.leaveRoom(id);
    setConfirmLeave(null);
    await reload();
  }

  async function toggleFavorite(room: Room) {
    const updated = await api.toggleRoomFavorite(room.id, !room.is_favorite);
    setRooms((current) =>
      (current ?? []).map((r) => (r.id === room.id ? updated : r)),
    );
  }

  async function archiveRoom(room: Room) {
    // Re-fetch so the room reflects its new archive state in the current filter.
    await api.toggleRoomArchive(room.id, true);
    void reload();
  }

  async function restoreRoom(room: Room) {
    await api.toggleRoomArchive(room.id, false);
    void reload();
  }

  if (!rooms) return null;

  const searching = term.length >= 2;
  const favorites = sortRooms(rooms.filter((r) => r.is_favorite), sortKey);
  // Rooms shared with me by someone else get their own category (#25); my own
  // rooms (incl. those I share with others) stay in the main, paged list.
  // Staff additionally see every other room (via ?all=1) in a third,
  // view-only category once "Show all rooms" is on.
  const mine = sortRooms(rooms.filter((r) => r.is_owner), sortKey);
  const sharedWithMe = sortRooms(
    rooms.filter((r) => !r.is_owner && r.is_member),
    sortKey,
  );
  const others = sortRooms(
    rooms.filter((r) => !r.is_owner && !r.is_member),
    sortKey,
  );
  const totalPages = Math.max(1, Math.ceil(mine.length / pageSize));
  const current = Math.min(page, totalPages);
  const pageMine = mine.slice((current - 1) * pageSize, current * pageSize);

  const cardProps = {
    onToggleFavorite: (r: Room) => void toggleFavorite(r),
    onArchive: (r: Room) => void archiveRoom(r),
    onRestore: (r: Room) => void restoreRoom(r),
    setConfirmDelete,
    setConfirmLeave,
  };

  return (
    <div>
      {confirmDelete !== null && (() => {
        const r = rooms.find((room) => room.id === confirmDelete);
        const sharedByMe = !!r && r.is_owner && r.owner_count > 1;
        return (
          <ConfirmDialog
            message={
              sharedByMe
                ? t("Delete room for all {{count}} people?", { count: r!.owner_count })
                : t("Delete room?")
            }
            confirmLabel={t("Delete")}
            onConfirm={() => handleDelete(confirmDelete)}
            onCancel={() => setConfirmDelete(null)}
          />
        );
      })()}
      {confirmLeave !== null && (
        <ConfirmDialog
          message={t("Leave this shared room?")}
          confirmLabel={t("Leave")}
          onConfirm={() => handleLeave(confirmLeave)}
          onCancel={() => setConfirmLeave(null)}
        />
      )}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("My rooms")}</h1>
        <JoinByCode compact />
      </div>

      {/* While the create form is open, hide the list controls (search + the
          Active/Archived/All filter) — they don't belong to the "new room"
          context and confusingly mention archived rooms (#72). */}
      {!newRoom && (
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 sm:max-w-xs">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <TextInput
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search rooms, sets, questions …")}
            aria-label={t("Search rooms, question sets and questions")}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          <InfoHint
            text={t(
              "A room is the permanent access point for participants — typically a course. Its code stays the same across all quizzes.",
            )}
          />
          <div data-tour="rooms.new-room">
            <Button
              variant="primary"
              onClick={() => {
                setCreateError("");
                setNewRoom(NEW_ROOM_DEFAULTS);
              }}
            >
              + {t("New room")}
            </Button>
          </div>
        </div>
      </div>
      )}

      {!newRoom && (
        <div data-tour="rooms.filter" className="mb-6 w-full sm:w-max">
          <SegmentedControl
            className="w-full"
            ariaLabel={t("Show rooms")}
            value={roomFilter}
            onChange={(v) => {
              setRoomFilter(v);
              setPage(1);
            }}
            options={[
              { value: "active", label: t("Active rooms") },
              { value: "archived", label: t("Archived rooms") },
              { value: "all", label: t("All rooms") },
            ]}
          />
        </div>
      )}

      {/* Single-step create dialog: name, description and features (#2). */}
      {newRoom && (
        <form
          onSubmit={handleCreate}
          className="mb-6 max-w-2xl rounded-2xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-900 dark:bg-brand-950/40"
        >
          <h2 className="mb-3 font-semibold">{t("New room")}</h2>
          <RoomSettingsForm
            draft={newRoom}
            onChange={(patch) => setNewRoom({ ...newRoom, ...patch })}
            titlePlaceholder={t("e.g. “Bio 101 lecture”")}
            titleAnchor="room.name"
            easyMode={easyMode}
          />
          <div className="mt-3 flex gap-2">
            <Button type="submit" variant="primary">
              {t("Create")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setNewRoom(null);
                setCreateError("");
              }}
            >
              {t("Cancel")}
            </Button>
          </div>
          {createError && <p className="mt-1 text-sm text-danger">{createError}</p>}
        </form>
      )}

      {searching ? (
        <SearchView results={results} query={term} />
      ) : (
        // Always-present tour anchor: wraps BOTH the empty state and the
        // populated list, so `rooms.list` exists even for zero-room users (the
        // onboarding audience). Layout-neutral — the parent is a plain block div.
        <div data-tour="rooms.list">
          {rooms.length === 0 ? (
        roomFilter === "archived" ? (
          <EmptyState icon={Archive} title={t("No archived rooms")}>
            {t(
              "Archived rooms disappear from “My rooms” and show up here instead. Use a room's ⋮ menu to archive it.",
            )}
          </EmptyState>
        ) : (
          <EmptyState icon={DoorOpen} title={t("No rooms yet")}>
            {t(
              "A room is the permanent access point for participants — typically a course. Its code stays the same across all quizzes.",
            )}
          </EmptyState>
        )
          ) : (
            <>
          {favorites.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-500 dark:text-slate-400">
                <span className="text-brand-600 dark:text-brand-400">
                  <Heart filled />
                </span>
                {t("Favorites")}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {favorites.map((room) => (
                  <RoomCard key={room.id} room={room} {...cardProps} />
                ))}
              </ul>
            </section>
          )}

          {/* Phones (#179): heading on its own row, filter + sort below it,
              so the staff checkbox doesn't read as "☐ My rooms". */}
          <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400">
              {t("My rooms")}
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {isStaff && (
                <label className="flex items-center gap-2 whitespace-nowrap text-sm text-slate-500 dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={showAll}
                    onChange={(event) => {
                      setShowAll(event.target.checked);
                      setPage(1);
                    }}
                    className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-700"
                  />
                  {t("Show all rooms in the system")}
                </label>
              )}
              <label className="flex min-w-0 max-w-full items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <span className="shrink-0">{t("Sort by:")}</span>
                <select
                  value={sortKey}
                  onChange={(event) => {
                    setSortKey(event.target.value as SortKey);
                    setPage(1);
                  }}
                  className="min-w-0 max-w-full rounded-md border border-field bg-white px-2 py-1 text-slate-700 focus:border-brand-600 focus:ring-1 focus:ring-brand-600 focus:outline-none dark:bg-slate-900 dark:text-slate-200"
                >
                  {SORT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          {mine.length === 0 ? (
            <p className="text-sm text-slate-400">{t("You don't own any rooms yet.")}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {pageMine.map((room) => (
                <RoomCard key={room.id} room={room} {...cardProps} />
              ))}
            </ul>
          )}
          <Pager
            page={current}
            pageSize={pageSize}
            count={mine.length}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />

          {/* Rooms shared with me by others (#25). */}
          {sharedWithMe.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-500 dark:text-slate-400">
                <Users aria-hidden className="h-4 w-4" />
                {t("Shared with me")}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {sharedWithMe.map((room) => (
                  <RoomCard key={room.id} room={room} {...cardProps} />
                ))}
              </ul>
            </section>
          )}

          {/* Staff-only: every other room, visible via "Show all rooms in the
              system". */}
          {showAll && others.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-500 dark:text-slate-400">
                <Users aria-hidden className="h-4 w-4" />
                {t("All rooms in the system")}
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                  {t("Admin")}
                </span>
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {others.map((room) => (
                  <RoomCard key={room.id} room={room} {...cardProps} />
                ))}
              </ul>
            </section>
          )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Grouped search results (rooms, sets, questions). Each row links to the
 * relevant page; questions open their set's editor. */
function SearchView({
  results,
  query,
}: {
  results: SearchResults | null;
  query: string;
}) {
  const { t } = useTranslation();
  if (!results) return <p className="text-sm text-slate-400">{t("Searching …")}</p>;

  const empty =
    results.rooms.length === 0 &&
    results.sets.length === 0 &&
    results.questions.length === 0;
  if (empty) {
    return (
      <EmptyState icon={SearchX} title={t("No results")}>
        {t(
          "Nothing found in your rooms, question sets or questions for “{{query}}”.",
          { query },
        )}
      </EmptyState>
    );
  }

  const rowClass =
    "block rounded-xl border border-slate-200 dark:border-slate-800 px-4 py-2.5 hover:border-brand-600";
  const crumb = "text-xs text-slate-500 dark:text-slate-400";

  return (
    <div className="space-y-6">
      {results.rooms.length > 0 && (
        <Group title={t("Rooms")} count={results.rooms.length}>
          {results.rooms.map((room) => (
            <Link key={room.id} to={`/rooms/${room.id}`} className={rowClass}>
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {room.title}
              </span>
              <span className={`ml-2 font-mono ${crumb}`}>{room.code}</span>
            </Link>
          ))}
        </Group>
      )}

      {results.sets.length > 0 && (
        <Group title={t("Question sets")} count={results.sets.length}>
          {results.sets.map((set) => (
            <Link key={set.id} to={`/sets/${set.id}`} className={rowClass}>
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {set.title}
              </span>
              <span className={`ml-2 ${crumb}`}>
                {t("in {{room}}", { room: set.room_title })}
              </span>
            </Link>
          ))}
        </Group>
      )}

      {results.questions.length > 0 && (
        <Group title={t("Questions")} count={results.questions.length}>
          {results.questions.map((question) => (
            <Link
              key={question.id}
              to={`/sets/${question.question_set}`}
              className={rowClass}
            >
              <span className="text-slate-900 dark:text-slate-100">
                {question.text}
              </span>
              <span className={`mt-0.5 block ${crumb}`}>
                {question.set_title} · {question.room_title}
              </span>
            </Link>
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-slate-500 dark:text-slate-400">
        {title} <span className="font-normal">({count})</span>
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
