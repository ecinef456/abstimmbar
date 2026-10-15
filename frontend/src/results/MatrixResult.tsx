// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Results view of a matrix question: the read-only board (descriptions on,
 *  hidden cards dimmed with a marker, legend toggles categories) with the
 *  grouped list below it. */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MatrixBoard, MatrixSettingsPayload } from "../api";
import Matrix from "./Matrix";
import MatrixList from "./MatrixList";
import MatrixRanking from "./MatrixRanking";

export default function MatrixResult({
  board,
  settings,
}: {
  board: MatrixBoard;
  settings: MatrixSettingsPayload;
}) {
  const { t } = useTranslation();
  const rating = board.rating;
  const shown = useMemo(
    () => (rating?.scores ? { mode: rating.mode, scores: rating.scores } : undefined),
    [rating],
  );
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div className="max-w-3xl">
      <Matrix
        board={board}
        settings={settings}
        mode="results"
        rating={shown}
        detailed
        hiddenCategories={hidden}
        onToggleCategory={toggle}
      />
      <MatrixList board={board} settings={settings} />
      {rating && (
        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-700">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">{t("Ranking")}</span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {rating.mode === "points"
                ? t("Points · rated by {{n}}", { n: rating.raters })
                : t("Plus/minus · rated by {{n}}", { n: rating.raters })}
            </span>
          </div>
          {rating.rating_in_progress ? (
            <p className="text-sm text-slate-500 dark:text-slate-400" data-testid="mx-rating-in-progress">
              {t("Rating still in progress — results appear once they are revealed.")}
            </p>
          ) : (
            <MatrixRanking entries={rating.ranking ?? []} mode={rating.mode} settings={settings} size="compact" />
          )}
        </div>
      )}
    </div>
  );
}
