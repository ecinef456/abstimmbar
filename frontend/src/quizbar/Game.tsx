// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): game mode on the beamer (Kahoot style).
 *
 *  GameLobby          — the nicknames that joined, under the QR code.
 *  LeaderboardOverlay — top 5 with this question's points (key P).
 *  Podium             — the closing slide: 3rd, 2nd, then 1st.
 *  useGameSounds      — the teacher's own sound files (M mutes), see
 *                       frontend/public/quizbar/sounds/README.md. */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trophy, Volume2, VolumeX } from "lucide-react";
import { API_BASE_URL, quizbar, type GameLeaderboard, type GamePlayer } from "../api";

/** An avatar picture (served by Django under /static/quizbar/avatars/). */
export function Avatar({
  src,
  className = "",
  round = true,
}: {
  src?: string | null;
  className?: string;
  round?: boolean;
}) {
  if (!src) return null;
  return (
    <img
      src={src.startsWith("/") ? `${API_BASE_URL}${src}` : src}
      alt=""
      aria-hidden
      className={`shrink-0 ${round ? "rounded-full" : "object-contain"} ${className}`}
    />
  );
}

const SOUND_BASE = "/quizbar/sounds/";
export type SoundName = "lobby" | "question" | "reveal" | "leaderboard" | "drumroll" | "podium";
const LOOPING: SoundName[] = ["lobby", "question", "drumroll"];
const MUTE_KEY = "quizbar.game.muted";

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Plays the teacher's sound files. Missing files simply stay silent. One
 *  background loop at a time (`loop`), plus one-shot effects (`play`). */
export function useGameSounds(enabled: boolean) {
  const audios = useRef(new Map<SoundName, HTMLAudioElement>());
  const current = useRef<SoundName | null>(null);
  const [muted, setMutedState] = useState(readMuted);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  function audio(name: SoundName) {
    let element = audios.current.get(name);
    if (!element) {
      element = new Audio(`${SOUND_BASE}${name}.mp3`);
      element.preload = "auto";
      element.loop = LOOPING.includes(name);
      audios.current.set(name, element);
    }
    return element;
  }
  function stop(name: SoundName | null) {
    if (!name) return;
    const element = audios.current.get(name);
    if (element) {
      element.pause();
      element.currentTime = 0;
    }
  }
  function start(name: SoundName) {
    if (mutedRef.current || !enabled) return;
    const element = audio(name);
    element.currentTime = 0;
    // Missing file, or autoplay not yet allowed: stay silent.
    void element.play().catch(() => {});
  }

  useEffect(
    () => () => {
      for (const element of audios.current.values()) element.pause();
    },
    [],
  );
  useEffect(() => {
    if (!enabled) {
      stop(current.current);
      current.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return {
    muted,
    toggleMute() {
      const next = !mutedRef.current;
      setMutedState(next);
      mutedRef.current = next;
      try {
        window.localStorage.setItem(MUTE_KEY, next ? "1" : "0");
      } catch {
        // not remembered
      }
      if (next) for (const element of audios.current.values()) element.pause();
      else if (current.current) start(current.current);
    },
    /** The background loop (or none). Restarting the same loop is a no-op. */
    loop(name: SoundName | null) {
      if (current.current === name) return;
      stop(current.current);
      current.current = name;
      if (name) start(name);
    },
    play(name: SoundName) {
      start(name);
    },
  };
}

export function MuteBadge({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      title={muted ? t("Sound off (M)") : t("Sound on (M)")}
      aria-label={muted ? t("Sound off (M)") : t("Sound on (M)")}
      className="fixed bottom-20 right-6 z-30 rounded-full border border-slate-200 bg-white/90 p-2 text-slate-500 shadow-sm hover:text-slate-800"
    >
      {muted ? <VolumeX aria-hidden className="h-5 w-5" /> : <Volume2 aria-hidden className="h-5 w-5" />}
    </button>
  );
}

export function GameLobby({ players }: { players: GamePlayer[] }) {
  const { t } = useTranslation();
  return (
    <div className="w-full max-w-5xl">
      <p className="mb-3 text-xl font-semibold text-slate-700">
        {t("{{count}} players", { count: players.length })}
      </p>
      <div className="flex max-h-[30vh] flex-wrap justify-center gap-2 overflow-hidden">
        {players.map((player) => (
          <span
            key={player.nickname}
            className="ab-fade-in inline-flex items-center gap-2 rounded-full bg-brand-50 py-1 pl-1 pr-4 text-lg font-semibold text-brand-800"
          >
            <Avatar src={player.avatar_icon} className="h-9 w-9" />
            {player.nickname}
          </span>
        ))}
      </div>
    </div>
  );
}

function useLeaderboard(runId: number | null | undefined, final = false) {
  const [data, setData] = useState<GameLeaderboard | null>(null);
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    void quizbar.leaderboard(runId, final).then((d) => alive && setData(d), () => {});
    return () => {
      alive = false;
    };
  }, [runId, final]);
  return data;
}

export function LeaderboardOverlay({ runId, onClose }: { runId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const data = useLeaderboard(runId);
  const top = data?.leaderboard.slice(0, 5) ?? [];
  const best = Math.max(1, ...top.map((row) => row.score));
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/70 p-10"
      role="dialog"
      aria-label={t("Leaderboard")}
      onClick={onClose}
    >
      <div className="ab-fade-in w-full max-w-4xl rounded-3xl bg-white p-10 shadow-2xl">
        <h2 className="mb-8 flex items-center justify-center gap-3 text-5xl font-extrabold text-slate-900">
          <Trophy aria-hidden className="h-12 w-12 text-amber-500" />
          {t("Leaderboard")}
        </h2>
        {data === null ? (
          <p className="text-center text-2xl text-slate-400">{t("Loading …")}</p>
        ) : top.length === 0 ? (
          <p className="text-center text-2xl text-slate-500">{t("No players yet.")}</p>
        ) : (
          <ol className="grid gap-4">
            {top.map((row) => (
              <li key={row.nickname} className="grid grid-cols-[3rem_1fr_auto] items-center gap-4">
                <span className="text-right text-3xl font-bold tabular-nums text-slate-400">{row.rank}</span>
                <div className="relative h-14 overflow-hidden rounded-2xl bg-slate-100">
                  <div
                    className="absolute inset-y-0 left-0 rounded-2xl bg-brand-400 transition-[width] duration-700"
                    style={{ width: `${Math.max(8, (row.score / best) * 100)}%` }}
                  />
                  <span className="relative flex h-full items-center gap-3 px-2 text-2xl font-bold text-slate-900">
                    <Avatar src={row.avatar_icon} className="h-11 w-11" />
                    {row.nickname}
                  </span>
                </div>
                <span className="min-w-[9rem] text-right text-3xl font-extrabold tabular-nums text-slate-900">
                  {row.score.toLocaleString()}
                  {row.last ? (
                    <span className="block text-base font-semibold text-brand-700">+{row.last.toLocaleString()}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}
        {data && data.players > 5 && (
          <p className="mt-6 text-center text-lg text-slate-500">
            {t("{{count}} players", { count: data.players })}
          </p>
        )}
        <p className="mt-6 text-center text-sm text-slate-400">{t("P or click closes")}</p>
      </div>
    </div>
  );
}

const MEDAL = ["🥇", "🥈", "🥉"];
const STEP_HEIGHT = ["h-64", "h-48", "h-36"];

/** The closing slide of a game: 3rd, 2nd, then (after a drum roll) 1st. */
export function Podium({
  runId,
  sounds,
}: {
  runId: number;
  sounds: ReturnType<typeof useGameSounds>;
}) {
  const { t } = useTranslation();
  const data = useLeaderboard(runId, true);
  // 0: nothing, 1: third, 2: second, 3: first.
  const [stage, setStage] = useState(0);
  const soundsRef = useRef(sounds);
  soundsRef.current = sounds;

  useEffect(() => {
    if (!data) return;
    const timers = [
      window.setTimeout(() => setStage(1), 900),
      window.setTimeout(() => setStage(2), 2900),
      window.setTimeout(() => soundsRef.current.loop("drumroll"), 3600),
      window.setTimeout(() => {
        soundsRef.current.loop(null);
        soundsRef.current.play("podium");
        setStage(3);
      }, 6600),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [data]);

  if (!data) return <p className="text-2xl text-slate-400">{t("Loading …")}</p>;
  const rows = data.leaderboard;
  if (!rows.length) return <h1 className="text-5xl font-bold">{t("Thanks for playing!")}</h1>;
  // Podium order on screen: 2nd, 1st, 3rd.
  const places = [1, 0, 2].filter((i) => i < rows.length);
  const shownFrom = (place: number) => (place === 2 ? 1 : place === 1 ? 2 : 3);
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-5xl font-extrabold text-slate-900">{t("Podium")}</h1>
      <div className="flex items-end justify-center gap-6">
        {places.map((place) => {
          const row = rows[place];
          const visible = stage >= shownFrom(place);
          return (
            <div key={place} className="flex w-60 flex-col items-center">
              <div
                className={`mb-3 text-center transition-all duration-700 ${
                  visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
                }`}
              >
                <div className="relative mx-auto w-fit">
                  {/* Full body if there is a picture for it, else the head; no
                      avatar (switched off): just the medal. */}
                  {row.avatar_full ? (
                    <Avatar src={row.avatar_full} round={false} className="h-56 w-auto" />
                  ) : row.avatar_icon ? (
                    <Avatar src={row.avatar_icon} className="h-28 w-28 shadow-lg" />
                  ) : null}
                  <span
                    className={row.avatar_icon ? "absolute -bottom-2 -right-3 text-5xl" : "text-6xl"}
                    aria-hidden
                  >
                    {MEDAL[place]}
                  </span>
                </div>
                <div className="mt-2 max-w-[15rem] break-words text-2xl font-extrabold leading-tight text-slate-900">{row.nickname}</div>
                <div className="text-xl font-semibold tabular-nums text-slate-500">
                  {t("{{points}} points", { points: row.score.toLocaleString() })}
                </div>
              </div>
              <div
                className={`flex w-full items-start justify-center rounded-t-2xl pt-4 text-6xl font-black text-white ${
                  STEP_HEIGHT[place]
                } ${place === 0 ? "bg-amber-400" : place === 1 ? "bg-slate-400" : "bg-orange-400"}`}
              >
                {place + 1}
              </div>
            </div>
          );
        })}
      </div>
      {stage >= 3 && rows.length > 3 && (
        <ul className="ab-fade-in grid grid-cols-2 gap-x-10 gap-y-1 text-lg text-slate-600">
          {rows.slice(3, 9).map((row) => (
            <li key={row.nickname} className="tabular-nums">
              {row.rank}. {row.nickname} — {row.score.toLocaleString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
