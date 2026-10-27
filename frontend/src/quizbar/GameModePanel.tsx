// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): the game-mode switches of a live poll (set page). */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Gamepad2 } from "lucide-react";
import { quizbar, type GameOptions } from "../api";
import { ToggleSwitch } from "../components/ui";

export default function GameModePanel({ setId }: { setId: number }) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<GameOptions | null>(null);
  useEffect(() => {
    void quizbar.game(setId).then(setOptions, () => setOptions(null));
  }, [setId]);
  if (options === null) return null;

  function change(patch: Partial<GameOptions>) {
    setOptions((current) => (current ? { ...current, ...patch } : current));
    void quizbar.setGame(setId, patch).then(setOptions);
  }

  return (
    <section className="mb-8 flex max-w-2xl items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <Gamepad2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-slate-600 dark:text-slate-300" />
      <div className="grid gap-2">
        <ToggleSwitch checked={options.enabled} onChange={(enabled) => change({ enabled })} label={t("Game mode")} />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t(
            "Game mode: points for fast correct answers, leaderboard (P) and podium at the end. Your own sounds play if you added them (M mutes).",
          )}
        </p>
        {options.enabled && (
          <div className="grid gap-1.5 pt-1">
            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={options.nicknames}
                onChange={(event) => change({ nicknames: event.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600"
              />
              <span>
                {t("Students choose a nickname")}
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {t("Otherwise each phone gets a random funny name, like “Chaotic Capybara”.")}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={options.avatars}
                onChange={(event) => change({ avatars: event.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-600"
              />
              <span>
                {t("Students choose an avatar")}
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {t("Otherwise no avatars: the podium shows the medals only.")}
                </span>
              </span>
            </label>
          </div>
        )}
      </div>
    </section>
  );
}
