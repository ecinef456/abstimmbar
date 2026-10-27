// SPDX-License-Identifier: Apache-2.0
/** quizbar (fork): choose the sets a self-check copies its questions from.
 *  The backend keeps the copies up to date (single/multiple choice,
 *  ordering, free text), one section per source set. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { localizedText } from "@basicbar/ui";
import { quizbar, type SelfCheckSources } from "../api";
import { Button } from "../components/ui";

export default function SelfCheckSourcesPanel({
  setId,
  data,
  onChanged,
}: {
  setId: number;
  data: SelfCheckSources;
  /** Called with the new state after saving (the parent reloads questions). */
  onChanged: (next: SelfCheckSources) => void;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const sameFolder = data.candidates.filter((c) => data.folder !== null && c.folder === data.folder);
  const others = data.candidates.filter((c) => !sameFolder.includes(c));
  // In a folder: its sets, plus chosen ones from elsewhere; all on request.
  const listed =
    showAll || data.folder === null
      ? [...sameFolder, ...others]
      : [...sameFolder, ...others.filter((c) => data.sources.includes(c.id))];

  async function toggle(id: number, checked: boolean) {
    const chosen = new Set(data.sources);
    if (checked) chosen.add(id);
    else chosen.delete(id);
    // Keep the displayed order (folder order first).
    const order = [...sameFolder, ...others].map((c) => c.id).filter((c) => chosen.has(c));
    setSaving(true);
    try {
      onChanged(await quizbar.setSelfCheckSources(setId, order));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-8 max-w-2xl rounded-2xl border border-slate-200 bg-slate-50/50 p-4 dark:border-slate-800 dark:bg-slate-900/40">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
        <RefreshCw aria-hidden className="h-4 w-4" />
        {t("Fill automatically from")}
      </h2>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {t(
          "The questions of the chosen sets are copied here and kept up to date (single and multiple choice, ordering, free text). Edit them in their own set.",
        )}
      </p>
      {listed.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">{t("There are no other sets in this room.")}</p>
      ) : (
        <ul className="mt-3 grid gap-1.5">
          {listed.map((candidate) => (
            <li key={candidate.id}>
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  disabled={saving}
                  checked={data.sources.includes(candidate.id)}
                  onChange={(event) => void toggle(candidate.id, event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-700"
                />
                {localizedText(candidate.title)}
              </label>
            </li>
          ))}
        </ul>
      )}
      {data.folder !== null && others.length > 0 && !showAll && (
        <Button variant="ghost" className="mt-2" onClick={() => setShowAll(true)}>
          {t("Show all sets of this room")}
        </Button>
      )}
    </section>
  );
}
