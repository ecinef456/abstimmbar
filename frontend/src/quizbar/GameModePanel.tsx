// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): the game-mode switch of a live poll (set page). */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Gamepad2 } from "lucide-react";
import { quizbar } from "../api";
import { ToggleSwitch } from "../components/ui";

export default function GameModePanel({ setId }: { setId: number }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    void quizbar.game(setId).then((data) => setEnabled(data.enabled), () => setEnabled(null));
  }, [setId]);
  if (enabled === null) return null;
  return (
    <section className="mb-8 flex max-w-2xl items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <Gamepad2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-slate-600 dark:text-slate-300" />
      <div className="grid gap-1">
        <ToggleSwitch
          checked={enabled}
          onChange={(on) => {
            setEnabled(on);
            void quizbar.setGame(setId, on).then((data) => setEnabled(data.enabled));
          }}
          label={t("Game mode")}
        />
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t(
            "Students play under a nickname. A correct answer earns 500–1000 points (faster = more); P shows the leaderboard, the end shows the podium. Your own sounds play if you added them (M mutes).",
          )}
        </p>
      </div>
    </section>
  );
}
