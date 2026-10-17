// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Universität Osnabrück (virtUOS)

/** Compact list below the results board: the cards grouped by field (zone
 *  named like the participant page, x part first) with category, title,
 *  description, stack info and the hidden flag. Also the text alternative of
 *  the board. */
import { useTranslation } from "react-i18next";
import type { MatrixBoard, MatrixSettingsPayload } from "../api";
import { categoryLabel } from "../matrixPalette";
import { MatrixSummaryMark, matrixStacks, matrixZoneName, stackCount } from "./Matrix";
import { ZONES } from "./matrixGeometry";

export default function MatrixList({
  board,
  settings,
}: {
  board: MatrixBoard;
  settings: MatrixSettingsPayload;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("de") ? "de" : "en";
  const stacks = matrixStacks(board.cards);
  const byId = new Map(board.cards.map((c) => [c.id, c]));
  const zones = ZONES.filter((z) => stacks.some((s) => s.card.zone === z));
  if (!zones.length) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">{t("No cards yet.")}</p>;
  }
  const categoryText = (key: string) => {
    if (settings.category_mode === "off") return "";
    if (!settings.categories.some((c) => c.key === key)) return t("no category");
    const label = categoryLabel(settings.categories, key, settings.category_mode, lang, t);
    return label.name ? label.name : label.a11y;
  };
  return (
    <div className="mt-3 space-y-3" data-testid="matrix-list">
      {zones.map((zone) => (
        <section key={zone}>
          <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            {matrixZoneName(zone, settings.axes, t)}
          </h4>
          <ul className="mt-1 space-y-1">
            {stacks
              .filter((s) => s.card.zone === zone)
              .flatMap((s) => [s.card, ...s.members].map((c) => ({ c, stack: s })))
              .map(({ c, stack }) => {
                const category = categoryText(c.category);
                const top = c.stack != null ? byId.get(c.stack) : undefined;
                return (
                  <li key={c.id} className="text-sm text-slate-800 dark:text-slate-100" data-card-id={c.id}>
                    {category && (
                      <span className="mr-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {category}
                      </span>
                    )}
                    {c.summary && <MatrixSummaryMark dark className="mr-1.5 inline-flex text-xs" />}
                    <span className="font-medium [overflow-wrap:anywhere]">{c.title}</span>
                    {c.description && (
                      <span className="text-slate-600 dark:text-slate-300"> – {c.description}</span>
                    )}
                    {top && (
                      <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                        {t("stacked on “{{title}}”", { title: top.title })}
                      </span>
                    )}
                    {!top && stack.members.length > 0 && (
                      <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                        {t("stack of {{n}}", { n: stackCount(stack) })}
                      </span>
                    )}
                    {c.teacher && (
                      <span className="ml-1.5 text-xs text-slate-500 dark:text-slate-400">{t("teacher card")}</span>
                    )}
                    {(c.hidden || top?.hidden) && (
                      <span className="ml-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
                        ({t("hidden")})
                      </span>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}
